/**
 * /api/contacts — the people table behind All Leads.
 *
 * All Leads is one row per person, mirroring the source sheet, and a PERSON is
 * what gets claimed. Two reps can work two people at the same company without
 * treading on each other. A person claim carries the same 30-day clock a
 * company claim from All Leads used to; miss it and the person returns to the
 * pool rather than going to the Newspaper (that's only for Fresh Leads).
 */
const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");

const router = express.Router();
router.use(requireAuth);

const DAYS = Number(process.env.CLAIM_DAYS_ALL || 30);

/** Release every person claim whose clock has run out. */
async function sweepExpired() {
  return db.run(
    `UPDATE company_contacts
        SET owner_id = NULL, claimed_at = NULL, deadline_at = NULL,
            status = 'new'
      WHERE owner_id IS NOT NULL
        AND closed_at IS NULL
        AND deadline_at IS NOT NULL
        AND deadline_at < now()`
  );
}

function countdown(row) {
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

const SELECT = `
  SELECT cc.*,
         c.website        AS company_website,
         c.domain         AS company_domain,
         c.linkedin       AS company_linkedin,
         c.year_founded   AS company_year_founded,
         c.employees      AS company_employees,
         c.revenue        AS company_revenue,
         c.industry       AS company_industry,
         c.specialities   AS company_specialities,
         u.display_name   AS owner_name
    FROM company_contacts cc
    LEFT JOIN companies c ON lower(c.name) = lower(cc.company)
    LEFT JOIN users u ON u.id = cc.owner_id`;

/** GET /api/contacts?q=&mine=1 — every person, in sheet order. */
router.get("/", async (req, res, next) => {
  try {
    await sweepExpired();

    const where = [];
    const args = [];
    const bind = (v) => `$${args.push(v)}`;

    if (req.query.mine === "1") where.push(`cc.owner_id = ${bind(req.user.id)}`);
    if (req.query.company) where.push(`lower(cc.company) = lower(${bind(req.query.company)})`);

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
    const orderBy = sortMap[req.query.sort] || sortMap.company;

    const contacts = await db.all(
      `${SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${orderBy} LIMIT 1000`,
      args
    );

    for (const c of contacts) c.countdown = countdown(c);
    res.json({ contacts, claimDays: DAYS });
  } catch (err) {
    next(err);
  }
});

/** Claim or release one person. */
router.post("/:id/claim", async (req, res, next) => {
  try {
    const releasing = Boolean(req.body && req.body.release);

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
          [req.user.id, DAYS, req.params.id]
        );

    if (!row) return res.status(404).json({ error: "That contact no longer exists." });

    row.countdown = countdown(row);
    res.json({ contact: row });
  } catch (err) {
    next(err);
  }
});

/** Mark done — the only thing that stops the clock. */
router.post("/:id/close", async (req, res, next) => {
  try {
    const reopening = Boolean(req.body && req.body.reopen);

    const row = reopening
      ? await db.one(
          `UPDATE company_contacts
              SET closed_at = NULL, claimed_at = now(),
                  deadline_at = now() + ($1 || ' days')::interval
            WHERE id = $2 RETURNING *`,
          [DAYS, req.params.id]
        )
      : await db.one(
          `UPDATE company_contacts
              SET closed_at = now(), deadline_at = NULL, status = 'won'
            WHERE id = $1 RETURNING *`,
          [req.params.id]
        );

    if (!row) return res.status(404).json({ error: "That contact no longer exists." });

    row.countdown = countdown(row);
    res.json({ contact: row });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const status = String((req.body && req.body.status) || "").trim();
    if (!status) return res.status(400).json({ error: "Nothing to update." });

    const row = await db.one(
      "UPDATE company_contacts SET status = $1 WHERE id = $2 RETURNING *",
      [status, req.params.id]
    );
    if (!row) return res.status(404).json({ error: "That contact no longer exists." });

    row.countdown = countdown(row);
    res.json({ contact: row });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.sweepExpired = sweepExpired;
