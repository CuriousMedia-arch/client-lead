const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const playbook = require("../lib/triggers");
const lifecycle = require("../lib/lifecycle");

const router = express.Router();
router.use(requireAuth);

const STATUSES = ["new", "working", "contacted", "replied", "qualified", "won", "lost"];
const OPEN_STATUSES = ["working", "contacted", "replied", "qualified"];
const CONTACT_KINDS = ["email", "call", "linkedin", "meeting"];

// How recent a signal must be to put a company in Fresh Leads.
const FRESH_DAYS = Number(process.env.FRESH_WINDOW_DAYS || 3);

const list = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * The four views are all the same query with a different WHERE.
 *
 *   all       - the contact database. Every company, no signals shown.
 *   fresh     - companies from that database with news in the last few days.
 *   mine      - what this user has claimed, with its countdown.
 *   newspaper - the parking lot: Fresh claims that ran out of time.
 */
async function queryLeads(params, user) {
  const tab = params.tab || "all";
  const where = [];
  const args = [];
  const bind = (v) => `$${args.push(v)}`;

  if (tab === "fresh") {
    where.push("l.pool = 'all'");
    where.push(
      `EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id
                AND COALESCE(s.published, s.created_at) >= now() - interval '${FRESH_DAYS} days')`
    );
  } else if (tab === "mine") {
    where.push(`l.owner_id = ${bind(user.id)}`);
  } else if (tab === "newspaper") {
    where.push("l.pool = 'newspaper'");
  } else {
    where.push("l.pool = 'all'");
  }

  const types = list(params.types);
  if (types.length) {
    where.push(
      `EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id
                AND s.signal_type = ANY(${bind(types)}))`
    );
  }

  const statuses = list(params.status).filter((s) => STATUSES.includes(s));
  if (statuses.length) where.push(`l.status = ANY(${bind(statuses)})`);

  if (params.q) {
    const q = bind(`%${String(params.q).toLowerCase()}%`);
    where.push(`(LOWER(c.name) LIKE ${q} OR LOWER(COALESCE(c.industry,'')) LIKE ${q})`);
  }

  if (params.tier) {
    // Tier is derived from the trigger, so filter on the trigger types it covers.
    const ids = playbook.SEGMENTS.filter((s) => String(s.tier) === String(params.tier)).map(
      (s) => s.id
    );
    if (ids.length) {
      where.push(
        `EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id AND s.signal_type = ANY(${bind(ids)}))`
      );
    }
  }

  const sortMap = {
    urgent: "l.deadline_at ASC NULLS LAST, LOWER(c.name) ASC",
    recent: "l.last_signal_at DESC NULLS LAST, LOWER(c.name) ASC",
    company: "LOWER(c.name) ASC",
    added: "c.created_at DESC, LOWER(c.name) ASC",
  };
  const orderBy = sortMap[params.sort] || (tab === "mine" ? sortMap.urgent : sortMap.company);

  const leads = await db.all(
    `SELECT l.id, l.status, l.owner_id, l.pool,
            l.claimed_at, l.claim_source, l.deadline_at, l.closed_at,
            l.contact_name, l.contact_role, l.contact_email, l.contact_phone,
            l.last_contacted_at, l.next_followup_at, l.last_signal_at,
            c.name AS company, c.id AS company_id,
            c.domain, c.website, c.linkedin, c.industry, c.employees, c.revenue,
            c.created_at AS added_at,
            u.display_name AS owner_name,
            (SELECT COUNT(*) FROM signals s WHERE s.lead_id = l.id) AS signal_count,
            (SELECT COUNT(*) FROM signals s WHERE s.lead_id = l.id
               AND COALESCE(s.published, s.created_at) >= now() - interval '${FRESH_DAYS} days') AS fresh_count,
            (SELECT COUNT(*) FROM company_contacts cc
              WHERE lower(cc.company) = lower(c.name)) AS contact_count
       FROM leads l
       JOIN companies c ON c.id = l.company_id
       LEFT JOIN users u ON u.id = l.owner_id
      ${where.length ? "WHERE " + where.join("\n        AND ") : ""}
      ORDER BY ${orderBy}
      LIMIT 400`,
    args
  );

  if (!leads.length) return leads;

  // All Leads is a database view — no signals, no pitch. Everywhere else gets
  // the news that justifies the lead.
  if (tab !== "all") await attachSignals(leads);

  for (const lead of leads) {
    lead.countdown = lifecycle.countdown(lead);
    lead.claim_window = lead.claim_source ? lifecycle.windowFor(lead.claim_source) : null;
  }

  return leads;
}

/** Recent signals per lead, newest first, plus the tier they imply. */
async function attachSignals(leads) {
  const rows = await db.all(
    `SELECT * FROM (
       SELECT s.id, s.lead_id, s.title, s.url, s.site, s.published, s.created_at,
              s.signal_type, s.summary, s.why_it_matters, s.pitch,
              ROW_NUMBER() OVER (
                PARTITION BY s.lead_id
                ORDER BY COALESCE(s.published, s.created_at) DESC
              ) AS rn
         FROM signals s
        WHERE s.lead_id = ANY($1)
     ) t WHERE t.rn <= 8`,
    [leads.map((l) => l.id)]
  );

  const byLead = new Map();
  for (const s of rows) {
    if (!byLead.has(s.lead_id)) byLead.set(s.lead_id, []);
    byLead.get(s.lead_id).push(s);
  }

  for (const lead of leads) {
    const signals = byLead.get(lead.id) || [];
    lead.signals = signals;

    // The strongest trigger present decides the tier — no numeric score.
    const best = signals
      .slice()
      .sort((a, b) => playbook.tierOf(a.signal_type) - playbook.tierOf(b.signal_type))[0];

    const seg = playbook.segment(best && best.signal_type);
    lead.tier = seg.tier;
    lead.tier_label = playbook.TIERS[seg.tier].label;
    lead.tier_note = playbook.TIERS[seg.tier].note;
    lead.segment_label = seg.label;
    lead.angle = seg.angle;
    lead.next_action = seg.action;
    lead.pitch =
      (best && best.pitch && best.pitch.trim()) ||
      playbook.composePitch({
        company: lead.company,
        signalType: best && best.signal_type,
        headline: best && best.title,
        when: best ? timeAgo(best.published || best.created_at) : null,
        industry: lead.industry,
      });
    lead.pitch_is_tailored = Boolean(best && best.pitch && best.pitch.trim());
  }
}

router.get("/", async (req, res, next) => {
  try {
    // Always settle expired claims before answering, so nobody sees a lead as
    // owned when its clock ran out an hour ago.
    await lifecycle.sweepExpired();
    res.json({ leads: await queryLeads(req.query, req.user) });
  } catch (err) {
    next(err);
  }
});

/** The people behind one company — All Leads expands into this. */
router.get("/:id/contacts", async (req, res, next) => {
  try {
    const lead = await db.one(
      `SELECT c.name FROM leads l JOIN companies c ON c.id = l.company_id WHERE l.id = $1`,
      [req.params.id]
    );
    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const contacts = await db.all(
      `SELECT id, name, role, email, phone, linkedin, seniority, department, city, is_primary
         FROM company_contacts
        WHERE lower(company) = lower($1)
        ORDER BY is_primary DESC, name ASC`,
      [lead.name]
    );

    res.json({ contacts });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    await lifecycle.sweepExpired();

    const lead = await db.one(
      `SELECT l.*, c.name AS company, c.keywords,
              c.domain, c.website, c.linkedin, c.industry, c.employees, c.revenue,
              c.created_at AS added_at, u.display_name AS owner_name
         FROM leads l
         JOIN companies c ON c.id = l.company_id
         LEFT JOIN users u ON u.id = l.owner_id
        WHERE l.id = $1`,
      [req.params.id]
    );

    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const [signals, activity, contacts] = await Promise.all([
      db.all(
        `SELECT id, title, url, author, site, section_title, published, created_at,
                signal_type, summary, why_it_matters, pitch
           FROM signals WHERE lead_id = $1
          ORDER BY COALESCE(published, created_at) DESC`,
        [lead.id]
      ),
      db.all(
        `SELECT a.id, a.kind, a.body, a.created_at, u.display_name AS user_name
           FROM activity a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.lead_id = $1 ORDER BY a.created_at DESC`,
        [lead.id]
      ),
      db.all(
        `SELECT id, name, role, email, phone, linkedin, seniority, department, city, is_primary
           FROM company_contacts WHERE lower(company) = lower($1)
          ORDER BY is_primary DESC, name ASC`,
        [lead.company]
      ),
    ]);

    lead.signals = signals;
    lead.activity = activity;
    lead.contacts = contacts;
    lead.countdown = lifecycle.countdown(lead);
    lead.claim_window = lead.claim_source ? lifecycle.windowFor(lead.claim_source) : null;

    const best = signals
      .slice()
      .sort((a, b) => playbook.tierOf(a.signal_type) - playbook.tierOf(b.signal_type))[0];
    const seg = playbook.segment(best && best.signal_type);
    lead.tier = seg.tier;
    lead.tier_label = playbook.TIERS[seg.tier].label;
    lead.tier_note = playbook.TIERS[seg.tier].note;
    lead.segment_label = seg.label;
    lead.angle = seg.angle;
    lead.next_action = seg.action;
    lead.pitch =
      (best && best.pitch && best.pitch.trim()) ||
      playbook.composePitch({
        company: lead.company,
        signalType: best && best.signal_type,
        headline: best && best.title,
        when: best ? timeAgo(best.published || best.created_at) : null,
        industry: lead.industry,
      });
    lead.pitch_is_tailored = Boolean(best && best.pitch && best.pitch.trim());

    res.json({ lead });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const lead = await db.one("SELECT * FROM leads WHERE id = $1", [req.params.id]);
    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const b = req.body || {};
    const sets = [];
    const args = [];
    const bind = (v) => `$${args.push(v)}`;

    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status))
        return res.status(400).json({ error: `Unknown status "${b.status}".` });
      sets.push(`status = ${bind(b.status)}`);
    }

    if (b.owner_id !== undefined) {
      sets.push(`owner_id = ${bind(b.owner_id === null || b.owner_id === "" ? null : Number(b.owner_id))}`);
    }

    for (const key of ["contact_name", "contact_role", "contact_email", "contact_phone"]) {
      if (b[key] !== undefined) sets.push(`${key} = ${bind(b[key] ? String(b[key]).trim() : null)}`);
    }

    if (b.next_followup_at !== undefined)
      sets.push(`next_followup_at = ${bind(b.next_followup_at || null)}`);

    if (!sets.length) return res.json({ lead });

    const updated = await db.one(
      `UPDATE leads SET ${sets.join(", ")}, updated_at = now()
        WHERE id = ${bind(lead.id)} RETURNING *`,
      args
    );

    if (b.status && b.status !== lead.status) {
      await logActivity(lead.id, req.user.id, "status", `Moved from ${lead.status} to ${b.status}`);
    }

    updated.countdown = lifecycle.countdown(updated);
    res.json({ lead: updated });
  } catch (err) {
    next(err);
  }
});

/** Claim. `source` decides the deadline: 10 days from Fresh, 30 from All. */
router.post("/:id/claim", async (req, res, next) => {
  try {
    const lead = await db.one("SELECT * FROM leads WHERE id = $1", [req.params.id]);
    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    if (req.body && req.body.release) {
      const released = await lifecycle.release(lead.id);
      await logActivity(lead.id, req.user.id, "claim", "Released back to the pool");
      released.countdown = null;
      return res.json({ lead: released });
    }

    const source = req.body && req.body.source === "fresh" ? "fresh" : "all";
    const claimed = await lifecycle.claim(lead.id, req.user.id, source);

    await logActivity(
      lead.id,
      req.user.id,
      "claim",
      `Claimed from ${source === "fresh" ? "Fresh Leads" : "All Leads"} — ${lifecycle.windowFor(
        source
      )} days to close`
    );

    claimed.countdown = lifecycle.countdown(claimed);
    res.json({ lead: claimed });
  } catch (err) {
    next(err);
  }
});

/** Close stops the clock. Reopen restarts it. */
router.post("/:id/close", async (req, res, next) => {
  try {
    const lead = await db.one("SELECT * FROM leads WHERE id = $1", [req.params.id]);
    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const reopening = Boolean(req.body && req.body.reopen);
    const updated = reopening
      ? await lifecycle.reopen(lead.id, lead.claim_source || "all")
      : await lifecycle.close(lead.id);

    await logActivity(
      lead.id,
      req.user.id,
      "status",
      reopening ? "Reopened — clock restarted" : "Marked closed"
    );

    updated.countdown = lifecycle.countdown(updated);
    res.json({ lead: updated });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/activity", async (req, res, next) => {
  try {
    const lead = await db.one("SELECT * FROM leads WHERE id = $1", [req.params.id]);
    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const kind = String((req.body && req.body.kind) || "note");
    const body = String((req.body && req.body.body) || "").trim();
    if (!body) return res.status(400).json({ error: "Write something before logging it." });

    await logActivity(lead.id, req.user.id, kind, body);

    if (CONTACT_KINDS.includes(kind)) {
      await db.run(
        `UPDATE leads
            SET last_contacted_at = now(),
                status = CASE WHEN status IN ('new','working') THEN 'contacted' ELSE status END,
                owner_id = COALESCE(owner_id, $1),
                updated_at = now()
          WHERE id = $2`,
        [req.user.id, lead.id]
      );
    }

    if (req.body && req.body.next_followup_at !== undefined) {
      await db.run("UPDATE leads SET next_followup_at = $1 WHERE id = $2", [
        req.body.next_followup_at || null,
        lead.id,
      ]);
    }

    const [fresh, activity] = await Promise.all([
      db.one("SELECT * FROM leads WHERE id = $1", [lead.id]),
      db.all(
        `SELECT a.id, a.kind, a.body, a.created_at, u.display_name AS user_name
           FROM activity a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.lead_id = $1 ORDER BY a.created_at DESC`,
        [lead.id]
      ),
    ]);

    fresh.countdown = lifecycle.countdown(fresh);
    res.json({ lead: fresh, activity });
  } catch (err) {
    next(err);
  }
});

function timeAgo(iso) {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return null;
  if (mins < 60) return "today";
  const hours = Math.round(mins / 60);
  if (hours < 24) return "today";
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? "last month" : `${months} months ago`;
}

function logActivity(leadId, userId, kind, body) {
  return db.run("INSERT INTO activity (lead_id, user_id, kind, body) VALUES ($1, $2, $3, $4)", [
    leadId,
    userId,
    kind,
    body,
  ]);
}

module.exports = router;
module.exports.STATUSES = STATUSES;
module.exports.OPEN_STATUSES = OPEN_STATUSES;
