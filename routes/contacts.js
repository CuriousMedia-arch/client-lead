/**
 * /api/contacts - the people directory.
 *
 * Lives in the same Supabase database as everything else now, so this is a
 * plain SQL table rather than a REST call.
 */
const express = require("express");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../lib/auth");

const router = express.Router();
router.use(requireAuth);

// GET /api/contacts?company=Meesho
router.get("/", async (req, res, next) => {
  try {
    const company = String(req.query.company || "").trim();
    if (!company) return res.status(400).json({ error: "Which company?" });

    const contacts = await db.all(
      `SELECT id, name, role, email, phone, phone2, linkedin, notes, is_primary
         FROM company_contacts
        WHERE lower(company) = lower($1)
        ORDER BY is_primary DESC, name ASC`,
      [company]
    );

    res.json({ configured: true, contacts });
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts  { company, name, role, email, phone }
router.post("/", async (req, res, next) => {
  try {
    const b = req.body || {};
    const company = String(b.company || "").trim();
    const name = String(b.name || "").trim();
    if (!company || !name)
      return res.status(400).json({ error: "A company and a name are the minimum." });

    const clean = (v) => (String(v || "").trim() || null);

    const contact = await db.one(
      `INSERT INTO company_contacts (company, name, role, email, phone, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (lower(company), lower(name)) DO UPDATE
          SET role       = COALESCE(EXCLUDED.role, company_contacts.role),
              email      = COALESCE(EXCLUDED.email, company_contacts.email),
              phone      = COALESCE(EXCLUDED.phone, company_contacts.phone),
              is_primary = EXCLUDED.is_primary
       RETURNING id, name, role, email, phone, phone2, linkedin, notes, is_primary`,
      [company, name, clean(b.role), clean(b.email), clean(b.phone), Boolean(b.is_primary)]
    );

    res.json({ contact });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/contacts/:id
router.delete("/:id", async (req, res, next) => {
  try {
    await db.run("DELETE FROM company_contacts WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── All Leads: the people table ────────────────────────────────────────────
//
// All Leads is one row per person now, so a CONTACT is what gets claimed
// there — same 30-day window an All Leads company claim carried. Two reps can
// work two people at one company without treading on each other. An expired
// person claim returns to the pool; only Fresh Leads claims go to the
// Newspaper, and those live on the lead, untouched by any of this.

const CLAIM_DAYS = Number(process.env.CLAIM_DAYS_ALL || 30);

/** Release every person claim whose clock has run out. */
function sweepExpiredContacts() {
  return db.run(
    `UPDATE company_contacts
        SET owner_id = NULL, claimed_at = NULL, deadline_at = NULL, status = 'new'
      WHERE owner_id IS NOT NULL
        AND closed_at IS NULL
        AND deadline_at IS NOT NULL
        AND deadline_at < now()`
  );
}

function contactCountdown(row) {
  if (!row || !row.deadline_at || row.closed_at) return null;

  const msLeft = new Date(row.deadline_at).getTime() - Date.now();
  if (msLeft <= 0) return { label: "Overdue", days: 0, urgent: true, overdue: true };

  const days = Math.floor(msLeft / 86400000);
  const hours = Math.floor((msLeft % 86400000) / 3600000);
  return {
    label: days >= 1 ? `${days}d ${hours}h left` : `${hours}h left`,
    days,
    urgent: days < 3,
    overdue: false,
  };
}

const PEOPLE_SELECT = `
  SELECT cc.*,
         c.website      AS company_website,
         c.domain       AS company_domain,
         c.linkedin     AS company_linkedin,
         c.founded      AS company_founded,
         c.employees    AS company_employees,
         c.revenue      AS company_revenue,
         c.industry     AS company_industry,
         c.specialities AS company_specialities,
         u.display_name AS owner_name
    FROM company_contacts cc
    LEFT JOIN companies c ON lower(c.name) = lower(cc.company)
    LEFT JOIN users u ON u.id = cc.owner_id`;

/** GET /api/contacts/people?q=&mine=1&sort= */
router.get("/people", async (req, res, next) => {
  try {
    await sweepExpiredContacts();

    const where = [];
    const args = [];
    const bind = (v) => `$${args.push(v)}`;

    if (req.query.mine === "1") where.push(`cc.owner_id = ${bind(req.user.id)}`);
    if (req.query.q) {
      const q = bind(`%${String(req.query.q).toLowerCase()}%`);
      where.push(
        `(LOWER(cc.name) LIKE ${q} OR LOWER(cc.company) LIKE ${q} OR LOWER(COALESCE(cc.role,'')) LIKE ${q})`
      );
    }

    const sortMap = {
      name: "LOWER(cc.name) ASC",
      company: "LOWER(cc.company) ASC, cc.is_primary DESC, LOWER(cc.name) ASC",
      urgent: "cc.deadline_at ASC NULLS LAST, LOWER(cc.name) ASC",
    };

    const contacts = await db.all(
      `${PEOPLE_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY ${sortMap[req.query.sort] || sortMap.company} LIMIT 1000`,
      args
    );

    for (const c of contacts) c.countdown = contactCountdown(c);
    res.json({ contacts, claimDays: CLAIM_DAYS });
  } catch (err) {
    next(err);
  }
});

/** Claim or release one person. */
router.post("/:id/claim", async (req, res, next) => {
  try {
    const releasing = Boolean(req.body && req.body.release);

    // A claim locks the person. Nobody but the owner can touch it — no silent
    // take-overs — except an admin, who can always hand a lead back so it
    // doesn't get stranded when someone leaves or goes on holiday.
    const current = await db.one("SELECT owner_id FROM company_contacts WHERE id = $1", [
      req.params.id,
    ]);
    if (!current) return res.status(404).json({ error: "That contact no longer exists." });

    const isAdmin = req.user.role === "admin";
    const isOwner = current.owner_id === req.user.id;

    // Check the release case first: refusing it as "already claimed" would be
    // technically true but answers a question nobody asked.
    if (releasing && !isOwner && !isAdmin) {
      return res.status(403).json({ error: "Only the owner can release this contact." });
    }
    if (!releasing && current.owner_id && !isOwner && !isAdmin) {
      return res.status(409).json({
        error: "Someone else is already working this contact.",
      });
    }

    const row = releasing
      ? await db.one(
          `UPDATE company_contacts
              SET owner_id = NULL, claimed_at = NULL, deadline_at = NULL, status = 'new'
            WHERE id = $1 RETURNING *`,
          [req.params.id]
        )
      : await db.one(
          `UPDATE company_contacts
              SET owner_id = $1, claimed_at = now(),
                  deadline_at = now() + ($2 || ' days')::interval,
                  closed_at = NULL,
                  status = CASE WHEN status = 'new' THEN 'working' ELSE status END
            WHERE id = $3 RETURNING *`,
          [req.user.id, CLAIM_DAYS, req.params.id]
        );

    if (!row) return res.status(404).json({ error: "That contact no longer exists." });

    row.countdown = contactCountdown(row);
    res.json({ contact: row });
  } catch (err) {
    next(err);
  }
});

/** Close stops the clock; reopen restarts it. */
router.post("/:id/close", async (req, res, next) => {
  try {
    const reopening = Boolean(req.body && req.body.reopen);

    const current = await db.one("SELECT owner_id FROM company_contacts WHERE id = $1", [
      req.params.id,
    ]);
    if (!current) return res.status(404).json({ error: "That contact no longer exists." });

    if (current.owner_id !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the owner can close this contact." });
    }

    const row = reopening
      ? await db.one(
          `UPDATE company_contacts
              SET closed_at = NULL, claimed_at = now(),
                  deadline_at = now() + ($1 || ' days')::interval
            WHERE id = $2 RETURNING *`,
          [CLAIM_DAYS, req.params.id]
        )
      : await db.one(
          `UPDATE company_contacts
              SET closed_at = now(), deadline_at = NULL, status = 'won'
            WHERE id = $1 RETURNING *`,
          [req.params.id]
        );

    if (!row) return res.status(404).json({ error: "That contact no longer exists." });

    row.countdown = contactCountdown(row);
    res.json({ contact: row });
  } catch (err) {
    next(err);
  }
});

/* ── Progress log ───────────────────────────────────────────────────────────
 *
 * What was said, when, and by whom. Only the owner writes to it (or an admin),
 * because a log anyone can edit stops being a record of what happened.
 */

const KINDS = ["note", "call", "email", "linkedin", "meeting"];
const STAGES = ["new", "working", "contacted", "replied", "qualified", "won", "lost"];

router.get("/people/:id/activity", async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT a.id, a.kind, a.body, a.stage, a.created_at, u.display_name AS user_name
         FROM contact_activity a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.contact_id = $1
        ORDER BY a.created_at DESC`,
      [req.params.id]
    );
    res.json({ activity: rows });
  } catch (err) {
    next(err);
  }
});

router.post("/people/:id/activity", async (req, res, next) => {
  try {
    const contact = await db.one(
      "SELECT owner_id, status FROM company_contacts WHERE id = $1",
      [req.params.id]
    );
    if (!contact) return res.status(404).json({ error: "That contact no longer exists." });

    if (contact.owner_id !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the owner can log progress on this contact." });
    }

    const body = String((req.body && req.body.body) || "").trim();
    if (!body) return res.status(400).json({ error: "Write what was discussed before saving." });

    const kind = KINDS.includes(req.body && req.body.kind) ? req.body.kind : "note";
    const stage = STAGES.includes(req.body && req.body.stage) ? req.body.stage : null;

    await db.run(
      "INSERT INTO contact_activity (contact_id, user_id, kind, body, stage) VALUES ($1,$2,$3,$4,$5)",
      [req.params.id, req.user.id, kind, body, stage]
    );

    // Logging a real conversation moves the contact along, so the stage on the
    // card matches the last thing that actually happened.
    if (stage) {
      await db.run("UPDATE company_contacts SET status = $1 WHERE id = $2", [stage, req.params.id]);
    } else if (kind !== "note" && contact.status === "new") {
      await db.run("UPDATE company_contacts SET status = 'contacted' WHERE id = $1", [req.params.id]);
    }

    const [activity, fresh] = await Promise.all([
      db.all(
        `SELECT a.id, a.kind, a.body, a.stage, a.created_at, u.display_name AS user_name
           FROM contact_activity a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.contact_id = $1 ORDER BY a.created_at DESC`,
        [req.params.id]
      ),
      db.one("SELECT * FROM company_contacts WHERE id = $1", [req.params.id]),
    ]);

    fresh.countdown = contactCountdown(fresh);
    res.json({ activity, contact: fresh });
  } catch (err) {
    next(err);
  }
});

/**
 * Editing a row is admin-only. Everyone else reads the database; only an admin
 * corrects it, so a typo fixed in one place stays fixed for the whole team.
 */
const EDITABLE = [
  "name", "role", "email", "email_alt", "phone", "phone2",
  "linkedin", "seniority", "department", "city", "country", "state", "company",
];

router.patch("/people/:id", requireAdmin, async (req, res, next) => {
  try {
    const sets = [];
    const args = [];
    const bind = (v) => `$${args.push(v)}`;

    for (const field of EDITABLE) {
      if (req.body[field] === undefined) continue;
      const value = String(req.body[field] || "").trim() || null;
      if (field === "name" && !value) {
        return res.status(400).json({ error: "A contact needs a name." });
      }
      sets.push(`${field} = ${bind(value)}`);
    }

    if (!sets.length) return res.status(400).json({ error: "Nothing to change." });

    const row = await db.one(
      `UPDATE company_contacts SET ${sets.join(", ")} WHERE id = ${bind(req.params.id)} RETURNING *`,
      args
    );
    if (!row) return res.status(404).json({ error: "That contact no longer exists." });

    row.countdown = contactCountdown(row);
    res.json({ contact: row });
  } catch (err) {
    // The unique index means two people at one company can't share a name.
    if (err.code === "23505") {
      return res.status(409).json({ error: "That company already has someone with this name." });
    }
    next(err);
  }
});

router.delete("/people/:id", requireAdmin, async (req, res, next) => {
  try {
    const removed = await db.run("DELETE FROM company_contacts WHERE id = $1", [req.params.id]);
    if (!removed) return res.status(404).json({ error: "That contact no longer exists." });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.sweepExpiredContacts = sweepExpiredContacts;
