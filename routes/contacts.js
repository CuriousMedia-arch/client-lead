/**
 * /api/contacts - the people directory.
 *
 * Lives in the same Supabase database as everything else now, so this is a
 * plain SQL table rather than a REST call.
 */
const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");

const router = express.Router();
router.use(requireAuth);

// GET /api/contacts?company=Meesho
router.get("/", async (req, res, next) => {
  try {
    const company = String(req.query.company || "").trim();
    if (!company) return res.status(400).json({ error: "Which company?" });

    const contacts = await db.all(
      `SELECT id, name, role, email, phone, linkedin, notes, is_primary
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
       RETURNING id, name, role, email, phone, linkedin, notes, is_primary`,
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

module.exports = router;
