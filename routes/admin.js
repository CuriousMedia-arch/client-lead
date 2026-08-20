const express = require("express");
const db = require("../db");
const { requireAuth, requireAdmin, hashPassword } = require("../lib/auth");
const { runPipeline, isRunning, runState, buildQueries, ensureLead } = require("../services/pipeline");
const { triggerRemoteRun, remoteRunConfigured } = require("../lib/remoteRun");
const { parseContactSheet } = require("../lib/csvImport");
const gemini = require("../lib/gemini");

const router = express.Router();

// Everyone signed in can see the team roster (needed for the assignee dropdown).
router.get("/users", requireAuth, async (req, res, next) => {
  try {
    res.json({
      users: await db.all(
        `SELECT id, username, display_name, role, active, created_at
           FROM users ORDER BY display_name`
      ),
    });
  } catch (err) {
    next(err);
  }
});

router.use(requireAdmin);

// --- companies ---------------------------------------------------------------

router.get("/companies", async (req, res, next) => {
  try {
    const companies = await db.all(
      `SELECT c.*, l.id AS lead_id,
              (SELECT COUNT(*)::int FROM signals s WHERE s.lead_id = l.id) AS signal_count
         FROM companies c LEFT JOIN leads l ON l.company_id = c.id
        WHERE c.approval = 'approved'
        ORDER BY lower(c.name)`
    );
    res.json({ companies: companies.map((c) => ({ ...c, keywords: parseKeywords(c.keywords) })) });
  } catch (err) {
    next(err);
  }
});

router.post("/companies", async (req, res, next) => {
  try {
    const name = String((req.body && req.body.name) || "").trim();
    if (!name) return res.status(400).json({ error: "Give the company a name." });

    const keywords = normaliseKeywords(req.body.keywords, name);

    const existing = await db.one("SELECT id FROM companies WHERE lower(name) = lower($1)", [name]);
    if (existing)
      return res.status(409).json({ error: `${name} is already on the watchlist.` });

    const row = await db.one(
      "INSERT INTO companies (name, keywords) VALUES ($1, $2::jsonb) RETURNING id",
      [name, JSON.stringify(keywords)]
    );
    await ensureLead(row.id);
    res.json({ id: row.id });
  } catch (err) {
    next(err);
  }
});

router.patch("/companies/:id", async (req, res, next) => {
  try {
    const company = await db.one("SELECT * FROM companies WHERE id = $1", [req.params.id]);
    if (!company) return res.status(404).json({ error: "That company is no longer on the list." });

    const name = req.body.name !== undefined ? String(req.body.name).trim() : company.name;
    const keywords =
      req.body.keywords !== undefined
        ? JSON.stringify(normaliseKeywords(req.body.keywords, name))
        : JSON.stringify(parseKeywords(company.keywords));
    const active = req.body.active !== undefined ? Boolean(req.body.active) : company.active;

    await db.run(
      "UPDATE companies SET name = $1, keywords = $2::jsonb, active = $3 WHERE id = $4",
      [name, keywords, active, company.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/companies/:id", async (req, res, next) => {
  try {
    await db.run("DELETE FROM companies WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- sources -----------------------------------------------------------------

router.get("/sites", async (req, res, next) => {
  try {
    res.json({ sites: await db.all("SELECT * FROM sites ORDER BY lower(name)") });
  } catch (err) {
    next(err);
  }
});

router.post("/sites", async (req, res, next) => {
  try {
    const domain = String((req.body && req.body.domain) || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "");
    const name = String((req.body && req.body.name) || "").trim() || domain.split(".")[0];

    if (!domain) return res.status(400).json({ error: "Enter a domain, like livemint.com." });

    const existing = await db.one("SELECT id FROM sites WHERE domain = $1", [domain]);
    if (existing) return res.status(409).json({ error: `${domain} is already being watched.` });

    const row = await db.one("INSERT INTO sites (name, domain) VALUES ($1, $2) RETURNING id", [
      name,
      domain,
    ]);
    res.json({ id: row.id });
  } catch (err) {
    next(err);
  }
});

router.patch("/sites/:id", async (req, res, next) => {
  try {
    const site = await db.one("SELECT * FROM sites WHERE id = $1", [req.params.id]);
    if (!site) return res.status(404).json({ error: "That source is no longer on the list." });
    const active = req.body.active !== undefined ? Boolean(req.body.active) : site.active;
    await db.run("UPDATE sites SET active = $1 WHERE id = $2", [active, site.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/sites/:id", async (req, res, next) => {
  try {
    await db.run("DELETE FROM sites WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- topic keywords ----------------------------------------------------------

router.get("/topics", async (req, res, next) => {
  try {
    res.json({ topics: await db.all("SELECT * FROM topics ORDER BY keyword") });
  } catch (err) {
    next(err);
  }
});

router.post("/topics/toggle-all", async (req, res, next) => {
  try {
    await db.run("UPDATE topics SET active = $1", [Boolean(req.body && req.body.active)]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.patch("/topics/:id", async (req, res, next) => {
  try {
    await db.run("UPDATE topics SET active = $1 WHERE id = $2", [
      Boolean(req.body && req.body.active),
      req.params.id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- team --------------------------------------------------------------------

router.post("/users", async (req, res, next) => {
  try {
    const username = String((req.body && req.body.username) || "").trim().toLowerCase();
    const displayName = String((req.body && req.body.display_name) || "").trim() || username;
    const password = String((req.body && req.body.password) || "");
    const role = req.body && req.body.role === "admin" ? "admin" : "member";

    if (!username) return res.status(400).json({ error: "Enter a username." });
    if (password.length < 6)
      return res.status(400).json({ error: "Passwords need at least 6 characters." });

    const existing = await db.one("SELECT id FROM users WHERE username = $1", [username]);
    if (existing) return res.status(409).json({ error: `${username} is already taken.` });

    await db.run(
      "INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, $3, $4)",
      [username, displayName, hashPassword(password), role]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.patch("/users/:id", async (req, res, next) => {
  try {
    const user = await db.one("SELECT * FROM users WHERE id = $1", [req.params.id]);
    if (!user) return res.status(404).json({ error: "That teammate no longer exists." });

    if (Number(req.params.id) === req.user.id && req.body.active === false) {
      return res.status(400).json({ error: "You can't deactivate your own account." });
    }

    const sets = [];
    const args = [];
    const bind = (v) => `$${args.push(v)}`;

    if (req.body.display_name !== undefined)
      sets.push(`display_name = ${bind(String(req.body.display_name).trim())}`);
    if (req.body.role !== undefined)
      sets.push(`role = ${bind(req.body.role === "admin" ? "admin" : "member")}`);
    if (req.body.active !== undefined) sets.push(`active = ${bind(Boolean(req.body.active))}`);
    if (req.body.password) {
      if (String(req.body.password).length < 6)
        return res.status(400).json({ error: "Passwords need at least 6 characters." });
      sets.push(`password_hash = ${bind(hashPassword(String(req.body.password)))}`);
    }
    if (!sets.length) return res.json({ ok: true });

    await db.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ${bind(user.id)}`, args);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});



// --- CSV import --------------------------------------------------------------

/**
 * POST /api/admin/import   { csv: "<raw file text>" }
 *
 * One upload fills two tables: the company watchlist and the people directory.
 * Merge semantics - new rows are added, existing ones are topped up, and
 * nothing already in the system is removed.
 */
router.post("/import", async (req, res, next) => {
  try {
    const csv = String((req.body && req.body.csv) || "");
    if (!csv.trim()) return res.status(400).json({ error: "The file looked empty." });

    const { companies, contacts, skipped, matched, unmatched, rows } = parseContactSheet(csv);

    if (!companies.length) {
      return res.status(400).json({
        error:
          "No company names found. The sheet needs a 'Company name' column - check the first row holds the headers.",
      });
    }

    // Import only ever adds. It never deletes a company, because a partial or
    // wrong-tab export would otherwise wipe most of the list. Removing a
    // company is a deliberate act, done one at a time from Admin.
    let companiesAdded = 0;
    let contactsAdded = 0;

    await db.tx(async (q) => {
      for (const c of companies) {
        // Existing companies keep their name and approval, but pick up any
        // keywords the sheet adds. A company already rejected stays rejected.
        const { rows } = await q(
          `INSERT INTO companies
             (name, keywords, active, origin, approval,
              domain, website, linkedin, employees, revenue, industry, year_founded, specialities)
           VALUES ($1, $2::jsonb, true, 'watchlist', 'approved', $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (lower(name)) DO UPDATE
              SET keywords  = $2::jsonb,
                  domain    = COALESCE(EXCLUDED.domain,    companies.domain),
                  website   = COALESCE(EXCLUDED.website,   companies.website),
                  linkedin  = COALESCE(EXCLUDED.linkedin,  companies.linkedin),
                  employees = COALESCE(EXCLUDED.employees, companies.employees),
                  revenue   = COALESCE(EXCLUDED.revenue,   companies.revenue),
                  industry  = COALESCE(EXCLUDED.industry,  companies.industry),
                  year_founded = COALESCE(EXCLUDED.year_founded, companies.year_founded),
                  specialities = COALESCE(EXCLUDED.specialities, companies.specialities),
                  active    = CASE WHEN companies.approval = 'rejected'
                                   THEN companies.active ELSE true END,
                  approval  = CASE WHEN companies.approval = 'rejected'
                                   THEN 'rejected' ELSE 'approved' END
           RETURNING id, (xmax = 0) AS inserted`,
          [c.name, JSON.stringify(c.keywords), c.domain, c.website, c.linkedin,
           c.employees, c.revenue, c.industry, c.year_founded, c.specialities]
        );
        if (rows[0].inserted) companiesAdded++;
      }

      // Every company on the watchlist needs a lead row to hang signals off.
      await q(`INSERT INTO leads (company_id)
               SELECT id FROM companies ON CONFLICT (company_id) DO NOTHING`);

      for (const p of contacts) {
        const { rows } = await q(
          `INSERT INTO company_contacts
             (company, name, role, email, email_alt, phone, phone_alt, phone_type,
              phone_alt_type, linkedin, notes, seniority, department, city, country,
              state, is_primary)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (lower(company), lower(name)) DO UPDATE
              SET role       = COALESCE(EXCLUDED.role,       company_contacts.role),
                  email      = COALESCE(EXCLUDED.email,      company_contacts.email),
                  phone      = COALESCE(EXCLUDED.phone,      company_contacts.phone),
                  phone_alt  = COALESCE(EXCLUDED.phone_alt,  company_contacts.phone_alt),
                  email_alt  = COALESCE(EXCLUDED.email_alt,  company_contacts.email_alt),
                  phone_alt_type = COALESCE(EXCLUDED.phone_alt_type, company_contacts.phone_alt_type),
                  country    = COALESCE(EXCLUDED.country,    company_contacts.country),
                  state      = COALESCE(EXCLUDED.state,      company_contacts.state),
                  phone_type = COALESCE(EXCLUDED.phone_type, company_contacts.phone_type),
                  linkedin   = COALESCE(EXCLUDED.linkedin,   company_contacts.linkedin),
                  notes      = COALESCE(EXCLUDED.notes,      company_contacts.notes),
                  seniority  = COALESCE(EXCLUDED.seniority,  company_contacts.seniority),
                  department = COALESCE(EXCLUDED.department, company_contacts.department),
                  city       = COALESCE(EXCLUDED.city,       company_contacts.city),
                  is_primary = company_contacts.is_primary OR EXCLUDED.is_primary
           RETURNING (xmax = 0) AS inserted`,
          [p.company, p.name, p.role, p.email, p.email_alt, p.phone, p.phone_alt,
           p.phone_type, p.phone_alt_type, p.linkedin, p.notes, p.seniority,
           p.department, p.city, p.country, p.state, p.is_primary]
        );
        if (rows[0].inserted) contactsAdded++;
      }
    });

    res.json({
      rows,
      companies: companies.length,
      contacts: contacts.length,
      companiesAdded,
      contactsAdded,
      skipped,
      matched,
      unmatched,
      // A sheet of companies with no recognisable person column is almost
      // always a header-naming problem, so say so rather than reporting success.
      warning:
        contacts.length === 0
          ? "No contacts were found. The sheet needs a name column (First name / Last name, or Name) alongside Company name."
          : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Fresh Leads nobody has claimed.
 *
 * Fresh Leads are news about companies already in the database, so there are
 * no new companies to approve any more. What an admin does need is a list of
 * signals the team has walked past.
 */
router.get("/unclaimed", async (req, res, next) => {
  try {
    const days = Number(process.env.FRESH_WINDOW_DAYS || 3);
    const leads = await db.all(
      `SELECT l.id, c.name AS company, l.last_signal_at,
              (SELECT COUNT(*)::int FROM signals s WHERE s.lead_id = l.id
                AND COALESCE(s.published, s.created_at) >= now() - ($1 || ' days')::interval) AS fresh_count,
              (SELECT s.title FROM signals s WHERE s.lead_id = l.id
                ORDER BY COALESCE(s.published, s.created_at) DESC LIMIT 1) AS top_title
         FROM leads l JOIN companies c ON c.id = l.company_id
        WHERE l.owner_id IS NULL
          AND l.pool = 'all'
          AND EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id
                       AND COALESCE(s.published, s.created_at) >= now() - ($1 || ' days')::interval)
        ORDER BY l.last_signal_at DESC NULLS LAST`,
      [days]
    );
    res.json({ leads, windowDays: days });
  } catch (err) {
    next(err);
  }
});

// --- runs --------------------------------------------------------------------

router.get("/runs", async (req, res, next) => {
  try {
    const runs = await db.all("SELECT * FROM runs ORDER BY id DESC LIMIT 25");
    const queries = await buildQueries();
    res.json({
      runs,
      running: isRunning(),
      current: runState(),
      queryCount: queries.length,
      hasNewsKey: Boolean(process.env.NEWSAPI_AI_KEY),
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
      remote: remoteRunConfigured(),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/run", async (req, res, next) => {
  try {
    // On Vercel a request dies after 60s, and a full cycle takes minutes, so
    // the button asks GitHub Actions to do the work instead. Locally it just
    // runs in-process as before.
    if (remoteRunConfigured()) {
      await triggerRemoteRun();
      return res.json({
        started: true,
        remote: true,
        message: "Scan queued on GitHub Actions - results appear here in a few minutes.",
      });
    }

    if (isRunning()) return res.status(409).json({ error: "A cycle is already running." });
    if (!process.env.NEWSAPI_AI_KEY) {
      return res.status(400).json({ error: "NEWSAPI_AI_KEY is missing." });
    }

    runPipeline("manual").catch((err) => console.error("[run] failed:", err.message));
    res.json({ started: true, remote: false });
  } catch (err) {
    next(err);
  }
});

// --- helpers -----------------------------------------------------------------

function parseKeywords(raw) {
  if (Array.isArray(raw)) return raw;          // jsonb comes back parsed
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normaliseKeywords(input, fallbackName) {
  let keywords = input;
  if (typeof keywords === "string") keywords = keywords.split(",");
  if (!Array.isArray(keywords)) keywords = [];
  keywords = keywords.map((k) => String(k).trim()).filter(Boolean);
  return keywords.length ? keywords : [fallbackName];
}

module.exports = router;
