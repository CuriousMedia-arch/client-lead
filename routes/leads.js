const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");

const router = express.Router();
router.use(requireAuth);

const STATUSES = ["new", "working", "contacted", "replied", "qualified", "won", "lost"];
const OPEN_STATUSES = ["working", "contacted", "replied", "qualified"];
const CONTACT_KINDS = ["email", "call", "linkedin", "meeting"];

// Whitelisted so a query string can never inject an interval.
const FRESHNESS = { "24h": "1 day", "48h": "2 days", "7d": "7 days", "30d": "30 days" };

const list = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * The one query that powers Today's Leads, All Leads and My Outreach.
 * Everything is a WHERE clause on the same shape, so the tabs stay consistent.
 *
 * Postgres takes positional parameters, so bind() appends a value and hands
 * back the $n placeholder to drop into the SQL.
 */
async function queryLeads(params, user) {
  const where = [];
  const args = [];
  const bind = (v) => `$${args.push(v)}`;

  // --- which pool -------------------------------------------------------------
  //   today -> companies the sweep found in the news that aren't ours yet.
  //            Claimable straight away; they join All Leads once approved.
  //   all   -> the watchlist: everything imported from the CSV, plus every
  //            discovered company that has been approved.
  //   mine  -> whatever this user owns, from either pool.
  const tab = params.tab || "all";
  const freshness = FRESHNESS[params.freshness];

  if (tab === "today") where.push("c.approval = 'pending'");
  else if (tab === "mine") {
    where.push(`l.owner_id = ${bind(user.id)}`);
    where.push("c.approval <> 'rejected'");
  } else where.push("c.approval = 'approved'");

  if (freshness) {
    where.push(
      `EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id
                AND COALESCE(s.published, s.created_at) >= now() - interval '${freshness}')`
    );
  }

  // --- signal type -----------------------------------------------------------
  const types = list(params.types);
  if (types.length) {
    where.push(
      `EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id
                AND s.signal_type = ANY(${bind(types)}))`
    );
  }

  // --- status ----------------------------------------------------------------
  const statuses = list(params.status).filter((s) => STATUSES.includes(s));
  if (statuses.length) where.push(`l.status = ANY(${bind(statuses)})`);

  // --- outreach hygiene ------------------------------------------------------
  for (const flag of list(params.hygiene)) {
    switch (flag) {
      case "stale30":
        where.push(
          "(l.last_contacted_at IS NULL OR l.last_contacted_at < now() - interval '30 days')"
        );
        break;
      case "unclaimed":
        where.push("l.owner_id IS NULL");
        break;
      case "mine":
        where.push(`l.owner_id = ${bind(user.id)}`);
        break;
      case "followup":
        where.push("(l.next_followup_at IS NOT NULL AND l.next_followup_at <= current_date)");
        break;
      case "hascontact":
        where.push("(l.contact_email IS NOT NULL AND l.contact_email <> '')");
        break;
    }
  }

  // --- search ----------------------------------------------------------------
  if (params.q) {
    const q = bind(`%${String(params.q).toLowerCase()}%`);
    where.push(`(LOWER(c.name) LIKE ${q} OR LOWER(COALESCE(l.contact_name,'')) LIKE ${q})`);
  }

  const sortMap = {
    score: "l.score DESC, l.last_signal_at DESC NULLS LAST",
    recent: "l.last_signal_at DESC NULLS LAST, l.score DESC",
    company: "LOWER(c.name) ASC",
    followup: "l.next_followup_at ASC NULLS LAST",
  };
  const orderBy = sortMap[params.sort] || sortMap.score;

  const leads = await db.all(
    `SELECT l.id, l.status, l.owner_id, l.contact_name, l.contact_role,
            l.contact_email, l.contact_phone, l.last_contacted_at,
            l.next_followup_at, l.last_signal_at, l.score,
            c.name AS company, c.id AS company_id, c.origin, c.approval,
            u.display_name AS owner_name,
            (SELECT COUNT(*) FROM signals s WHERE s.lead_id = l.id) AS signal_count,
            (SELECT COUNT(*) FROM signals s WHERE s.lead_id = l.id
               AND s.created_at >= now() - interval '1 day') AS new_count,
            (SELECT COUNT(*) FROM activity a WHERE a.lead_id = l.id) AS activity_count
       FROM leads l
       JOIN companies c ON c.id = l.company_id
       LEFT JOIN users u ON u.id = l.owner_id
      ${where.length ? "WHERE " + where.join("\n        AND ") : ""}
      ORDER BY ${orderBy}
      LIMIT 300`,
    args
  );

  if (!leads.length) return leads;

  // Attach the three most useful signals per lead for the card preview.
  // One query for the whole page rather than one per lead - on a serverless
  // connection every extra round trip is real latency.
  const ranked = await db.all(
    `SELECT * FROM (
       SELECT s.id, s.lead_id, s.title, s.url, s.site, s.published, s.created_at,
              s.signal_type, s.score, s.summary, s.why_it_matters,
              ROW_NUMBER() OVER (
                PARTITION BY s.lead_id
                ORDER BY s.score DESC, COALESCE(s.published, s.created_at) DESC
              ) AS rn
         FROM signals s
        WHERE s.lead_id = ANY($1)
     ) t WHERE t.rn <= 3`,
    [leads.map((l) => l.id)]
  );

  const byLead = new Map();
  for (const s of ranked) {
    if (!byLead.has(s.lead_id)) byLead.set(s.lead_id, []);
    byLead.get(s.lead_id).push(s);
  }
  for (const lead of leads) lead.signals = byLead.get(lead.id) || [];

  return leads;
}

router.get("/", async (req, res, next) => {
  try {
    res.json({ leads: await queryLeads(req.query, req.user) });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const lead = await db.one(
      `SELECT l.*, c.name AS company, c.keywords, c.origin, c.approval,
              u.display_name AS owner_name
         FROM leads l
         JOIN companies c ON c.id = l.company_id
         LEFT JOIN users u ON u.id = l.owner_id
        WHERE l.id = $1`,
      [req.params.id]
    );

    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const [signals, activity] = await Promise.all([
      db.all(
        `SELECT id, title, url, author, site, section_title, published, created_at,
                signal_type, score, summary, why_it_matters, enriched
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
    ]);

    lead.signals = signals;
    lead.activity = activity;
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
    const changes = {};

    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status))
        return res.status(400).json({ error: `Unknown status "${b.status}".` });
      changes.status = b.status;
      sets.push(`status = ${bind(b.status)}`);
    }

    if (b.owner_id !== undefined) {
      changes.owner_id = b.owner_id === null || b.owner_id === "" ? null : Number(b.owner_id);
      sets.push(`owner_id = ${bind(changes.owner_id)}`);
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

    // Log the moves worth remembering.
    if (changes.status && changes.status !== lead.status) {
      await logActivity(
        lead.id,
        req.user.id,
        "status",
        `Moved from ${lead.status} to ${changes.status}`
      );
    }
    if (changes.owner_id !== undefined && changes.owner_id !== lead.owner_id) {
      const who = changes.owner_id
        ? await db.one("SELECT display_name FROM users WHERE id = $1", [changes.owner_id])
        : null;
      await logActivity(
        lead.id,
        req.user.id,
        "claim",
        who ? `Assigned to ${who.display_name}` : "Released back to the pool"
      );
    }

    res.json({ lead: updated });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/claim", async (req, res, next) => {
  try {
    const lead = await db.one("SELECT * FROM leads WHERE id = $1", [req.params.id]);
    if (!lead) return res.status(404).json({ error: "That lead no longer exists." });

    const release = Boolean(req.body && req.body.release);
    const ownerId = release ? null : req.user.id;

    const updated = await db.one(
      `UPDATE leads
          SET owner_id = $1,
              status = CASE WHEN $1::bigint IS NULL THEN status
                            WHEN status = 'new' THEN 'working'
                            ELSE status END,
              updated_at = now()
        WHERE id = $2 RETURNING *`,
      [ownerId, lead.id]
    );

    await logActivity(
      lead.id,
      req.user.id,
      "claim",
      release ? "Released back to the pool" : "Claimed this lead"
    );
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

    // Logging a real touch updates the outreach clock and nudges the status forward.
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

    res.json({ lead: fresh, activity });
  } catch (err) {
    next(err);
  }
});

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
