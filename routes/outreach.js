/**
 * My Outreach — the API.
 *
 * The unit here is the OPPORTUNITY, not the lead. A lead is a name; an
 * opportunity is a thing you are trying to close, and it carries the service,
 * the plan, the price, the pitch, the meetings, the proposal versions and the
 * reason it died.
 *
 * An opportunity is always created from a claim that already exists — a person
 * claimed in All Leads or a company claimed in Fresh Leads. This module never
 * claims, releases or expires anything itself; lib/lifecycle.js still owns all
 * of that, and the countdown a salesperson sees here is the same countdown
 * they see on the claim. Two systems inventing their own deadlines would be a
 * bug we would spend a month finding.
 */
const express = require("express");

const db = require("../db");
const { requireAuth, requireAdmin } = require("../lib/auth");
const pricing = require("../lib/pricing");
const ai = require("../lib/outreachAI");

const router = express.Router();
router.use(requireAuth);

/* ── shared ───────────────────────────────────────────────────────────────── */

const STAGES = [
  "new", "contacted", "replied", "meeting", "proposal", "negotiation", "won", "lost",
];

/** The funnel in order, for drop-off maths. Won and lost are outcomes, not steps. */
const FUNNEL = ["new", "contacted", "replied", "meeting", "proposal", "negotiation", "won"];

/**
 * Item 12 — the closed list. "Lost" alone tells you nothing, so there is no
 * free-text-only path out of an opportunity: a reason from this list is
 * required, and the interview questions come after it.
 */
const LOSS_REASONS = [
  ["budget", "Budget"],
  ["existing_agency", "Already working with an agency"],
  ["no_requirement", "No current requirement"],
  ["timing", "Wrong timing"],
  ["competitor", "Competitor selected"],
  ["pricing", "Pricing"],
  ["proposal_rejected", "Proposal rejected"],
  ["internal_approval", "Internal approval issue"],
  ["unresponsive", "Contact unresponsive"],
  ["wrong_dm", "Wrong decision-maker"],
  ["service_mismatch", "Service mismatch"],
  ["postponed", "Campaign postponed"],
  ["not_interested", "Brand not interested"],
  ["unreachable", "Couldn't reach"],
  ["other", "Other"],
];

const OPP_SELECT = `
  SELECT o.*,
         u.display_name           AS owner_name,
         cc.name                  AS contact_name,
         cc.role                  AS contact_role,
         cc.email                 AS contact_email,
         cc.phone                 AS contact_phone,
         cc.phone2                AS contact_phone2,
         cc.linkedin              AS contact_linkedin,
         cc.deadline_at           AS contact_deadline,
         cc.closed_at             AS contact_closed,
         l.fresh_deadline_at      AS lead_deadline,
         c.industry, c.employees, c.revenue, c.website, c.domain,
         c.linkedin               AS company_linkedin
    FROM opportunities o
    LEFT JOIN users            u  ON u.id  = o.owner_id
    LEFT JOIN company_contacts cc ON cc.id = o.contact_id
    LEFT JOIN leads            l  ON l.id  = o.lead_id
    LEFT JOIN companies        c  ON lower(c.name) = lower(o.company)`;

/** The claim's own deadline, whichever kind of claim it is. */
function deadlineOf(o) {
  return o.contact_deadline || o.lead_deadline || null;
}

function countdown(o) {
  const at = deadlineOf(o);
  if (!at) return null;
  const ms = new Date(at).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return { label: "Claim expired", hours: 0, days: 0, overdue: true, urgent: true };
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(hours / 24);
  return {
    label: days >= 1 ? `${days}d left` : `${hours}h left`,
    hours,
    days,
    overdue: false,
    urgent: hours <= 48,
  };
}

async function loadOpp(id, user) {
  const opp = await db.one(`${OPP_SELECT} WHERE o.id = $1`, [id]);
  if (!opp) return null;
  // Everyone can read — the whole portal is built on leads being visible to
  // all — but only the owner and admins write. Enforced per-endpoint below.
  opp.countdown = countdown(opp);
  opp.can_edit = opp.owner_id === user.id || user.role === "admin";
  return opp;
}

function assertOwner(opp, user, res) {
  if (opp.owner_id === user.id || user.role === "admin") return true;
  res.status(403).json({ error: `${opp.owner_name || "Someone else"} owns this opportunity.` });
  return false;
}

/** The context object every AI call takes. Assembled once, in one place. */
async function contextFor(opp) {
  // The newest signal on this company is what makes the pitch specific rather
  // than generic. Matched on company name, not lead id, because a Fresh claim
  // and an All Leads claim on the same brand should read the same news.
  const signal = await db.one(
    `SELECT s.title, s.summary, s.signal_type, s.why_it_matters
       FROM signals s
      WHERE lower(s.company) = lower($1)
      ORDER BY s.published DESC NULLS LAST, s.created_at DESC
      LIMIT 1`,
    [opp.company]
  ).catch(() => null);

  return {
    company: opp.company,
    industry: opp.industry,
    employees: opp.employees,
    contact_name: opp.contact_name,
    contact_role: opp.contact_role,
    signal_title: signal && signal.title,
    signal_summary: signal && (signal.summary || signal.why_it_matters),
    signal_type: signal && signal.signal_type,
    service: opp.service_primary,
    plan_name: opp.plan_name,
    price: opp.quoted_price,
  };
}

/**
 * Every stage change goes through here so opportunity_stages is never missing
 * a hop. Item 13 depends on that history being complete — a funnel with gaps
 * reports the wrong bottleneck, which is worse than reporting none.
 */
async function moveStage(oppId, toStage, userId, q = null) {
  const run = q || ((text, params) => db.pool.query(text, params));
  const { rows } = await run("SELECT stage FROM opportunities WHERE id = $1", [oppId]);
  const from = rows[0] && rows[0].stage;
  if (from === toStage) return from;

  await run(
    `UPDATE opportunities
        SET stage = $2,
            won_at  = CASE WHEN $2 = 'won'  THEN now() ELSE won_at  END,
            lost_at = CASE WHEN $2 = 'lost' THEN now() ELSE lost_at END,
            updated_at = now()
      WHERE id = $1`,
    [oppId, toStage]
  );
  await run(
    `INSERT INTO opportunity_stages (opportunity_id, from_stage, to_stage, user_id)
     VALUES ($1, $2, $3, $4)`,
    [oppId, from || null, toStage, userId]
  );
  return from;
}

/**
 * Closing an opportunity has to stop the claim's clock too.
 *
 * Otherwise a deal you won in week one keeps counting down and then expires,
 * and the sweep hands a closed-won account back to the pool. The claim and the
 * opportunity are two records of one commitment; they end together.
 */
async function closeUnderlyingClaim(opp, outcome, q = null) {
  const run = q || ((text, params) => db.pool.query(text, params));

  if (opp.contact_id) {
    await run(
      `UPDATE company_contacts
          SET closed_at = now(), deadline_at = NULL, status = $2
        WHERE id = $1`,
      [opp.contact_id, outcome]
    );
  } else if (opp.lead_id) {
    // A Fresh claim and an All Leads claim are separate clocks on the same
    // lead row, so close the one this opportunity actually came from.
    if (opp.source === "all") {
      await run(`UPDATE leads SET closed_at = now(), deadline_at = NULL WHERE id = $1`, [opp.lead_id]);
    } else {
      await run(
        `UPDATE leads SET fresh_closed_at = now(), fresh_deadline_at = NULL WHERE id = $1`,
        [opp.lead_id]
      );
    }
  }
}

/* ── the Today screen (items 1 & 2) ───────────────────────────────────────── */

/**
 * "When I open My Outreach, I shouldn't see 200 leads. I should see: what do I
 * need to do today?"
 *
 * So this endpoint returns buckets, not a list. Each opportunity lands in
 * exactly one bucket, checked in priority order, because an opportunity that
 * is both overdue and has an unread reply is one job, not two.
 */
router.get("/today", async (req, res, next) => {
  try {
    const mine = await db.all(
      `${OPP_SELECT} WHERE o.owner_id = $1 AND o.stage NOT IN ('won','lost')
       ORDER BY o.updated_at DESC`,
      [req.user.id]
    );

    const dueFollowups = await db.all(
      `SELECT f.*, o.company, o.id AS opportunity_id
         FROM opportunity_followups f
         JOIN opportunities o ON o.id = f.opportunity_id
        WHERE o.owner_id = $1 AND f.status = 'due' AND f.due_at <= CURRENT_DATE
        ORDER BY f.due_at ASC`,
      [req.user.id]
    );

    const meetingsToday = await db.all(
      `SELECT m.*, o.company, o.id AS opportunity_id
         FROM opportunity_meetings m
         JOIN opportunities o ON o.id = m.opportunity_id
        WHERE o.owner_id = $1
          AND m.scheduled_at::date = CURRENT_DATE
        ORDER BY m.scheduled_at ASC`,
      [req.user.id]
    );

    const followupBy = new Map();
    for (const f of dueFollowups) if (!followupBy.has(f.opportunity_id)) followupBy.set(f.opportunity_id, f);
    const meetingBy = new Map();
    for (const m of meetingsToday) if (!meetingBy.has(m.opportunity_id)) meetingBy.set(m.opportunity_id, m);

    const buckets = { urgent: [], replied: [], meeting: [], followup: [], proposal: [], new: [] };

    for (const o of mine) {
      o.countdown = countdown(o);
      o.due_followup = followupBy.get(o.id) || null;
      o.meeting_today = meetingBy.get(o.id) || null;

      // Order matters. A claim about to expire outranks everything: lose it and
      // the rest of the list is moot.
      if (o.countdown && (o.countdown.overdue || o.countdown.urgent)) buckets.urgent.push(o);
      else if (o.meeting_today) buckets.meeting.push(o);
      else if (o.last_reply_at && (!o.last_contacted_at || o.last_reply_at > o.last_contacted_at))
        buckets.replied.push(o);
      else if (o.approval_status === "pending" || o.stage === "proposal") buckets.proposal.push(o);
      else if (o.due_followup) buckets.followup.push(o);
      else if (o.stage === "new") buckets.new.push(o);
    }

    res.json({
      buckets,
      counts: {
        urgent: buckets.urgent.length,
        followup: buckets.followup.length,
        new: buckets.new.length,
        replied: buckets.replied.length,
        meeting: buckets.meeting.length,
        proposal: buckets.proposal.length,
        open: mine.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Everything of mine, including closed — the pipeline list behind Today. */
router.get("/", async (req, res, next) => {
  try {
    const all = req.query.all === "1" && req.user.role === "admin";
    const rows = await db.all(
      `${OPP_SELECT} ${all ? "" : "WHERE o.owner_id = $1"}
       ORDER BY
         CASE o.stage WHEN 'won' THEN 2 WHEN 'lost' THEN 3 ELSE 1 END,
         o.updated_at DESC
       LIMIT 500`,
      all ? [] : [req.user.id]
    );
    for (const o of rows) o.countdown = countdown(o);
    res.json({ opportunities: rows, stages: STAGES });
  } catch (err) {
    next(err);
  }
});

/**
 * Open (or create) the opportunity behind a claim.
 *
 * Created lazily rather than at claim time: the claim flow already works and
 * threading opportunity creation into it would mean touching lifecycle.js,
 * contacts.js and leads.js for something that can just as well happen the
 * first time someone opens the workspace.
 */
router.post("/open", async (req, res, next) => {
  try {
    const contactId = req.body.contact_id ? Number(req.body.contact_id) : null;
    const leadId = req.body.lead_id ? Number(req.body.lead_id) : null;
    if (!contactId && !leadId) {
      return res.status(400).json({ error: "Need a contact or a lead to open an opportunity." });
    }

    const existing = await db.one(
      contactId
        ? `${OPP_SELECT} WHERE o.contact_id = $1`
        : `${OPP_SELECT} WHERE o.lead_id = $1`,
      [contactId || leadId]
    );
    if (existing) {
      existing.countdown = countdown(existing);
      existing.can_edit = existing.owner_id === req.user.id || req.user.role === "admin";
      return res.json({ opportunity: existing, created: false });
    }

    let company;
    let ownerId;
    let source = "all";

    if (contactId) {
      const c = await db.one(
        "SELECT company, owner_id, claim_source FROM company_contacts WHERE id = $1",
        [contactId]
      );
      if (!c) return res.status(404).json({ error: "That contact no longer exists." });
      company = c.company;
      ownerId = c.owner_id;
      source = c.claim_source === "fresh" ? "fresh" : "all";
    } else {
      const l = await db.one(
        `SELECT c.name AS company, l.fresh_owner_id, l.fresh_from_newspaper
           FROM leads l JOIN companies c ON c.id = l.company_id
          WHERE l.id = $1`,
        [leadId]
      );
      if (!l) return res.status(404).json({ error: "That lead no longer exists." });
      company = l.company;
      ownerId = l.fresh_owner_id;
      source = l.fresh_from_newspaper ? "newspaper" : "fresh";
    }

    if (!ownerId) {
      return res.status(400).json({ error: "Claim this first — an opportunity needs an owner." });
    }
    if (ownerId !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Someone else holds this claim." });
    }

    const created = await db.one(
      `INSERT INTO opportunities (contact_id, lead_id, company, owner_id, source, stage)
       VALUES ($1, $2, $3, $4, $5, 'new')
       RETURNING id`,
      [contactId, leadId, company, ownerId, source]
    );
    await db.run(
      `INSERT INTO opportunity_stages (opportunity_id, to_stage, user_id) VALUES ($1, 'new', $2)`,
      [created.id, req.user.id]
    );

    const opp = await loadOpp(created.id, req.user);
    res.json({ opportunity: opp, created: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Backfill: give every claim I already hold an opportunity.
 *
 * The tab calls this once on open. Without it, everything claimed before this
 * module existed would sit invisible in My Outreach — the portal has been in
 * use for weeks, and a new screen that starts empty looks broken rather than
 * new. Cheap and idempotent: the inserts are guarded by the same partial
 * uniques that stop a claim having two opportunities.
 */
router.post("/sync", async (req, res, next) => {
  try {
    const created = await db.one(
      `WITH ins_contacts AS (
         INSERT INTO opportunities (contact_id, company, owner_id, source, stage)
         SELECT cc.id, cc.company, cc.owner_id,
                CASE WHEN cc.claim_source = 'fresh' THEN 'fresh' ELSE 'all' END, 'new'
           FROM company_contacts cc
          WHERE cc.owner_id = $1
            AND cc.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.contact_id = cc.id)
         RETURNING id
       ), ins_leads AS (
         INSERT INTO opportunities (lead_id, company, owner_id, source, stage)
         SELECT l.id, c.name, l.fresh_owner_id,
                CASE WHEN l.fresh_from_newspaper THEN 'newspaper' ELSE 'fresh' END, 'new'
           FROM leads l
           JOIN companies c ON c.id = l.company_id
          WHERE l.fresh_owner_id = $1
            AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.lead_id = l.id)
         RETURNING id
       )
       SELECT (SELECT COUNT(*) FROM ins_contacts)::int
            + (SELECT COUNT(*) FROM ins_leads)::int AS n`,
      [req.user.id]
    );

    // Seed the stage history for anything just created, so the funnel report
    // counts them as having reached 'new' rather than starting life invisible.
    await db.run(
      `INSERT INTO opportunity_stages (opportunity_id, to_stage, user_id)
       SELECT o.id, 'new', $1 FROM opportunities o
        WHERE o.owner_id = $1
          AND NOT EXISTS (SELECT 1 FROM opportunity_stages s WHERE s.opportunity_id = o.id)`,
      [req.user.id]
    );

    res.json({ created: created.n });
  } catch (err) {
    next(err);
  }
});

/* ── item 3: the Opportunity Workspace ────────────────────────────────────── */

/** Everything the workspace renders, in one round trip. */
router.get("/:id", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });

    const [messages, followups, meetings, proposals, stages, loss, contacts] = await Promise.all([
      db.all(
        `SELECT m.*, u.display_name AS user_name
           FROM opportunity_messages m
           LEFT JOIN users u ON u.id = m.created_by
          WHERE m.opportunity_id = $1 ORDER BY m.created_at DESC LIMIT 100`,
        [opp.id]
      ),
      db.all(
        `SELECT * FROM opportunity_followups WHERE opportunity_id = $1 ORDER BY step`,
        [opp.id]
      ),
      db.all(
        `SELECT m.*, u.display_name AS user_name
           FROM opportunity_meetings m
           LEFT JOIN users u ON u.id = m.created_by
          WHERE m.opportunity_id = $1 ORDER BY m.scheduled_at DESC`,
        [opp.id]
      ),
      db.all(
        `SELECT p.*, u.display_name AS user_name
           FROM opportunity_proposals p
           LEFT JOIN users u ON u.id = p.created_by
          WHERE p.opportunity_id = $1 ORDER BY p.version DESC`,
        [opp.id]
      ),
      db.all(
        `SELECT s.*, u.display_name AS user_name
           FROM opportunity_stages s
           LEFT JOIN users u ON u.id = s.user_id
          WHERE s.opportunity_id = $1 ORDER BY s.created_at ASC`,
        [opp.id]
      ),
      db.one(`SELECT * FROM opportunity_loss WHERE opportunity_id = $1`, [opp.id]),
      // Item 3 wants the contact block. For a Fresh claim there is no single
      // contact, so send the company's people and let the UI pick.
      db.all(
        `SELECT id, name, role, email, phone, linkedin
           FROM company_contacts
          WHERE lower(company) = lower($1) AND deleted_at IS NULL
          ORDER BY is_primary DESC, name LIMIT 25`,
        [opp.company]
      ),
    ]);

    res.json({
      opportunity: opp,
      messages,
      followups,
      meetings,
      proposals,
      stages,
      loss: loss || null,
      contacts,
      timeline: buildTimeline({ opp, messages, meetings, proposals, stages }),
      loss_reasons: LOSS_REASONS,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Item 16 — the whole history in one column, newest last.
 *
 * Assembled at read time from the tables that already hold the facts rather
 * than written to an events table as things happen. One less thing to keep in
 * sync, and a backfilled proposal or a corrected meeting date shows up in the
 * timeline automatically instead of leaving it quietly wrong.
 */
function buildTimeline({ opp, messages, meetings, proposals, stages }) {
  const items = [];

  items.push({ at: opp.created_at, kind: "claim", text: "Opportunity claimed" });

  for (const s of stages) {
    if (!s.from_stage) continue;
    items.push({
      at: s.created_at,
      kind: "stage",
      text: `Moved to ${s.to_stage}`,
      who: s.user_name,
    });
  }
  for (const m of messages) {
    items.push({
      at: m.sent_at || m.created_at,
      kind: m.direction === "in" ? "reply" : m.channel,
      text:
        m.direction === "in"
          ? `Client replied${m.intent ? ` — ${m.intent}` : ""}`
          : `${m.channel === "email" ? "Email" : m.channel} sent${m.generated ? " (AI draft)" : ""}`,
      who: m.user_name,
    });
  }
  for (const m of meetings) {
    items.push({
      at: m.scheduled_at,
      kind: "meeting",
      text: m.outcome ? `Meeting — ${m.outcome.replace(/_/g, " ")}` : "Meeting scheduled",
      who: m.user_name,
    });
  }
  for (const p of proposals) {
    items.push({
      at: p.created_at,
      kind: "proposal",
      text: `Proposal V${p.version}${p.price ? ` — ₹${Number(p.price).toLocaleString("en-IN")}` : ""}`,
      who: p.user_name,
    });
  }

  return items
    .filter((i) => i.at)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
}

/* ── item 4: service recommendation ───────────────────────────────────────── */

router.post("/:id/recommend-service", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });
    if (!assertOwner(opp, req.user, res)) return;

    const rec = await ai.recommendService(await contextFor(opp));

    await db.run(
      `UPDATE opportunities
          SET service_primary = $2, service_secondary = $3, service_optional = $4,
              service_rationale = $5, service_source = $6,
              service_accepted = false, updated_at = now()
        WHERE id = $1`,
      [opp.id, rec.primary, rec.secondary, rec.optional, rec.why, rec.source]
    );

    res.json({ recommendation: rec });
  } catch (err) {
    next(err);
  }
});

/** [Accept Recommendation] or [Change Service] — both land here. */
router.post("/:id/service", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });
    if (!assertOwner(opp, req.user, res)) return;

    const primary = String(req.body.primary || "").trim();
    if (!primary) return res.status(400).json({ error: "Pick a service." });

    await db.run(
      `UPDATE opportunities
          SET service_primary = $2, service_secondary = $3, service_optional = $4,
              service_accepted = true,
              service_source = CASE WHEN $5 THEN service_source ELSE 'manual' END,
              updated_at = now()
        WHERE id = $1`,
      [
        opp.id,
        primary,
        req.body.secondary || null,
        req.body.optional || null,
        Boolean(req.body.accepted_ai),
      ]
    );

    res.json({ opportunity: await loadOpp(opp.id, req.user) });
  } catch (err) {
    next(err);
  }
});

/* ── items 5-7: plans, the custom builder, the guardrail ──────────────────── */

router.get("/meta/rate-card", async (req, res, next) => {
  try {
    const [card, model, rules] = await Promise.all([
      pricing.rateCard(),
      pricing.costModel(),
      pricing.guardrail(),
    ]);
    res.json({ rate_card: card, cost_model: model, guardrail: rules, services: ai.SERVICES });
  } catch (err) {
    next(err);
  }
});

/**
 * Live quote — called as the builder's fields change, so the salesperson sees
 * the margin move while they type rather than after they save. Writes nothing.
 */
router.post("/quote", async (req, res, next) => {
  try {
    res.json({
      quote: await pricing.priceQuote({
        service: req.body.service,
        tier: req.body.tier,
        planConfig: req.body.plan_config || {},
        price: req.body.price,
        budget: req.body.budget,
      }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Save the plan and the price.
 *
 * The guardrail is enforced HERE, not in the browser. A blocked quote still
 * saves — the salesperson has to be able to record what the client asked for —
 * but it saves with approval_status 'pending' and the opportunity cannot reach
 * 'won' until a manager clears it. Refusing the save outright would just push
 * people back into spreadsheets, which is the thing this portal exists to stop.
 */
router.post("/:id/plan", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });
    if (!assertOwner(opp, req.user, res)) return;

    const service = req.body.service || opp.service_primary;
    if (!service) return res.status(400).json({ error: "Choose a service before pricing it." });

    const quote = await pricing.priceQuote({
      service,
      tier: req.body.tier,
      planConfig: req.body.plan_config || {},
      price: req.body.price,
      budget: req.body.budget,
    });

    // Always back to 'pending' when the guardrail fires. An earlier approval
    // was for an earlier price; carrying it forward would let a salesperson
    // get one discount signed off and then keep cutting under cover of it.
    const needsApproval = quote.requires_approval;

    await db.run(
      `UPDATE opportunities
          SET service_primary = $2,
              plan_tier = $3, plan_name = $4, plan_config = $5,
              client_budget = $6, quoted_price = $7,
              vendor_cost = $8, internal_cost = $9,
              margin_amount = $10, margin_pct = $11,
              approval_status = CASE WHEN $12 THEN 'pending' ELSE NULL END,
              approval_reason = CASE WHEN $12 THEN $13 ELSE NULL END,
              updated_at = now()
        WHERE id = $1`,
      [
        opp.id,
        service,
        req.body.tier || "custom",
        quote.plan_name,
        JSON.stringify(req.body.plan_config || {}),
        req.body.budget || null,
        quote.revenue,
        quote.vendor_cost,
        quote.internal_cost,
        quote.margin_amount,
        quote.margin_pct,
        needsApproval,
        needsApproval ? quote.reasons.join(" ") : null,
      ]
    );

    res.json({ quote, opportunity: await loadOpp(opp.id, req.user) });
  } catch (err) {
    next(err);
  }
});

/* ── item 24: approval workflow ───────────────────────────────────────────── */

router.get("/meta/approvals", requireAdmin, async (req, res, next) => {
  try {
    const rows = await db.all(
      `${OPP_SELECT} WHERE o.approval_status = 'pending' ORDER BY o.updated_at DESC`
    );
    res.json({ approvals: rows });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/approval", requireAdmin, async (req, res, next) => {
  try {
    const decision = req.body.decision === "approve" ? "approved" : "rejected";
    await db.run(
      `UPDATE opportunities
          SET approval_status = $2, approval_note = $3,
              approved_by = $4, approval_at = now(), updated_at = now()
        WHERE id = $1`,
      [req.params.id, decision, req.body.note || null, req.user.id]
    );
    res.json({ opportunity: await loadOpp(req.params.id, req.user) });
  } catch (err) {
    next(err);
  }
});

/* ── items 8-9: the pitch generator and the composer ──────────────────────── */

router.post("/:id/pitch", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });
    if (!assertOwner(opp, req.user, res)) return;

    res.json({ pitch: await ai.generatePitch(await contextFor(opp)) });
  } catch (err) {
    next(err);
  }
});

/**
 * Item 9 — log what was sent.
 *
 * There is no Gmail integration yet, so the composer copies out and this
 * records the fact. Deliberately the same endpoint a real send would call, so
 * wiring Gmail later means adding a transport in front of it, not rebuilding
 * the log, the timeline and the follow-up scheduling that hang off it.
 */
router.post("/:id/sent", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });
    if (!assertOwner(opp, req.user, res)) return;

    const channel = req.body.channel || "email";
    const body = String(req.body.body || "").trim();
    if (!body) return res.status(400).json({ error: "Nothing to log — the message is empty." });

    await db.tx(async (q) => {
      await q(
        `INSERT INTO opportunity_messages
           (opportunity_id, direction, channel, subject, body, generated, sent_at, created_by)
         VALUES ($1, 'out', $2, $3, $4, $5, now(), $6)`,
        [opp.id, channel, req.body.subject || null, body, Boolean(req.body.generated), req.user.id]
      );
      await q(
        `UPDATE opportunities SET last_contacted_at = now(), updated_at = now() WHERE id = $1`,
        [opp.id]
      );
      if (opp.stage === "new") await moveStage(opp.id, "contacted", req.user.id, q);
    });

    // Item 18 — the sequence starts when the first message goes out.
    await scheduleFollowups(opp.id);

    res.json({ opportunity: await loadOpp(opp.id, req.user) });
  } catch (err) {
    next(err);
  }
});

/* ── items 11 & 17: logging a reply, and reading it ───────────────────────── */

router.post("/:id/reply", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });
    if (!assertOwner(opp, req.user, res)) return;

    const body = String(req.body.body || "").trim();
    if (!body) return res.status(400).json({ error: "Paste what they said." });

    const verdict = await ai.classifyReply(body, await contextFor(opp));

    await db.tx(async (q) => {
      await q(
        `INSERT INTO opportunity_messages
           (opportunity_id, direction, channel, body, sentiment, intent,
            ai_next_action, ai_source, created_by)
         VALUES ($1, 'in', $2, $3, $4, $5, $6, $7, $8)`,
        [
          opp.id,
          req.body.channel || "email",
          body,
          verdict.sentiment,
          verdict.intent,
          verdict.next_action,
          verdict.source,
          req.user.id,
        ]
      );

      await q(
        `UPDATE opportunities
            SET last_reply_at = now(), next_action = $2, updated_at = now()
          WHERE id = $1`,
        [opp.id, verdict.next_action]
      );

      // Item 18's hard rule: the client answered, so stop the drip. Nothing is
      // more corrosive to a live conversation than an automated "just
      // following up" landing the morning after a real reply.
      await q(
        `UPDATE opportunity_followups SET status = 'cancelled'
          WHERE opportunity_id = $1 AND status = 'due'`,
        [opp.id]
      );

      const order = STAGES.indexOf(opp.stage);
      const hinted = verdict.stage_hint && STAGES.indexOf(verdict.stage_hint);
      // Only ever move forward on a hint. A one-word "thanks" classified as
      // 'replied' should not drag an opportunity back out of negotiation.
      if (verdict.stage_hint === "lost") {
        // Not automatic — losing needs the interview, so just flag the action.
      } else if (hinted > order) {
        await moveStage(opp.id, verdict.stage_hint, req.user.id, q);
      } else if (opp.stage === "new" || opp.stage === "contacted") {
        await moveStage(opp.id, "replied", req.user.id, q);
      }
    });

    res.json({ classification: verdict, opportunity: await loadOpp(opp.id, req.user) });
  } catch (err) {
    next(err);
  }
});

/* ── items 18-19: the follow-up engine ────────────────────────────────────── */

/** Lay down the whole sequence at once, dated from now. Idempotent. */
async function scheduleFollowups(oppId) {
  const existing = await db.all(
    `SELECT step FROM opportunity_followups WHERE opportunity_id = $1`,
    [oppId]
  );
  if (existing.length) return;

  for (const plan of ai.FOLLOWUP_PLAN) {
    await db.run(
      `INSERT INTO opportunity_followups (opportunity_id, step, kind, due_at)
       VALUES ($1, $2, $3, CURRENT_DATE + $4::int)
       ON CONFLICT (opportunity_id, step) DO NOTHING`,
      [oppId, plan.step, plan.kind, plan.days]
    );
  }
}

/** Draft the follow-up for a step — different message each time (item 19). */
router.post("/:id/followup/:step/draft", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });
    if (!assertOwner(opp, req.user, res)) return;

    const draft = await ai.followupSuggestion(Number(req.params.step), await contextFor(opp));
    await db.run(
      `UPDATE opportunity_followups SET suggestion = $3
        WHERE opportunity_id = $1 AND step = $2`,
      [opp.id, Number(req.params.step), draft.body]
    );
    res.json({ draft });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/followup/:step/done", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });
    if (!assertOwner(opp, req.user, res)) return;

    await db.run(
      `UPDATE opportunity_followups
          SET status = $3, done_at = now()
        WHERE opportunity_id = $1 AND step = $2`,
      [opp.id, Number(req.params.step), req.body.skip ? "cancelled" : "done"]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ── items 20-21: meetings and structured notes ───────────────────────────── */

router.post("/:id/meeting", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });
    if (!assertOwner(opp, req.user, res)) return;

    if (!req.body.scheduled_at) return res.status(400).json({ error: "When is the meeting?" });

    const row = await db.one(
      `INSERT INTO opportunity_meetings
         (opportunity_id, scheduled_at, link, attendees, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [opp.id, req.body.scheduled_at, req.body.link || null, req.body.attendees || null, req.user.id]
    );

    if (STAGES.indexOf(opp.stage) < STAGES.indexOf("meeting")) {
      await moveStage(opp.id, "meeting", req.user.id);
    }

    res.json({ meeting: row });
  } catch (err) {
    next(err);
  }
});

/**
 * Item 21 — after the meeting, the notes get structured.
 *
 * The free text is kept as written. The extracted fields sit alongside it, so
 * "what did clients actually ask for last quarter" becomes a query instead of
 * an afternoon of reading.
 */
router.post("/meeting/:meetingId/notes", async (req, res, next) => {
  try {
    const meeting = await db.one(
      `SELECT m.*, o.owner_id, o.company, o.service_primary, o.plan_name
         FROM opportunity_meetings m JOIN opportunities o ON o.id = m.opportunity_id
        WHERE m.id = $1`,
      [req.params.meetingId]
    );
    if (!meeting) return res.status(404).json({ error: "No such meeting." });
    if (meeting.owner_id !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Not your meeting." });
    }

    const notes = String(req.body.notes || "").trim();
    const structured = notes
      ? await ai.structureMeetingNotes(notes, {
          company: meeting.company,
          service: meeting.service_primary,
          plan_name: meeting.plan_name,
        })
      : {};

    const row = await db.one(
      `UPDATE opportunity_meetings
          SET notes = $2,
              outcome = COALESCE($3, outcome),
              requirement = COALESCE($4, requirement),
              structured = $5
        WHERE id = $1 RETURNING *`,
      [
        meeting.id,
        notes,
        req.body.outcome || structured.outcome || null,
        req.body.requirement || structured.requirement || null,
        JSON.stringify(structured),
      ]
    );

    res.json({ meeting: row, structured });
  } catch (err) {
    next(err);
  }
});

/* ── items 22-23: proposals, versioned ────────────────────────────────────── */

router.post("/:id/proposal/draft", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });
    if (!assertOwner(opp, req.user, res)) return;

    const ctx = await contextFor(opp);
    const config = opp.plan_config || {};
    const draft = await ai.draftProposal({
      ...ctx,
      deliverables: Array.isArray(config.deliverables) ? config.deliverables.join(", ") : null,
    });

    res.json({ draft });
  } catch (err) {
    next(err);
  }
});

/**
 * Item 23 — every save is a new version. Nothing is ever overwritten, so
 * V1 ₹10L → V2 ₹8.5L → V3 ₹7.5L survives as a record of who discounted what.
 */
router.post("/:id/proposal", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });
    if (!assertOwner(opp, req.user, res)) return;

    const last = await db.one(
      `SELECT COALESCE(MAX(version), 0) AS v FROM opportunity_proposals WHERE opportunity_id = $1`,
      [opp.id]
    );
    const version = Number(last.v) + 1;

    // A new version at a lower price is a discount, and a discount past the cap
    // is exactly what item 24 is for — so re-run the guardrail on every save.
    const quote = await pricing.priceQuote({
      service: opp.service_primary,
      tier: opp.plan_tier,
      planConfig: opp.plan_config || {},
      price: req.body.price,
    });

    const row = await db.one(
      `INSERT INTO opportunity_proposals
         (opportunity_id, version, price, service, plan_name, body, change_note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        opp.id,
        version,
        req.body.price || null,
        opp.service_primary,
        opp.plan_name,
        req.body.body || "",
        req.body.change_note || (version === 1 ? "First version" : null),
        req.user.id,
      ]
    );

    await db.run(
      `UPDATE opportunities
          SET quoted_price = COALESCE($2, quoted_price),
              margin_pct = $3, margin_amount = $4,
              approval_status = CASE WHEN $5 THEN 'pending' ELSE approval_status END,
              approval_reason = CASE WHEN $5 THEN $6 ELSE approval_reason END,
              updated_at = now()
        WHERE id = $1`,
      [
        opp.id,
        req.body.price || null,
        quote.margin_pct,
        quote.margin_amount,
        quote.requires_approval,
        quote.requires_approval ? quote.reasons.join(" ") : null,
      ]
    );

    if (STAGES.indexOf(opp.stage) < STAGES.indexOf("proposal")) {
      await moveStage(opp.id, "proposal", req.user.id);
    }

    res.json({ proposal: row, quote });
  } catch (err) {
    next(err);
  }
});

/* ── stage moves, won, and the loss interview ─────────────────────────────── */

router.post("/:id/stage", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });
    if (!assertOwner(opp, req.user, res)) return;

    const to = String(req.body.stage || "");
    if (!STAGES.includes(to)) return res.status(400).json({ error: "Unknown stage." });

    // Item 12 — there is no route to 'lost' that skips the interview.
    if (to === "lost") {
      return res.status(400).json({ error: "Losing an opportunity goes through the loss interview." });
    }

    // Item 24 — a deal the guardrail flagged cannot be booked as won until a
    // manager has cleared it. This is the whole point of the guardrail: it has
    // to bite at the moment revenue is recorded, not just when it is quoted.
    if (to === "won" && opp.approval_status === "pending") {
      return res.status(400).json({
        error: "This quote is below the approved margin and is waiting on manager approval.",
      });
    }

    await moveStage(opp.id, to, req.user.id);
    if (to === "won") {
      await db.run(`UPDATE opportunities SET won_value = quoted_price WHERE id = $1`, [opp.id]);
      await db.run(
        `UPDATE opportunity_followups SET status = 'cancelled'
          WHERE opportunity_id = $1 AND status = 'due'`,
        [opp.id]
      );
      await closeUnderlyingClaim(opp, "won");
    }

    res.json({ opportunity: await loadOpp(opp.id, req.user) });
  } catch (err) {
    next(err);
  }
});

/**
 * Items 12 & 14 — the lost-opportunity interview.
 *
 * Marking something lost and filing the interview are the same action, by
 * design. Split into two steps, the second one never happens, and the answer
 * to "why did we lose this" is a shrug six months later.
 */
router.post("/:id/lost", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });
    if (!assertOwner(opp, req.user, res)) return;

    const reason = String(req.body.primary_reason || "");
    if (!LOSS_REASONS.some(([k]) => k === reason)) {
      return res.status(400).json({ error: "Pick a primary reason." });
    }

    const days = [30, 60, 90].includes(Number(req.body.reapproach_days))
      ? Number(req.body.reapproach_days)
      : null;

    await db.tx(async (q) => {
      await q(
        `INSERT INTO opportunity_loss
           (opportunity_id, primary_reason, secondary_reason, note, chose,
            competitor_name, competitor_budget, disliked, could_have_changed,
            reapproach, reapproach_days, reapproach_at, lost_at_stage, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                 CASE WHEN $11::int IS NULL THEN NULL ELSE CURRENT_DATE + $11::int END,
                 $12,$13)
         ON CONFLICT (opportunity_id) DO UPDATE SET
           primary_reason = EXCLUDED.primary_reason,
           secondary_reason = EXCLUDED.secondary_reason,
           note = EXCLUDED.note,
           chose = EXCLUDED.chose,
           competitor_name = EXCLUDED.competitor_name,
           competitor_budget = EXCLUDED.competitor_budget,
           disliked = EXCLUDED.disliked,
           could_have_changed = EXCLUDED.could_have_changed,
           reapproach = EXCLUDED.reapproach,
           reapproach_days = EXCLUDED.reapproach_days,
           reapproach_at = EXCLUDED.reapproach_at`,
        [
          opp.id,
          reason,
          req.body.secondary_reason || null,
          req.body.note || null,
          req.body.chose || null,
          req.body.competitor_name || null,
          req.body.competitor_budget || null,
          JSON.stringify(Array.isArray(req.body.disliked) ? req.body.disliked : []),
          req.body.could_have_changed || null,
          req.body.reapproach === true || req.body.reapproach === "yes",
          days,
          // The stage it died in is the stage it was in when the interview was
          // filed — captured now, because moveStage is about to overwrite it.
          opp.stage,
          req.user.id,
        ]
      );

      await moveStage(opp.id, "lost", req.user.id, q);
      await q(
        `UPDATE opportunity_followups SET status = 'cancelled'
          WHERE opportunity_id = $1 AND status = 'due'`,
        [opp.id]
      );
      await closeUnderlyingClaim(opp, "lost", q);
    });

    res.json({ opportunity: await loadOpp(opp.id, req.user) });
  } catch (err) {
    next(err);
  }
});

/* ── items 13 & 15: the intelligence ──────────────────────────────────────── */

/**
 * Item 13 — stage-to-stage conversion, not just a win rate.
 *
 * Computed from opportunity_stages rather than current stage, so an
 * opportunity that reached proposal and then died still counts as having
 * reached proposal. Current-stage counting is the classic version of this
 * report and it is wrong: it makes a leaky proposal step look like a
 * meeting problem.
 */
router.get("/meta/intelligence", async (req, res, next) => {
  try {
    const mineOnly = req.user.role !== "admin" && req.query.scope !== "team";
    const args = mineOnly ? [req.user.id] : [];
    const ownerFilter = mineOnly ? "WHERE o.owner_id = $1" : "";

    const reached = await db.all(
      `SELECT s.to_stage AS stage, COUNT(DISTINCT s.opportunity_id)::int AS n
         FROM opportunity_stages s
         JOIN opportunities o ON o.id = s.opportunity_id
         ${ownerFilter}
        GROUP BY s.to_stage`,
      args
    );
    const reachedBy = Object.fromEntries(reached.map((r) => [r.stage, r.n]));

    const funnel = [];
    for (let i = 0; i < FUNNEL.length - 1; i++) {
      const from = FUNNEL[i];
      const to = FUNNEL[i + 1];
      const a = reachedBy[from] || 0;
      const b = reachedBy[to] || 0;
      funnel.push({
        from,
        to,
        reached: a,
        converted: b,
        rate: a > 0 ? Math.round((b / a) * 100) : null,
      });
    }

    // Item 15 — top reasons for losing business, as percentages.
    const losses = await db.all(
      `SELECT ol.primary_reason AS reason, COUNT(*)::int AS n
         FROM opportunity_loss ol
         JOIN opportunities o ON o.id = ol.opportunity_id
         ${ownerFilter}
        GROUP BY ol.primary_reason ORDER BY n DESC`,
      args
    );
    const lossTotal = losses.reduce((sum, r) => sum + r.n, 0);
    const objections = losses.map((r) => ({
      reason: r.reason,
      label: (LOSS_REASONS.find(([k]) => k === r.reason) || [null, r.reason])[1],
      n: r.n,
      pct: lossTotal ? Math.round((r.n / lossTotal) * 100) : 0,
    }));

    const diedAt = await db.all(
      `SELECT ol.lost_at_stage AS stage, COUNT(*)::int AS n
         FROM opportunity_loss ol
         JOIN opportunities o ON o.id = ol.opportunity_id
         ${ownerFilter}
        WHERE ol.lost_at_stage IS NOT NULL
        GROUP BY ol.lost_at_stage ORDER BY n DESC`,
      args
    );

    const totals = await db.one(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE o.stage = 'won')::int  AS won,
              COUNT(*) FILTER (WHERE o.stage = 'lost')::int AS lost,
              COALESCE(SUM(o.won_value) FILTER (WHERE o.stage = 'won'), 0) AS won_value
         FROM opportunities o ${ownerFilter}`,
      args
    );

    // Item 14's payoff: losses that asked to be re-approached, now due.
    const reapproach = await db.all(
      `SELECT o.id, o.company, ol.reapproach_at, ol.primary_reason
         FROM opportunity_loss ol
         JOIN opportunities o ON o.id = ol.opportunity_id
        WHERE ol.reapproach = true AND ol.reapproach_at IS NOT NULL
          AND ol.reapproach_at <= CURRENT_DATE + 14
          ${mineOnly ? "AND o.owner_id = $1" : ""}
        ORDER BY ol.reapproach_at ASC LIMIT 25`,
      args
    );

    res.json({
      funnel,
      objections,
      died_at: diedAt,
      totals,
      reapproach,
      scope: mineOnly ? "mine" : "team",
      loss_total: lossTotal,
    });
  } catch (err) {
    next(err);
  }
});

/* ── admin: the rate card ─────────────────────────────────────────────────── */

router.put("/meta/rate-card", requireAdmin, async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    for (const r of rows) {
      if (!r.service || !r.tier) continue;
      await db.run(
        `INSERT INTO rate_card (service, tier, label, price, creators, views, deliverables, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (lower(service), lower(tier)) DO UPDATE SET
           label = EXCLUDED.label, price = EXCLUDED.price,
           creators = EXCLUDED.creators, views = EXCLUDED.views,
           deliverables = EXCLUDED.deliverables, sort = EXCLUDED.sort`,
        [
          r.service, r.tier, r.label || r.tier, Number(r.price) || 0,
          Number(r.creators) || 0, r.views || null, r.deliverables || null,
          Number(r.sort) || 0,
        ]
      );
    }

    for (const key of ["cost_model", "guardrail"]) {
      if (!req.body[key]) continue;
      await db.run(
        `INSERT INTO pricing_settings (key, value, updated_by, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET
           value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(req.body[key]), req.user.id]
      );
    }

    res.json({ ok: true, rate_card: await pricing.rateCard() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.LOSS_REASONS = LOSS_REASONS;
module.exports.STAGES = STAGES;
