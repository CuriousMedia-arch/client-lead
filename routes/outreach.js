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
const sweeps = require("../lib/sweeps");
// Whichever provider the person has connected — Teams or Meet.
const meetings = require("../lib/meetings");
const fathom = require("../lib/fathom");
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

/*
 * Two selects, on purpose.
 *
 * OPP_LIST is what Today, the pipeline and the bell use. OPP_ONE adds the
 * company profile (industry, size, website) that only the open workspace and
 * the AI prompts need.
 *
 * They were one query, and the joined-in company profile made every list cost
 * grow with the size of the COMPANIES table rather than with the number of
 * opportunities returned — because `lower(c.name) = lower(o.company)` is a
 * join on a computed value. Measured: 150ms at 100 companies, 1.2s at 600,
 * while still returning the same twenty rows. Splitting it removes the work
 * rather than optimising it.
 */
const OPP_LIST = `
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
         fc.name                  AS focus_name,
         fc.role                  AS focus_role,
         fc.email                 AS focus_email,
         fc.phone                 AS focus_phone,
         fc.linkedin              AS focus_linkedin,
         l.fresh_deadline_at      AS lead_deadline
    FROM opportunities o
    LEFT JOIN users            u  ON u.id  = o.owner_id
    LEFT JOIN company_contacts cc ON cc.id = o.contact_id
    LEFT JOIN company_contacts fc ON fc.id = o.focus_contact_id
    LEFT JOIN leads            l  ON l.id  = o.lead_id`;

/** The same, plus the company profile. Only for opening one opportunity. */
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
         fc.name                  AS focus_name,
         fc.role                  AS focus_role,
         fc.email                 AS focus_email,
         fc.phone                 AS focus_phone,
         fc.linkedin              AS focus_linkedin,
         l.fresh_deadline_at      AS lead_deadline,
         c.industry, c.employees, c.revenue, c.website, c.domain,
         c.linkedin               AS company_linkedin
    FROM opportunities o
    LEFT JOIN users            u  ON u.id  = o.owner_id
    LEFT JOIN company_contacts cc ON cc.id = o.contact_id
    LEFT JOIN company_contacts fc ON fc.id = o.focus_contact_id
    LEFT JOIN leads            l  ON l.id  = o.lead_id
    LEFT JOIN companies        c  ON lower(c.name) = lower(o.company)`;

/**
 * The opportunity's own clock wins; the claim's is the fallback for rows that
 * pre-date it. `kind` is what makes the label honest — the same "23h left" is
 * either "send the first message" or "close the deal" depending on where the
 * conversation has got to, and the old card said "to close this" for both.
 */
function deadlineOf(o) {
  return o.deadline_at || o.contact_deadline || o.lead_deadline || null;
}

function countdown(o) {
  const at = deadlineOf(o);
  if (!at) return null;

  const kind = o.deadline_kind || "contact";
  const purpose = DEADLINE_LABEL[kind] || DEADLINE_LABEL.contact;

  const ms = new Date(at).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;

  if (ms <= 0) {
    return {
      kind, purpose,
      label: "Time is up",
      full: `Time is up ${purpose}`,
      hours: 0, days: 0, overdue: true, urgent: true,
    };
  }

  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(hours / 24);
  const label = days >= 1 ? `${days}d left` : `${hours}h left`;

  return {
    kind,
    purpose,
    label,
    full: `${label} ${purpose}`,
    hours,
    days,
    overdue: false,
    // Relative to the window, not a flat number: 6 hours left on a 24-hour
    // contact window is the same amount of trouble as a day left on a week.
    urgent: kind === "contact" ? hours <= 6 : hours <= 48,
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
    // On a company-level claim the recipient is whoever was picked; on a
    // personal claim it is the person claimed. Same field either way, so the
    // prompts don't have to know which kind of opportunity this is.
    contact_name: opp.focus_name || opp.contact_name,
    contact_role: opp.focus_role || opp.contact_role,
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
/**
 * Outreach stages don't map one-to-one onto the status a contact carries in
 * All Leads — there are eight of one and seven of the other, named differently
 * because they were designed for different jobs.
 *
 * Anything past first contact but not yet closed reads as 'qualified' on the
 * contact: from All Leads' point of view "there's a live conversation here" is
 * the whole message, and the detail lives in the opportunity.
 */
const STAGE_TO_STATUS = {
  new: "new",
  contacted: "contacted",
  replied: "replied",
  meeting: "qualified",
  proposal: "qualified",
  negotiation: "qualified",
  won: "won",
  lost: "lost",
};

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

  // Keep All Leads in step. Until this existed, a contact could be mid-
  // negotiation in My Outreach and still show as "new" to everyone browsing
  // All Leads — which is how two people end up ringing the same person.
  const status = STAGE_TO_STATUS[toStage];
  if (status) {
    await run(
      `UPDATE company_contacts SET status = $2
        WHERE id = (SELECT contact_id FROM opportunities WHERE id = $1)`,
      [oppId, status]
    );
    await run(
      `UPDATE leads SET status = $2, updated_at = now()
        WHERE id = (SELECT lead_id FROM opportunities WHERE id = $1)`,
      [oppId, status]
    );
  }

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

/**
 * Mark everything currently outstanding as seen.
 *
 * Stamps a timestamp rather than storing dismissed ids. That is what makes a
 * recurring problem behave correctly: if they reply again tomorrow, the new
 * reply is newer than this stamp, so the dot lights up again — whereas a
 * dismissed-id list would keep it permanently silenced.
 */
router.post("/alerts/seen", async (req, res, next) => {
  try {
    await db.run(`UPDATE users SET alerts_seen_at = now() WHERE id = $1`, [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * The clock, and what it currently means.
 *
 *   contact  send the first message           (24 hours from claiming)
 *   reply    get an answer to that message    (7 days from sending)
 *   close    win or lose it                   (7 days from their answer)
 *
 * One function sets all three, and it also writes the same moment onto the
 * underlying claim. That second part is the important one: the claim row is
 * what All Leads and Fresh Leads read, so leaving it behind would give the
 * same lead two different countdowns depending on which tab you were looking
 * at — and only one of them would actually release anything.
 */
const DEADLINE_LABEL = {
  contact: "to send the first message",
  reply: "to get a reply",
  close: "to close the deal",
};

async function setDeadline(opp, kind, q = null) {
  const run = q || ((text, params) => db.pool.query(text, params));
  const cadence = await pricing.followupCadence();

  const interval =
    kind === "contact"
      ? `${Number(cadence.contact_hours) || 24} hours`
      : kind === "reply"
      ? `${Number(cadence.reply_days) || 7} days`
      : `${Number(cadence.close_days) || 7} days`;

  const { rows } = await run(
    `UPDATE opportunities
        SET deadline_at = now() + $2::interval,
            deadline_kind = $3,
            updated_at = now()
      WHERE id = $1
      RETURNING deadline_at`,
    [opp.id, interval, kind]
  );

  const at = rows[0] && rows[0].deadline_at;
  if (!at) return null;

  if (opp.contact_id) {
    await run(`UPDATE company_contacts SET deadline_at = $2 WHERE id = $1`, [opp.contact_id, at]);
  } else if (opp.lead_id && opp.source === "all") {
    await run(`UPDATE leads SET deadline_at = $2, updated_at = now() WHERE id = $1`, [opp.lead_id, at]);
  } else if (opp.lead_id) {
    await run(
      `UPDATE leads SET fresh_deadline_at = $2, fresh_last_activity_at = now(), updated_at = now()
        WHERE id = $1`,
      [opp.lead_id, at]
    );
  }

  return at;
}

/** Stop the clock entirely — the deal is done, either way. */
async function clearDeadline(oppId, q = null) {
  const run = q || ((text, params) => db.pool.query(text, params));
  await run(
    `UPDATE opportunities SET deadline_at = NULL, deadline_kind = NULL, updated_at = now()
      WHERE id = $1`,
    [oppId]
  );
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
    // Pick up anything claimed since the last look, then expire anything that
    // ran out. In that order: a lead claimed and abandoned inside the same
    // window should still get its opportunity created before being judged.
    await ensureOpportunities(req.user.id);
    await sweeps.sweepSilent();

    const mine = await db.all(
      `${OPP_LIST} WHERE o.owner_id = $1 AND o.stage NOT IN ('won','lost')
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

    // Next meeting on each opportunity, whenever it is — the card needs to say
    // "meeting on Friday" rather than leaving a mid-conversation lead looking
    // idle.
    const nextMeetings = await db.all(
      `SELECT DISTINCT ON (m.opportunity_id) m.opportunity_id, m.scheduled_at
         FROM opportunity_meetings m
         JOIN opportunities o ON o.id = m.opportunity_id
        WHERE o.owner_id = $1 AND m.scheduled_at >= now()
        ORDER BY m.opportunity_id, m.scheduled_at ASC`,
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
    const nextBy = new Map();
    for (const m of nextMeetings) nextBy.set(m.opportunity_id, m);

    const meetingBy = new Map();
    for (const m of meetingsToday) if (!meetingBy.has(m.opportunity_id)) meetingBy.set(m.opportunity_id, m);

    // `working` is the catch-all and it is not optional. Without it, a lead at
    // meeting or negotiation stage — with no meeting TODAY, no unanswered
    // reply and no follow-up due — matched none of the branches below and
    // silently vanished from Today. The salesperson's own conclusion was that
    // the work had been lost, because the only way back to it was the Pipeline
    // tab they had no reason to open.
    const buckets = {
      urgent: [], replied: [], meeting: [], followup: [], proposal: [], new: [], working: [],
    };

    for (const o of mine) {
      o.countdown = countdown(o);
      o.due_followup = followupBy.get(o.id) || null;
      o.meeting_today = meetingBy.get(o.id) || null;
      o.next_meeting_at = (nextBy.get(o.id) || {}).scheduled_at || null;

      const waitingOnUs =
        o.last_reply_at && (!o.last_contacted_at || o.last_reply_at > o.last_contacted_at);

      // An unanswered reply comes FIRST, ahead of the clock.
      //
      // It used to sit behind the urgency check, and because the deadline never
      // reset after first contact, every contacted lead was permanently inside
      // the urgent window — so a reply you had just logged went into "Do these
      // first" and "They replied" stayed empty no matter what you did. The
      // reply is also the most actionable thing on the board: somebody is
      // sitting there waiting for an answer.
      if (waitingOnUs) buckets.replied.push(o);
      else if (o.countdown && (o.countdown.overdue || o.countdown.urgent)) buckets.urgent.push(o);
      else if (o.meeting_today) buckets.meeting.push(o);
      else if (o.stage === "proposal" || o.stage === "negotiation") buckets.proposal.push(o);
      else if (o.due_followup) buckets.followup.push(o);
      else if (o.stage === "new") buckets.new.push(o);
      else buckets.working.push(o);
    }

    res.json({
      buckets,
      target: await targetFor(req.user.id),
      counts: {
        urgent: buckets.urgent.length,
        followup: buckets.followup.length,
        new: buckets.new.length,
        replied: buckets.replied.length,
        meeting: buckets.meeting.length,
        proposal: buckets.proposal.length,
        working: buckets.working.length,
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
    await ensureOpportunities(req.user.id);

    const all = req.query.all === "1" && req.user.role === "admin";
    const rows = await db.all(
      `${OPP_LIST} ${all ? "" : "WHERE o.owner_id = $1"}
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

      // A swept contact has no opportunity of its own — the company's does.
      // Hand back that one instead of creating a rival card for the same work.
      if (c.claim_source === "fresh") {
        const parent = await db.one(
          `${OPP_SELECT}
            WHERE o.lead_id IS NOT NULL AND lower(o.company) = lower($1) AND o.owner_id = $2`,
          [c.company, c.owner_id]
        );
        if (parent) {
          parent.countdown = countdown(parent);
          parent.can_edit = parent.owner_id === req.user.id || req.user.role === "admin";
          return res.json({ opportunity: parent, created: false, redirected: true });
        }
      }

      company = c.company;
      ownerId = c.owner_id;
      source = "all";
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

    // How long they have to send the first message before it goes back.
    const releaseHours = Number((await pricing.followupCadence()).release_after_hours) || 24;

    const created = await db.one(
      `INSERT INTO opportunities (contact_id, lead_id, company, owner_id, source, stage, silent_until)
       VALUES ($1, $2, $3, $4, $5, 'new', now() + ($6 || ' hours')::interval)
       RETURNING id`,
      [contactId, leadId, company, ownerId, source, String(releaseHours)]
    );
    await db.run(
      `INSERT INTO opportunity_stages (opportunity_id, to_stage, user_id) VALUES ($1, 'new', $2)`,
      [created.id, req.user.id]
    );

    // Clock starts: 24 hours to send the first message.
    await setDeadline({ id: created.id, contact_id: contactId, lead_id: leadId, source }, "contact");

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
/*
 * Notes on the query below, kept OUT of the SQL string on purpose: a `--`
 * comment survives only as long as the newline after it does, and anything
 * that collapses whitespace — a logger, a query formatter — turns it into a
 * comment that swallows the rest of the statement.
 *
 *   claim_source <> 'fresh'  Only people claimed from All Leads get their own
 *                            opportunity. A contact held because a Fresh claim
 *                            swept up the company belongs to that company's
 *                            opportunity; without this filter, one Fresh
 *                            company with five contacts puts six cards on
 *                            Today.
 *
 *   LEFT JOIN ... IS NULL    "Rows with no opportunity yet". Same result as
 *                            NOT EXISTS and reads closer to the intent.
 */
async function ensureOpportunities(userId) {
  try {
    /*
     * Ask the cheap question first.
     *
     * This runs on Today, on the pipeline, AND on the bell — which polls every
     * sixty seconds for everyone signed in. The work below is two
     * INSERT ... SELECT statements that scan every contact and lead the user
     * owns, plus a third over their opportunities. Doing that once a minute
     * per person, forever, to discover that nothing has changed is the kind of
     * waste that shows up as "the whole thing feels slow".
     *
     * Both counts below hit indexes on owner_id, so the common answer — zero —
     * costs one fast query instead of three scans and three writes.
     */
    const gap = await db.one(
      `SELECT
         (SELECT COUNT(*) FROM company_contacts cc
           LEFT JOIN opportunities o ON o.contact_id = cc.id
          WHERE cc.owner_id = $1 AND cc.deleted_at IS NULL
            AND COALESCE(cc.claim_source, 'all') <> 'fresh'
            AND o.id IS NULL)
       + (SELECT COUNT(*) FROM leads l
           LEFT JOIN opportunities o ON o.lead_id = l.id
          WHERE l.fresh_owner_id = $1 AND o.id IS NULL) AS missing`,
      [userId]
    );
    if (!gap || !Number(gap.missing)) return 0;

    const created = await db.one(
      `WITH ins_contacts AS (
         INSERT INTO opportunities (contact_id, company, owner_id, source, stage, silent_until)
         SELECT cc.id, cc.company, cc.owner_id, 'all', 'new',
                now() + ($2 || ' hours')::interval
           FROM company_contacts cc
           LEFT JOIN opportunities o ON o.contact_id = cc.id
          WHERE cc.owner_id = $1
            AND cc.deleted_at IS NULL
            AND COALESCE(cc.claim_source, 'all') <> 'fresh'
            AND o.id IS NULL
         RETURNING id
       ), ins_leads AS (
         INSERT INTO opportunities (lead_id, company, owner_id, source, stage, silent_until)
         SELECT l.id, c.name, l.fresh_owner_id,
                CASE WHEN l.fresh_from_newspaper THEN 'newspaper' ELSE 'fresh' END, 'new',
                now() + ($2 || ' hours')::interval
           FROM leads l
           JOIN companies c ON c.id = l.company_id
           LEFT JOIN opportunities o ON o.lead_id = l.id
          WHERE l.fresh_owner_id = $1
            AND o.id IS NULL
         RETURNING id
       )
       SELECT (SELECT COUNT(*) FROM ins_contacts)::int
            + (SELECT COUNT(*) FROM ins_leads)::int AS n`,
      [userId, String(Number((await pricing.followupCadence()).release_after_hours) || 24)]
    );

    // Seed the stage history for anything just created, so the funnel report
    // counts them as having reached 'new' rather than starting life invisible.
    await db.run(
      `INSERT INTO opportunity_stages (opportunity_id, to_stage, user_id)
       SELECT o.id, 'new', $1::bigint
         FROM opportunities o
         LEFT JOIN opportunity_stages s ON s.opportunity_id = o.id
        WHERE o.owner_id = $1 AND s.id IS NULL`,
      [userId]
    );

    return created.n;
  } catch (err) {
    // Never let this break the screen it runs in front of. A failure here
    // means a card is missing, which is bad; a failure that blanks Today
    // entirely is worse.
    console.error("[outreach] sync failed:", err.message);
    return 0;
  }
}

/**
 * Kept as an endpoint for anything that wants to force it, but Today and the
 * bell now call ensureOpportunities() directly. They have to: this used to run
 * only from the browser, once per page load, so a lead claimed AFTER My
 * Outreach had been opened got no opportunity and simply never appeared —
 * the tab's own count went up while Today stayed empty, and only a full
 * browser refresh fixed it.
 */
router.post("/sync", async (req, res, next) => {
  try {
    res.json({ created: await ensureOpportunities(req.user.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * What should be nagging me right now.
 *
 * This is the half of item 18 that was missing. The follow-up table knew a
 * step was due on day 3 and nothing ever said so — the number only moved if
 * you happened to open the tab and look, which is not what "automated" means.
 *
 * The topbar bell already polls every 60 seconds for expiring claims, so this
 * feeds the same bell rather than inventing a second notification system.
 * Ordered by how much it costs to ignore: a claim you're about to lose, then a
 * reply sitting unanswered, then a meeting today, then the drip.
 */
router.get("/alerts", async (req, res, next) => {
  try {
    await ensureOpportunities(req.user.id);
    await sweeps.sweepSilent();

    const rows = await db.all(
      `SELECT o.id, o.company, o.stage, o.next_action, o.approval_status,
              o.last_reply_at, o.last_contacted_at,
              cc.name AS contact_name,
              COALESCE(cc.deadline_at, l.fresh_deadline_at) AS deadline_at,
              (SELECT MIN(f.due_at) FROM opportunity_followups f
                WHERE f.opportunity_id = o.id AND f.status = 'due'
                  AND f.due_at <= CURRENT_DATE)          AS followup_due,
              (SELECT MIN(f.step) FROM opportunity_followups f
                WHERE f.opportunity_id = o.id AND f.status = 'due'
                  AND f.due_at <= CURRENT_DATE)          AS followup_step,
              (SELECT MIN(m.scheduled_at) FROM opportunity_meetings m
                WHERE m.opportunity_id = o.id
                  AND m.scheduled_at::date = CURRENT_DATE) AS meeting_at,
              o.deadline_at,
              o.deadline_kind,
              o.updated_at,
              EXTRACT(EPOCH FROM (o.deadline_at - now())) / 3600 AS hours_to_release,
              EXTRACT(EPOCH FROM (now() - o.created_at)) / 3600  AS hours_idle
         FROM opportunities o
         LEFT JOIN company_contacts cc ON cc.id = o.contact_id
    LEFT JOIN company_contacts fc ON fc.id = o.focus_contact_id
         LEFT JOIN leads            l  ON l.id  = o.lead_id
        WHERE o.owner_id = $1 AND o.stage NOT IN ('won','lost')`,
      [req.user.id]
    );

    // How long a claimed lead may sit untouched before it nags. Admin-editable
    // in Pricing, because the right number is a sales-management decision, not
    // a constant someone should have to redeploy to change.
    // Start warning when there is less than this left on the clock. Warning
    // the instant a lead is claimed would make the bell noise; warning only
    // once it has already gone would be useless.
    const cadence = await pricing.followupCadence();
    const nudgeAfter = Number(cadence.nudge_after_hours) || 12;

    // When each alert became true. The bell dot compares this against the
    // user's alerts_seen_at, so an alert they have already looked at stops
    // lighting it up — and a problem that comes back lights it up again.
    // Read straight from the table, not from req.user: sessions are cached for
    // SESSION_CACHE_MS, so a cached user object would still hold the OLD
    // timestamp right after they mark everything read — and the dot would
    // stubbornly stay lit until the cache expired.
    const seenRow = await db.one("SELECT alerts_seen_at FROM users WHERE id = $1", [req.user.id]);
    const seenAt = seenRow && seenRow.alerts_seen_at ? new Date(seenRow.alerts_seen_at) : null;

    const items = [];

    for (const r of rows) {
      const c = countdown({ contact_deadline: r.deadline_at });

      // One alert per opportunity, not one per condition. Three bell entries
      // for the same company is noise, and noise is how a bell gets ignored.
      if (c && (c.overdue || c.urgent)) {
        items.push({
          id: r.id, company: r.company, contact_name: r.contact_name,
          kind: "expiring", urgency: 1, since: r.deadline_at,
          text: c.overdue ? "Your time on this has run out" : `${c.label} to close this`,
          action: r.next_action || "Open it before you lose it",
        });
      } else if (r.last_reply_at && (!r.last_contacted_at || r.last_reply_at > r.last_contacted_at)) {
        items.push({
          id: r.id, company: r.company, contact_name: r.contact_name,
          kind: "reply", urgency: 2, since: r.last_reply_at,
          text: "They wrote back — waiting for you",
          action: r.next_action || "Read what they said and write back",
        });
      } else if (r.meeting_at) {
        items.push({
          id: r.id, company: r.company, contact_name: r.contact_name,
          kind: "meeting", urgency: 3, since: r.meeting_at,
          text: `Meeting today at ${new Date(r.meeting_at).toLocaleTimeString("en-IN", {
            hour: "numeric", minute: "2-digit",
          })}`,
          action: "Write your notes straight after",
        });
      } else if (r.followup_due) {
        const late = Math.round((Date.now() - new Date(r.followup_due).getTime()) / 864e5);
        items.push({
          id: r.id, company: r.company, contact_name: r.contact_name,
          kind: "followup", urgency: 4, since: r.followup_due,
          text:
            late > 0
              ? `Reminder ${r.followup_step} was due ${late} day${late === 1 ? "" : "s"} ago`
              : `Reminder ${r.followup_step} is due today`,
          action: "Open it and we'll write the message for you",
        });
      } else if (
        r.deadline_kind === "contact" &&
        !r.last_contacted_at &&
        r.hours_to_release != null &&
        r.hours_to_release <= nudgeAfter
      ) {
        // Nothing has ever been sent on this one. The follow-up sequence
        // cannot help — it only starts after a first message — so without
        // this branch a freshly claimed lead can sit silently until its claim
        // expires, which is exactly the gap that made the bell look dead.
        items.push({
          id: r.id, company: r.company, contact_name: r.contact_name,
          kind: "stalled", urgency: 4, since: r.deadline_at,
          // Counts DOWN to the consequence, not up since the claim. "Claimed
          // 41 hours ago" tells a salesperson nothing they can act on; "goes
          // back in 7 hours" tells them exactly what happens if they don't.
          text:
            r.hours_to_release <= 0
              ? "About to go back to the pool"
              : r.hours_to_release < 1
              ? "Goes back to the pool within the hour"
              : `Goes back to the pool in ${Math.floor(r.hours_to_release)} hour${
                  Math.floor(r.hours_to_release) === 1 ? "" : "s"
                }`,
          action: "Send your first message to keep it",
        });
      } else if (
        r.deadline_kind &&
        r.deadline_kind !== "contact" &&
        r.hours_to_release != null &&
        r.hours_to_release <= 24
      ) {
        // The reply and close windows need their own warning. Without one, a
        // week-long clock ran out with no notice at all — the only alert that
        // existed was for leads that had never been contacted.
        items.push({
          id: r.id, company: r.company, contact_name: r.contact_name,
          kind: "stalled", urgency: 4, since: r.deadline_at,
          text:
            r.hours_to_release <= 0
              ? "About to go back to the pool"
              : `Goes back in ${Math.max(1, Math.floor(r.hours_to_release))} hour${
                  Math.floor(r.hours_to_release) === 1 ? "" : "s"
                }`,
          action:
            r.deadline_kind === "reply"
              ? "Chase them for an answer, or log their reply if they've sent one"
              : "Close it as won or lost before the week is up",
        });
      } else if (r.approval_status === "pending") {
        items.push({
          id: r.id, company: r.company, contact_name: r.contact_name,
          kind: "approval", urgency: 5, since: r.updated_at,
          text: "Price is with your manager",
          action: "Give them a nudge, or raise the price and resend",
        });
      }
    }

    items.sort((a, b) => a.urgency - b.urgency);

    // `unseen` is what turns the dot red. `count` is everything outstanding,
    // which is what the panel lists — the two differ on purpose: work you have
    // already looked at is still work, it just shouldn't keep shouting.
    for (const it of items) {
      it.unseen = !seenAt || !it.since || new Date(it.since) > seenAt;
    }

    res.json({
      items,
      count: items.length,
      unseen: items.filter((i) => i.unseen).length,
      seen_at: seenAt,
    });
  } catch (err) {
    // The bell is a convenience. If this throws, the rest of the portal should
    // not notice — an empty list is a better failure than a broken topbar.
    console.warn("[outreach] alerts failed:", err.message);
    res.json({ items: [], count: 0 });
  }
});

/* ── item 3: the Opportunity Workspace ────────────────────────────────────── */

/** Everything the workspace renders, in one round trip. */
router.get("/:id", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });

    const [messages, followups, meetings, proposals, stages, loss, history, contacts] =
      await Promise.all([
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
      // What was already tried at this company, by anyone, on any earlier
      // claim. A Fresh window closing hands the account back — the next person
      // to pick it up should not open with a pitch the client already turned
      // down six weeks ago.
      db.all(
        `SELECT o.id, o.stage, o.service_primary, o.quoted_price,
                o.won_at, o.lost_at, o.created_at,
                u.display_name AS owner_name,
                ol.primary_reason AS lost_reason,
                COALESCE(sent.n, 0)  AS sent_count,
                COALESCE(mtg.n, 0)   AS meeting_count
           FROM opportunities o
           LEFT JOIN users u ON u.id = o.owner_id
           LEFT JOIN opportunity_loss ol ON ol.opportunity_id = o.id
           -- Pre-aggregated rather than correlated subqueries: one pass over
           -- each child table instead of two per row.
           LEFT JOIN (
             SELECT opportunity_id, COUNT(*)::int AS n
               FROM opportunity_messages WHERE direction = 'out'
              GROUP BY opportunity_id
           ) sent ON sent.opportunity_id = o.id
           LEFT JOIN (
             SELECT opportunity_id, COUNT(*)::int AS n
               FROM opportunity_meetings GROUP BY opportunity_id
           ) mtg ON mtg.opportunity_id = o.id
          WHERE lower(o.company) = lower($1)
            AND o.id <> $2
            -- Only ones where something actually happened; an untouched
            -- duplicate tells the next person nothing.
            AND (o.last_contacted_at IS NOT NULL OR o.stage IN ('won','lost'))
          ORDER BY o.created_at DESC
          LIMIT 10`,
        [opp.company, opp.id]
      ),
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
      history,
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

/**
 * Who we're currently talking to on a company-level opportunity.
 *
 * A Fresh claim is one thing to sell to one company — one service, one plan,
 * one price — but there may be five people who could receive it. So the pitch
 * and the price stay on the opportunity and only the recipient changes here.
 */
router.post("/:id/focus", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });
    if (!assertOwner(opp, req.user, res)) return;

    const contactId = req.body.contact_id ? Number(req.body.contact_id) : null;

    if (contactId) {
      // Has to be someone at this company — a stray id would quietly point the
      // pitch at a person from an unrelated account.
      const ok = await db.one(
        `SELECT id FROM company_contacts
          WHERE id = $1 AND lower(company) = lower($2) AND deleted_at IS NULL`,
        [contactId, opp.company]
      );
      if (!ok) return res.status(400).json({ error: "That person isn't at this company." });
    }

    await db.run(
      `UPDATE opportunities SET focus_contact_id = $2, updated_at = now() WHERE id = $1`,
      [opp.id, contactId]
    );

    res.json({ opportunity: await loadOpp(opp.id, req.user) });
  } catch (err) {
    next(err);
  }
});

/* ── items 5-7: plans, the custom builder, the guardrail ──────────────────── */

router.get("/meta/rate-card", async (req, res, next) => {
  try {
    const [card, rules, cadence] = await Promise.all([
      pricing.rateCard(),
      pricing.guardrail(),
      pricing.followupCadence(),
    ]);
    res.json({ rate_card: card, guardrail: rules, cadence, services: ai.SERVICES });
  } catch (err) {
    next(err);
  }
});

/**
 * Live quote — called as the builder's fields change, so the salesperson sees
 * the discount as they type rather than after they save. Writes nothing.
 */
router.post("/quote", async (req, res, next) => {
  try {
    res.json({
      quote: await pricing.priceQuote({
        service: req.body.service,
        tier: req.body.tier,
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
      price: req.body.price,
      budget: req.body.budget,
    });

    // Always back to 'pending' when the discount rule fires. An earlier
    // approval was for an earlier price; carrying it forward would let a
    // salesperson get one discount signed off and then keep cutting under
    // cover of it.
    const needsApproval = quote.requires_approval;

    await db.run(
      `UPDATE opportunities
          SET service_primary = $2,
              plan_tier = $3, plan_name = $4,
              client_budget = $5, quoted_price = $6,
              approval_status = CASE WHEN $7 THEN 'pending' ELSE NULL END,
              approval_reason = CASE WHEN $7 THEN $8 ELSE NULL END,
              updated_at = now()
        WHERE id = $1`,
      [
        opp.id,
        service,
        req.body.tier || null,
        quote.plan_name,
        req.body.budget || null,
        quote.revenue,
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
      `${OPP_LIST} WHERE o.approval_status = 'pending' ORDER BY o.updated_at DESC`
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

    const ctx = await contextFor(opp);
    const pitch = await ai.generatePitch(ctx);

    // Send back what it was written FROM, not just the words. The salesperson
    // is about to put this out under their own name and needs to be able to
    // check the inputs — especially the news headline, which is the one thing
    // here that comes from a scraper rather than from them.
    pitch.signal_title = ctx.signal_title || null;

    // A headline that names a different company is the specific failure worth
    // catching: it reads perfectly fluently and is mortifying to send. Cheap
    // check — does the headline mention a capitalised name that isn't theirs
    // while never mentioning theirs?
    pitch.mismatch = Boolean(
      ctx.signal_title &&
        opp.company &&
        !ctx.signal_title.toLowerCase().includes(opp.company.toLowerCase().split(" ")[0])
    );

    res.json({ pitch });
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
      // Clearing silent_until is what takes this off the auto-release list.
      // They have made contact; from here the normal claim clock applies.
      await q(
        `UPDATE opportunities
            SET last_contacted_at = now(), silent_until = NULL, updated_at = now()
          WHERE id = $1`,
        [opp.id]
      );
      if (opp.stage === "new") await moveStage(opp.id, "contacted", req.user.id, q);

      // The clock changes meaning here: they have been written to, so the
      // question is no longer "will you contact them" but "will they answer".
      await setDeadline(opp, "reply", q);
    });

    // Item 18 — the sequence starts when the first message goes out.
    await scheduleFollowups(opp.id);

    /*
     * Record the price as a version, if it moved.
     *
     * Package, price and message are one job in the UI now, so there is no
     * separate "save the proposal" step to hang this off — but the record of
     * how a price got discounted is exactly what management asked for, and
     * losing it because the button disappeared would be a silent regression.
     * So a send at a new price writes a version by itself.
     */
    if (opp.quoted_price) {
      const last = await db.one(
        `SELECT version, price FROM opportunity_proposals
          WHERE opportunity_id = $1 ORDER BY version DESC LIMIT 1`,
        [opp.id]
      );
      const moved = !last || Number(last.price) !== Number(opp.quoted_price);
      if (moved) {
        await db.run(
          `INSERT INTO opportunity_proposals
             (opportunity_id, version, price, service, plan_name, body, change_note, sent_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)`,
          [
            opp.id,
            (last ? Number(last.version) : 0) + 1,
            opp.quoted_price,
            opp.service_primary,
            opp.plan_name,
            body,
            last ? "Price changed and re-sent" : "First quote sent",
            req.user.id,
          ]
        );
      }
    }

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

      // They answered. Now it is a week to win or lose it.
      await setDeadline(opp, "close", q);

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

  const cadence = await pricing.followupCadence();

  for (const plan of ai.FOLLOWUP_PLAN) {
    // The brief specified day 3 / 7 / 14 / 30, but that is a policy, not a
    // law — so the days come from settings and fall back to the brief's
    // numbers if nobody has changed them.
    const days = Number(cadence[`step${plan.step}_days`]) || plan.days;
    await db.run(
      `INSERT INTO opportunity_followups (opportunity_id, step, kind, due_at)
       VALUES ($1, $2, $3, CURRENT_DATE + $4::int)
       ON CONFLICT (opportunity_id, step) DO NOTHING`,
      [oppId, plan.step, plan.kind, days]
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

    const start = new Date(req.body.scheduled_at);
    const minutes = Number(req.body.minutes) || 30;
    const end = new Date(start.getTime() + minutes * 60000);

    // Who gets the invite. The chosen contact by default, plus anyone typed in.
    const invitees = String(req.body.attendees || "")
      .split(/[,;\s]+/)
      .filter((x) => x.includes("@"));
    const primaryEmail = opp.focus_email || opp.contact_email;
    if (primaryEmail && !invitees.includes(primaryEmail)) invitees.unshift(primaryEmail);

    let meet = null;
    let meetError = null;

    if (req.body.create_meet !== false) {
      try {
        meet = await meetings.createMeeting(req.user.id, {
          summary: `${opp.company} × Curious Media`,
          description: opp.service_primary
            ? `Discussing ${opp.service_primary}.`
            : "Introductory call.",
          startISO: start.toISOString(),
          endISO: end.toISOString(),
          attendees: invitees,
        });
      } catch (err) {
        // A Calendar failure must not lose the meeting. Record it anyway and
        // tell them why there is no link — otherwise the salesperson retypes
        // everything and still has no idea what went wrong.
        console.error("[outreach] calendar failed:", err.message);
        meetError = err.message;
      }
    }

    const row = await db.one(
      `INSERT INTO opportunity_meetings
         (opportunity_id, scheduled_at, link, attendees, created_by,
          calendar_event_id, meet_link, transcript_state, provider)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        opp.id,
        start.toISOString(),
        (meet && meet.meetLink) || req.body.link || null,
        invitees.join(", ") || req.body.attendees || null,
        req.user.id,
        meet && meet.eventId,
        meet && meet.meetLink,
        meet ? "pending" : null,
        meet && meet.provider,
      ]
    );

    if (STAGES.indexOf(opp.stage) < STAGES.indexOf("meeting")) {
      await moveStage(opp.id, "meeting", req.user.id);
    }

    res.json({
      meeting: row,
      meet_created: Boolean(meet),
      meet_error: meetError,
      provider: meet && meet.provider,
      google_connected: Boolean((await meetings.statusFor(req.user.id)).connected),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Pull the transcript and turn it into notes.
 *
 * Called on demand rather than automatically, because Meet artifacts are not
 * ready when the call ends — reports put it as long as 45 minutes — so a
 * button the salesperson presses when they are ready beats a background job
 * racing Google and failing quietly.
 *
 * Every unhappy path returns a plain-English reason. "Transcription was never
 * switched on" and "Google is still processing it" need completely different
 * responses from the person reading the screen.
 */
router.post("/meeting/:meetingId/fetch-notes", async (req, res, next) => {
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

    let result = await meetings.fetchTranscript(req.user.id, {
      eventId: meeting.calendar_event_id,
      meetLink: meeting.meet_link,
    });

    /*
     * Fathom as the fallback.
     *
     * The meeting provider only has a transcript when the plan allows it and
     * someone switched it on — a free Google account never does. Fathom's bot
     * records the call itself, so when the provider comes back empty we ask
     * Fathom whether it caught this one.
     *
     * Second, not first: when Teams or Meet does have the transcript it is
     * free, instant, and there is no bot sitting in the client's call.
     */
    if (result.state !== "ready" && fathom.configured()) {
      const caught = await fathomTranscriptFor(meeting);
      if (caught) result = { state: "ready", text: caught.text, source: "fathom", info: caught.info };
    }

    if (result.state !== "ready") {
      await db.run(
        `UPDATE opportunity_meetings SET transcript_state = $2, conference_record = COALESCE($3, conference_record)
          WHERE id = $1`,
        [meeting.id, result.state, result.conferenceRecord || null]
      );
      return res.json({
        state: result.state,
        message:
          (fathom.configured() && result.reason === "transcription_was_off"
            ? "Neither the meeting platform nor Fathom has a recording of this call. Check the Fathom bot was invited."
            : null) ||
          meetings.TRANSCRIPT_REASONS[result.reason] ||
          result.reason ||
          "Couldn't fetch the transcript.",
      });
    }

    // We have words. Turn them into the structured fields the rest of the
    // portal already reads — same shape as hand-typed notes, so reporting does
    // not have to care where they came from.
    const structured = await ai.structureMeetingNotes(result.text, {
      company: meeting.company,
      service: meeting.service_primary,
      plan_name: meeting.plan_name,
    });

    const summary = [
      structured.requirement ? `What they need: ${structured.requirement}` : null,
      structured.budget_mentioned ? `Budget mentioned: ${structured.budget_mentioned}` : null,
      structured.timeline ? `Timeline: ${structured.timeline}` : null,
      structured.decision_makers && structured.decision_makers.length
        ? `In the room: ${structured.decision_makers.join(", ")}`
        : null,
      structured.objections && structured.objections.length
        ? `Concerns raised: ${structured.objections.join("; ")}`
        : null,
      structured.next_step ? `Next step: ${structured.next_step}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const row = await db.one(
      `UPDATE opportunity_meetings
          SET transcript_state = 'ready',
              transcript_text = $2,
              transcript_source = COALESCE($9, transcript_source, 'provider'),
              conference_record = COALESCE($3, conference_record),
              notes = COALESCE(NULLIF(notes, ''), $4),
              outcome = COALESCE(outcome, $5),
              requirement = COALESCE(requirement, $6),
              structured = $7,
              notes_generated_at = now()
        WHERE id = $1 RETURNING *`,
      [
        meeting.id,
        result.text.slice(0, 200000),
        result.conferenceRecord || null,
        summary,
        structured.outcome || null,
        structured.requirement || null,
        JSON.stringify(structured),
        result.source || null,
      ]
    );

    res.json({
      state: "ready",
      meeting: row,
      structured,
      ai_source: structured.source,
      transcript_source: result.source || "provider",
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Forward the notes by email.
 *
 * Uses the template an admin maintains, so the wording is theirs and not
 * something buried in this file.
 */
router.post("/meeting/:meetingId/forward", async (req, res, next) => {
  try {
    const meeting = await db.one(
      `SELECT m.*, o.owner_id, o.company, o.id AS opportunity_id
         FROM opportunity_meetings m JOIN opportunities o ON o.id = m.opportunity_id
        WHERE m.id = $1`,
      [req.params.meetingId]
    );
    if (!meeting) return res.status(404).json({ error: "No such meeting." });
    if (meeting.owner_id !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Not your meeting." });
    }

    const to = String(req.body.to || "").trim();
    if (!to.includes("@")) return res.status(400).json({ error: "Who should this go to?" });

    const tpl = await db.one("SELECT body FROM content_templates WHERE key = 'meeting_notes_email'", []);
    const notes = meeting.notes || "";

    const filled = fillTemplate(
      (tpl && tpl.body) ||
        "Hi {{contact}},\n\nThanks for your time today. My notes from our conversation:\n\n{{notes}}\n\nShout if I've missed anything.\n\nBest,\n{{sender}}",
      {
        company: meeting.company,
        contact: req.body.contact_name || "there",
        date: new Date(meeting.scheduled_at).toLocaleDateString("en-IN", {
          day: "numeric", month: "long", year: "numeric",
        }),
        notes,
        sender: req.user.display_name || "Curious Media",
      }
    );

    const subject = req.body.subject || `Notes from our call — ${meeting.company}`;
    const body = req.body.body || filled;

    const result = await meetings.sendMail(req.user.id, { to, subject, body });

    if (!result.sent) {
      return res.status(400).json({
        error:
          result.reason === "not_connected"
            ? "Connect your Microsoft or Google account first — then you can send straight from here."
            : `Couldn't send it: ${result.reason}`,
        draft: { to, subject, body },
      });
    }

    await db.run(
      `UPDATE opportunity_meetings SET notes_sent_at = now(), notes_sent_to = $2 WHERE id = $1`,
      [meeting.id, to]
    );
    await db.run(
      `INSERT INTO opportunity_messages
         (opportunity_id, direction, channel, subject, body, sent_at, created_by)
       VALUES ($1, 'out', 'email', $2, $3, now(), $4)`,
      [meeting.opportunity_id, subject, body, req.user.id]
    );

    res.json({ sent: true, to });
  } catch (err) {
    next(err);
  }
});

/**
 * Did Fathom record this meeting?
 *
 * Matches on the same rules the webhook uses, so the button and the automatic
 * path can never disagree about which recording belongs to which meeting.
 */
async function fathomTranscriptFor(meeting) {
  try {
    // Fathom's own list endpoint, narrowed to the day of the meeting.
    const day = new Date(meeting.scheduled_at).toISOString().slice(0, 10);
    const res = await fetch(
      `https://api.fathom.ai/external/v1/meetings?created_after=${day}&include_transcript=true`,
      { headers: { "X-Api-Key": process.env.FATHOM_API_KEY, Accept: "application/json" } }
    );
    if (!res.ok) return null;

    const data = await res.json();
    for (const item of data.items || data.meetings || []) {
      const info = fathom.normalise(item);
      if (!info.transcript) continue;

      const match = await fathom.matchMeeting(info);
      if (match && String(match.meeting.id) === String(meeting.id)) {
        return { text: info.transcript, info };
      }
    }
    return null;
  } catch (err) {
    console.warn("[fathom] lookup failed:", err.message);
    return null;
  }
}

/**
 * Meeting notes as a PDF.
 *
 * Generated as HTML and handed to the browser to print, rather than built with
 * a PDF library. A PDF toolkit is a heavy dependency on the cold-start path —
 * the exact thing that was making the whole portal slow — and every browser
 * already has a good PDF writer built in. The page opens with the print dialog
 * up; "Save as PDF" is the default destination.
 */
router.get("/meeting/:meetingId/pdf", async (req, res, next) => {
  try {
    const m = await db.one(
      `SELECT mt.*, o.company, o.service_primary, o.plan_name, o.quoted_price,
              u.display_name AS owner_name,
              COALESCE(fc.name, cc.name)  AS contact_name,
              COALESCE(fc.role, cc.role)  AS contact_role
         FROM opportunity_meetings mt
         JOIN opportunities o ON o.id = mt.opportunity_id
         LEFT JOIN users u ON u.id = o.owner_id
         LEFT JOIN company_contacts cc ON cc.id = o.contact_id
         LEFT JOIN company_contacts fc ON fc.id = o.focus_contact_id
        WHERE mt.id = $1`,
      [req.params.meetingId]
    );
    if (!m) return res.status(404).send("No such meeting.");

    const esc = (v) =>
      String(v == null ? "" : v)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const when = new Date(m.scheduled_at).toLocaleString("en-IN", {
      day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit",
    });

    const st = m.structured || {};
    const rows = [
      ["What they need", st.requirement || m.requirement],
      ["Budget mentioned", st.budget_mentioned],
      ["Timeline", st.timeline],
      ["In the room", (st.decision_makers || []).join(", ")],
      ["Concerns raised", (st.objections || []).join("; ")],
      ["Next step", st.next_step],
    ].filter(([, v]) => v);

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html><head><meta charset="utf-8" />
<title>${esc(m.company)} — meeting notes</title>
<style>
  @page { margin: 18mm; }
  body { font: 11pt/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; max-width: 720px; margin: 0 auto; }
  h1 { font-size: 19pt; margin: 0 0 2px; }
  .sub { color: #666; font-size: 10pt; margin-bottom: 22px; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: .06em; color: #666;
       margin: 26px 0 8px; font-weight: 600; }
  dl { display: grid; grid-template-columns: 150px 1fr; gap: 5px 16px; margin: 0; }
  dt { color: #666; }
  dd { margin: 0; }
  .notes { white-space: pre-wrap; }
  footer { margin-top: 34px; padding-top: 10px; border-top: 1px solid #ddd;
           color: #888; font-size: 9pt; }
  /* Nothing on screen that shouldn't be on paper. */
  @media print { .noprint { display: none; } }
</style></head>
<body>
  <h1>${esc(m.company)}</h1>
  <p class="sub">
    Meeting notes · ${esc(when)}${m.contact_name ? ` · with ${esc(m.contact_name)}${m.contact_role ? `, ${esc(m.contact_role)}` : ""}` : ""}
  </p>

  ${rows.length ? `<h2>Summary</h2><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}

  ${m.notes ? `<h2>Notes</h2><p class="notes">${esc(m.notes)}</p>` : ""}

  <footer>
    ${esc(m.service_primary || "")}${m.plan_name ? ` · ${esc(m.plan_name)}` : ""}
    ${m.owner_name ? ` · ${esc(m.owner_name)}` : ""} · Curious Media
  </footer>

  <script>window.onload = () => window.print();</script>
</body></html>`);
  } catch (err) {
    next(err);
  }
});

/** Give a draft to look at before anything is sent. */
router.get("/meeting/:meetingId/forward-draft", async (req, res, next) => {
  try {
    const meeting = await db.one(
      `SELECT m.*, o.owner_id, o.company,
              COALESCE(fc.name, cc.name)  AS contact_name,
              COALESCE(fc.email, cc.email) AS contact_email
         FROM opportunity_meetings m
         JOIN opportunities o ON o.id = m.opportunity_id
         LEFT JOIN company_contacts cc ON cc.id = o.contact_id
         LEFT JOIN company_contacts fc ON fc.id = o.focus_contact_id
        WHERE m.id = $1`,
      [req.params.meetingId]
    );
    if (!meeting) return res.status(404).json({ error: "No such meeting." });

    const tpl = await db.one("SELECT body FROM content_templates WHERE key = 'meeting_notes_email'", []);

    res.json({
      to: meeting.contact_email || "",
      subject: `Notes from our call — ${meeting.company}`,
      body: fillTemplate(
        (tpl && tpl.body) ||
          "Hi {{contact}},\n\nThanks for your time today. My notes from our conversation:\n\n{{notes}}\n\nShout if I've missed anything.\n\nBest,\n{{sender}}",
        {
          company: meeting.company,
          contact: (meeting.contact_name || "there").split(" ")[0],
          date: new Date(meeting.scheduled_at).toLocaleDateString("en-IN", {
            day: "numeric", month: "long", year: "numeric",
          }),
          notes: meeting.notes || "(no notes yet)",
          sender: req.user.display_name || "Curious Media",
        }
      ),
    });
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
    // Deliverables come from the chosen package on the rate card now that
    // custom package building is gone.
    const plan = opp.plan_tier
      ? await pricing.planFor(opp.service_primary, opp.plan_tier)
      : null;

    const draft = await ai.draftProposal({
      ...ctx,
      deliverables: plan ? plan.deliverables : null,
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
              approval_status = CASE WHEN $3 THEN 'pending' ELSE approval_status END,
              approval_reason = CASE WHEN $3 THEN $4 ELSE approval_reason END,
              updated_at = now()
        WHERE id = $1`,
      [
        opp.id,
        req.body.price || null,
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
        error: "This price is discounted past the limit and is waiting on manager approval.",
      });
    }

    await moveStage(opp.id, to, req.user.id);
    if (to === "won") {
      // What was actually signed, which is rarely the quoted price. Falls back
      // to the quote if nobody typed a figure, so the target still moves.
      const signed = Number(req.body.closed_value);
      await db.run(
        `UPDATE opportunities
            SET closed_value = COALESCE($2, quoted_price),
                won_value    = COALESCE($2, quoted_price)
          WHERE id = $1`,
        [opp.id, Number.isFinite(signed) && signed > 0 ? signed : null]
      );
      await db.run(
        `UPDATE opportunity_followups SET status = 'cancelled'
          WHERE opportunity_id = $1 AND status = 'due'`,
        [opp.id]
      );
      await closeUnderlyingClaim(opp, "won");
      await clearDeadline(opp.id);
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

    // Questions the client asked to be compulsory. A loss record that answers
    // "budget" and nothing else tells management nothing they can act on,
    // which was the whole reason for the interview.
    const required = [
      [req.body.chose, "Say who the client went with."],
      [req.body.could_have_changed, "Say what could have changed the outcome."],
      [req.body.reapproach !== undefined && req.body.reapproach !== null && req.body.reapproach !== "",
        "Say whether we should try again."],
    ];
    for (const [value, message] of required) {
      if (!value) return res.status(400).json({ error: message });
    }

    const wantsReapproach = req.body.reapproach === true || req.body.reapproach === "yes";
    const days = [30, 60, 90].includes(Number(req.body.reapproach_days))
      ? Number(req.body.reapproach_days)
      : null;

    // "When?" is only compulsory if the answer to "should we?" was yes.
    if (wantsReapproach && !days) {
      return res.status(400).json({ error: "Say when we should try again — 30, 60 or 90 days." });
    }

    await db.tx(async (q) => {
      await q(
        `INSERT INTO opportunity_loss
           (opportunity_id, primary_reason, secondary_reason, note, chose,
            competitor_name, disliked, could_have_changed,
            reapproach, reapproach_days, reapproach_at, lost_at_stage, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                 CASE WHEN $10::int IS NULL THEN NULL ELSE CURRENT_DATE + $10::int END,
                 $11,$12)
         ON CONFLICT (opportunity_id) DO UPDATE SET
           primary_reason = EXCLUDED.primary_reason,
           secondary_reason = EXCLUDED.secondary_reason,
           note = EXCLUDED.note,
           chose = EXCLUDED.chose,
           competitor_name = EXCLUDED.competitor_name,
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
          JSON.stringify(Array.isArray(req.body.disliked) ? req.body.disliked : []),
          req.body.could_have_changed || null,
          wantsReapproach,
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
      await clearDeadline(opp.id, q);
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

/** {{placeholder}} substitution. Unknown keys are left alone rather than
 *  blanked, so a typo in a template shows up as {{copmany}} on screen instead
 *  of silently disappearing. */
function fillTemplate(text, values) {
  return String(text || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key) =>
    values[key] != null ? String(values[key]) : whole
  );
}

/* ── the execution plan ───────────────────────────────────────────────────── */

/**
 * What we actually deliver once it's won: deliverable, date, owner.
 *
 * Separate from the package because a package is what was sold and this is
 * what was promised. They drift, and being able to see the drift is the point.
 */
/** Budget and the two points of contact — they belong to the engagement,
 *  not to each deliverable line. */
router.post("/:id/delivery", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });
    if (!assertOwner(opp, req.user, res)) return;

    await db.run(
      `UPDATE opportunities
          SET delivery_budget     = $2,
              delivery_client_poc = $3,
              delivery_agency_poc = $4,
              updated_at = now()
        WHERE id = $1`,
      [
        opp.id,
        Number(req.body.budget) || null,
        req.body.client_poc || null,
        req.body.agency_poc || null,
      ]
    );

    res.json({ opportunity: await loadOpp(opp.id, req.user) });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/execution", async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT * FROM opportunity_execution WHERE opportunity_id = $1 ORDER BY sort, due_date NULLS LAST, id`,
      [req.params.id]
    );
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/execution", async (req, res, next) => {
  try {
    const opp = await loadOpp(req.params.id, req.user);
    if (!opp) return res.status(404).json({ error: "No such opportunity." });
    if (!assertOwner(opp, req.user, res)) return;

    const deliverable = String(req.body.deliverable || "").trim();
    if (!deliverable) return res.status(400).json({ error: "What's the deliverable?" });

    const row = await db.one(
      `INSERT INTO opportunity_execution
         (opportunity_id, deliverable, owner_name, owner_id, due_date, notes, sort, created_by)
       VALUES ($1, $2, $3, $4, $5, $6,
               COALESCE((SELECT MAX(sort) + 1 FROM opportunity_execution WHERE opportunity_id = $1), 0),
               $7)
       RETURNING *`,
      [
        opp.id, deliverable,
        req.body.owner_name || null,
        req.body.owner_id || null,
        req.body.due_date || null,
        req.body.notes || null,
        req.user.id,
      ]
    );
    res.json({ item: row });
  } catch (err) {
    next(err);
  }
});

router.patch("/execution/:itemId", async (req, res, next) => {
  try {
    const item = await db.one(
      `SELECT e.*, o.owner_id AS opp_owner
         FROM opportunity_execution e JOIN opportunities o ON o.id = e.opportunity_id
        WHERE e.id = $1`,
      [req.params.itemId]
    );
    if (!item) return res.status(404).json({ error: "No such item." });
    if (item.opp_owner !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Not yours to change." });
    }

    const row = await db.one(
      `UPDATE opportunity_execution
          SET deliverable = COALESCE($2, deliverable),
              owner_name  = COALESCE($3, owner_name),
              due_date    = COALESCE($4, due_date),
              status      = COALESCE($5, status),
              notes       = COALESCE($6, notes),
              updated_at  = now()
        WHERE id = $1 RETURNING *`,
      [
        item.id,
        req.body.deliverable || null,
        req.body.owner_name || null,
        req.body.due_date || null,
        ["pending", "in_progress", "done", "blocked"].includes(req.body.status) ? req.body.status : null,
        req.body.notes || null,
      ]
    );
    res.json({ item: row });
  } catch (err) {
    next(err);
  }
});

router.delete("/execution/:itemId", async (req, res, next) => {
  try {
    const item = await db.one(
      `SELECT e.id, o.owner_id AS opp_owner
         FROM opportunity_execution e JOIN opportunities o ON o.id = e.opportunity_id
        WHERE e.id = $1`,
      [req.params.itemId]
    );
    if (!item) return res.json({ ok: true });
    if (item.opp_owner !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Not yours to remove." });
    }
    await db.run("DELETE FROM opportunity_execution WHERE id = $1", [item.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ── monthly targets ──────────────────────────────────────────────────────── */

/** First day of this month, which is how a target period is keyed. */
const thisPeriod = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
};

/**
 * How this person is doing this month.
 *
 * Counts closed_value — what was actually signed — not quoted_price. The gap
 * between the two is the whole reason they are separate columns.
 */
async function targetFor(userId) {
  const period = thisPeriod();

  try {
    return await computeTarget(userId, period);
  } catch (err) {
    // Today is the screen people live on. A broken target query must not blank
    // it — the counts and the cards matter far more than the progress bar.
    console.warn("[outreach] target unavailable:", err.message);
    return { period, target: 0, achieved: 0, remaining: 0, deals: 0, pct: null };
  }
}

async function computeTarget(userId, period) {
  const [target, won] = await Promise.all([
    db.one(`SELECT amount FROM sales_targets WHERE user_id = $1 AND period = $2`, [userId, period]),
    db.one(
      `SELECT COALESCE(SUM(COALESCE(closed_value, won_value, quoted_price)), 0) AS total,
              COUNT(*)::int AS deals
         FROM opportunities
        WHERE owner_id = $1 AND stage = 'won'
          AND won_at >= $2::timestamptz
          AND won_at <  $2::timestamptz + interval '1 month'`,
      [userId, period]
    ),
  ]);

  const amount = Number(target && target.amount) || 0;
  const achieved = Number(won.total) || 0;

  return {
    period,
    target: amount,
    achieved,
    // What is left to find. Never negative — "you are 20% over" is the useful
    // reading of a beaten target, not "minus two lakh to go".
    remaining: Math.max(amount - achieved, 0),
    deals: won.deals,
    pct: amount > 0 ? Math.round((achieved / amount) * 100) : null,
  };
}

router.get("/meta/target", async (req, res, next) => {
  try {
    res.json(await targetFor(req.user.id));
  } catch (err) {
    next(err);
  }
});

/** Everyone's target for this month, for the admin screen. */
router.get("/meta/targets", requireAdmin, async (req, res, next) => {
  try {
    const period = thisPeriod();
    const rows = await db.all(
      `SELECT u.id, u.display_name,
              COALESCE(t.amount, 0) AS amount,
              COALESCE(w.total, 0)  AS achieved
         FROM users u
         LEFT JOIN sales_targets t ON t.user_id = u.id AND t.period = $1::date
         LEFT JOIN (
           SELECT owner_id, SUM(COALESCE(closed_value, won_value, quoted_price)) AS total
             FROM opportunities
            WHERE stage = 'won' AND won_at >= $1::timestamptz
              AND won_at <  $1::timestamptz + interval '1 month'
            GROUP BY owner_id
         ) w ON w.owner_id = u.id
        WHERE u.active AND u.role <> 'admin'
        ORDER BY u.display_name`,
      [period]
    );
    res.json({ period, targets: rows });
  } catch (err) {
    next(err);
  }
});

router.put("/meta/targets", requireAdmin, async (req, res, next) => {
  try {
    const period = thisPeriod();
    for (const t of Array.isArray(req.body.targets) ? req.body.targets : []) {
      if (!t.user_id) continue;
      await db.run(
        `INSERT INTO sales_targets (user_id, period, amount, set_by, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id, period) DO UPDATE
            SET amount = EXCLUDED.amount, set_by = EXCLUDED.set_by, updated_at = now()`,
        [t.user_id, period, Number(t.amount) || 0, req.user.id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ── admin: the editable templates ────────────────────────────────────────── */

router.get("/meta/templates", async (req, res, next) => {
  try {
    res.json({ templates: await db.all("SELECT * FROM content_templates ORDER BY sort, key") });
  } catch (err) {
    next(err);
  }
});

router.put("/meta/templates", requireAdmin, async (req, res, next) => {
  try {
    for (const t of Array.isArray(req.body.templates) ? req.body.templates : []) {
      if (!t.key) continue;
      await db.run(
        `UPDATE content_templates SET body = $2, updated_by = $3, updated_at = now() WHERE key = $1`,
        [t.key, t.body || "", req.user.id]
      );
    }
    res.json({ ok: true, templates: await db.all("SELECT * FROM content_templates ORDER BY sort, key") });
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

    for (const key of ["guardrail", "followup_cadence"]) {
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
