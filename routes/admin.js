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

// --- discoveries ---------------------------------------------------------------

/**
 * Companies the discovery sweep found on its own (origin='discovered',
 * approval='pending'). They already show up in Fresh Leads; approving one
 * just adds it to the daily watchlist scan, rejecting hides it for good.
 */
router.get("/discoveries", async (req, res, next) => {
  try {
    const companies = await db.all(
      `SELECT c.id, c.name,
              (SELECT COUNT(*)::int FROM signals s WHERE s.lead_id = l.id) AS signal_count,
              (SELECT s.title FROM signals s WHERE s.lead_id = l.id
                ORDER BY COALESCE(s.published, s.created_at) DESC LIMIT 1) AS top_title,
              (SELECT s.score FROM signals s WHERE s.lead_id = l.id
                ORDER BY s.score DESC LIMIT 1) AS top_score
         FROM companies c LEFT JOIN leads l ON l.company_id = c.id
        WHERE c.origin = 'discovered' AND c.approval = 'pending'
        ORDER BY c.created_at DESC`
    );
    res.json({ companies });
  } catch (err) {
    next(err);
  }
});

/**
 * Approving is the ONLY way a discovered company reaches All Leads.
 *
 * Until this runs the company sits at approval='pending': claimable from
 * Fresh Leads > New Leads, invisible in All Leads, and skipped by the
 * every-3-days watchlist sweep. Approving flips all three at once.
 */
router.post("/discoveries/:id/approve", async (req, res, next) => {
  try {
    const row = await db.one(
      `UPDATE companies SET approval = 'approved', active = true
        WHERE id = $1 AND approval = 'pending' RETURNING id, name`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: "That discovery is no longer pending." });

    // It needs a lead row to appear in All Leads at all. Discovery normally
    // creates one, but a company approved before its first signal landed
    // wouldn't have one yet.
    await ensureLead(row.id);

    res.json({ ok: true, name: row.name });
  } catch (err) {
    next(err);
  }
});

router.post("/discoveries/:id/reject", async (req, res, next) => {
  try {
    const row = await db.one(
      `UPDATE companies SET approval = 'rejected', active = false
        WHERE id = $1 AND approval = 'pending' RETURNING id`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: "That discovery is no longer pending." });
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

    // Deactivating someone frees whatever they were sitting on, on BOTH
    // tracks independently. Their All Leads claims go back to All Leads with
    // no owner. Their Fresh Leads claims go straight back to Fresh Leads too
    // (not the Newspaper — that's only for a deadline actually running out).
    // Closed claims are left alone on whichever track they were closed on;
    // that outreach already happened and isn't undone by removing the person.
    let released = 0;
    if (req.body.active === false) {
      const freedAll = await db.all(
        `UPDATE leads
            SET owner_id = NULL, claimed_at = NULL, claim_source = NULL,
                deadline_at = NULL, updated_at = now()
          WHERE owner_id = $1 AND closed_at IS NULL
          RETURNING id`,
        [user.id]
      );
      const freedFresh = await db.all(
        `UPDATE leads
            SET fresh_owner_id = NULL, fresh_claimed_at = NULL, fresh_deadline_at = NULL,
                updated_at = now()
          WHERE fresh_owner_id = $1 AND fresh_closed_at IS NULL
          RETURNING id`,
        [user.id]
      );
      const freedIds = [...freedAll.map((l) => l.id), ...freedFresh.map((l) => l.id)];
      released = freedIds.length;
      if (released) {
        await db.run(
          `INSERT INTO activity (lead_id, user_id, kind, body)
           SELECT id, $2, 'claim', $3 FROM unnest($1::bigint[]) AS id`,
          [freedIds, req.user.id, `Released — ${user.display_name} was removed from the team`]
        );
      }
    }

    res.json({ ok: true, released });
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

    let companiesAdded = 0;
    let contactsAdded = 0;
    let duplicatesSkipped = 0;

    await db.tx(async (q) => {
      for (const c of companies) {
        // Existing companies keep their name and approval, but pick up any
        // keywords the sheet adds. A company already rejected stays rejected.
        const { rows } = await q(
          `INSERT INTO companies
             (name, keywords, active, origin, approval,
              domain, website, linkedin, employees, revenue, industry, founded,
              city, state, specialities)
           VALUES ($1, $2::jsonb, true, 'watchlist', 'approved', $3, $4, $5, $6, $7, $8, $9,
                   $10, $11, $12)
           ON CONFLICT (lower(name)) DO UPDATE
              SET keywords  = $2::jsonb,
                  specialities = COALESCE(EXCLUDED.specialities, companies.specialities),
                  domain    = COALESCE(EXCLUDED.domain,    companies.domain),
                  website   = COALESCE(EXCLUDED.website,   companies.website),
                  linkedin  = COALESCE(EXCLUDED.linkedin,  companies.linkedin),
                  employees = COALESCE(EXCLUDED.employees, companies.employees),
                  revenue   = COALESCE(EXCLUDED.revenue,   companies.revenue),
                  industry  = COALESCE(EXCLUDED.industry,  companies.industry),
                  founded   = COALESCE(EXCLUDED.founded,   companies.founded),
                  city      = COALESCE(EXCLUDED.city,      companies.city),
                  state     = COALESCE(EXCLUDED.state,     companies.state),
                  active    = CASE WHEN companies.approval = 'rejected'
                                   THEN companies.active ELSE true END,
                  approval  = CASE WHEN companies.approval = 'rejected'
                                   THEN 'rejected' ELSE 'approved' END
           RETURNING id, (xmax = 0) AS inserted`,
          [c.name, JSON.stringify(c.keywords), c.domain, c.website, c.linkedin,
           c.employees, c.revenue, c.industry, c.founded, c.city, c.state, c.specialities]
        );
        if (rows[0].inserted) companiesAdded++;
      }

      // Every company on the watchlist needs a lead row to hang signals off.
      await q(`INSERT INTO leads (company_id)
               SELECT id FROM companies ON CONFLICT (company_id) DO NOTHING`);

      for (const p of contacts) {
        const { rows } = await q(
          `INSERT INTO company_contacts
             (company, name, role, email, email_alt, phone, phone_type, phone2, phone2_type,
              linkedin, notes, seniority, department, city, country, state, is_primary)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (lower(company), lower(name)) WHERE deleted_at IS NULL DO UPDATE
              SET role        = COALESCE(EXCLUDED.role,        company_contacts.role),
                  email       = COALESCE(EXCLUDED.email,       company_contacts.email),
                  email_alt   = COALESCE(EXCLUDED.email_alt,   company_contacts.email_alt),
                  country     = COALESCE(EXCLUDED.country,     company_contacts.country),
                  state       = COALESCE(EXCLUDED.state,       company_contacts.state),
                  phone       = COALESCE(EXCLUDED.phone,       company_contacts.phone),
                  phone_type  = COALESCE(EXCLUDED.phone_type,  company_contacts.phone_type),
                  phone2      = COALESCE(EXCLUDED.phone2,      company_contacts.phone2),
                  phone2_type = COALESCE(EXCLUDED.phone2_type, company_contacts.phone2_type),
                  linkedin    = COALESCE(EXCLUDED.linkedin,    company_contacts.linkedin),
                  notes       = COALESCE(EXCLUDED.notes,       company_contacts.notes),
                  seniority   = COALESCE(EXCLUDED.seniority,   company_contacts.seniority),
                  department  = COALESCE(EXCLUDED.department,  company_contacts.department),
                  city        = COALESCE(EXCLUDED.city,        company_contacts.city),
                  is_primary  = company_contacts.is_primary OR EXCLUDED.is_primary
           -- Company + phone + name all matching the row already on file means
           -- this import row is a duplicate of what we have, not new info —
           -- skip the write entirely rather than touching the existing row.
           WHERE NOT (company_contacts.phone IS NOT DISTINCT FROM EXCLUDED.phone)
           RETURNING id, (xmax = 0) AS inserted`,
          [p.company, p.name, p.role, p.email, p.email_alt, p.phone, p.phone_type,
           p.phone2, p.phone2_type, p.linkedin, p.notes, p.seniority, p.department,
           p.city, p.country, p.state, p.is_primary]
        );
        // No row comes back at all when the update WHERE clause above
        // rejected the write — company + phone + name matched exactly what
        // was already on file, so it's a duplicate and nothing changed.
        if (rows[0] && rows[0].inserted) {
          contactsAdded++;
          // Snapshot the row as the sheet delivered it. Written once — later
          // imports and edits never touch it, so "what did the file say?"
          // always has an answer.
          await q(
            `INSERT INTO contact_originals
               (contact_id, company, name, role, email, email_alt, phone, phone2,
                linkedin, seniority, department, city, country, state)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             ON CONFLICT (contact_id) DO NOTHING`,
            [rows[0].id, p.company, p.name, p.role, p.email, p.email_alt, p.phone,
             p.phone2, p.linkedin, p.seniority, p.department, p.city, p.country, p.state]
          );
        } else if (!rows[0]) {
          duplicatesSkipped++;
        }
      }
    });

    res.json({
      rows,
      companies: companies.length,
      contacts: contacts.length,
      companiesAdded,
      contactsAdded,
      duplicatesSkipped,
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
              CASE WHEN c.approval = 'pending' THEN 'new' ELSE 'company' END AS kind,
              (SELECT COUNT(*)::int FROM signals s WHERE s.lead_id = l.id
                AND COALESCE(s.published, s.created_at) >= now() - ($1 || ' days')::interval) AS fresh_count,
              (SELECT s.title FROM signals s WHERE s.lead_id = l.id
                ORDER BY COALESCE(s.published, s.created_at) DESC LIMIT 1) AS top_title
         FROM leads l JOIN companies c ON c.id = l.company_id
        WHERE l.fresh_owner_id IS NULL
          AND l.in_newspaper = false
          AND c.is_sample = false
          AND c.approval IN ('approved', 'pending')
          AND EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id
                       AND COALESCE(s.published, s.created_at) >= now() - ($1 || ' days')::interval)
        ORDER BY l.last_signal_at DESC NULLS LAST`,
      [days]
    );

    // Split here rather than in the browser: the Admin tab shows them as two
    // lists, matching the two Fresh Leads sub-tabs they came from.
    res.json({
      leads,
      company: leads.filter((l) => l.kind === "company"),
      fresh: leads.filter((l) => l.kind === "new"),
      windowDays: days,
    });
  } catch (err) {
    next(err);
  }
});


// --- sample Newspaper releases ----------------------------------------------

/**
 * The Newspaper only fills once real Fresh claims miss their deadline, which
 * takes ten days. That's a long time to wait before you can tell whether the
 * year/month/day drill-down works. These are clearly-marked samples an admin
 * can add and remove from the deployed app, without shell access.
 */
const DEMO_MARK = "[sample]";

const DEMO_RELEASES = [
  ["Zepto", "2026-08-14", "Zepto raises $350 Mn Series G led by Avenir"],
  ["Swiggy", "2026-08-14", "Swiggy Instamart opens 40 dark stores in tier-2 cities"],
  ["boAt", "2026-08-09", "boAt signs cricketer as brand ambassador for festive line"],
  ["Lenskart", "2026-08-02", "Lenskart appoints new Chief Marketing Officer"],
  ["Mamaearth", "2026-07-27", "Mamaearth unveils rebrand ahead of the festive quarter"],
  ["Zomato", "2026-07-15", "Zomato reports quarterly profit, revenue up 32%"],
  ["Nykaa", "2026-06-30", "Nykaa opens its 50th flagship store in Bengaluru"],
  ["CRED", "2026-06-11", "CRED faces backlash over its new ad campaign"],
  ["Ola Electric", "2026-05-21", "Ola Electric launches a new scooter range"],
  ["Licious", "2025-12-18", "Licious closes $150 Mn round to fund expansion"],
  ["Sugar Cosmetics", "2025-11-05", "Sugar Cosmetics enters 100 new retail doors"],
  ["Blinkit", "2025-09-23", "Blinkit names a new Head of Brand Marketing"],
];

router.post("/demo-newspaper", async (req, res, next) => {
  try {
    if (req.body && req.body.clear) {
      // Remove by the flag, not by name — an earlier script used a different
      // marker, and deleting by one name only ever cleared half of them.
      const removed = await db.run(
        `DELETE FROM companies
          WHERE is_sample = true OR name LIKE '%[demo]%' OR name LIKE '%[sample]%'`
      );
      return res.json({ cleared: removed });
    }

    let added = 0;

    for (const [name, date, headline] of DEMO_RELEASES) {
      const display = `${name} ${DEMO_MARK}`;

      const company = await db.one(
        `INSERT INTO companies (name, keywords, active, origin, approval, industry, is_sample)
         VALUES ($1, $2::jsonb, false, 'discovered', 'approved', 'Sample data', true)
         ON CONFLICT (lower(name)) DO UPDATE SET is_sample = true
         RETURNING id`,
        [display, JSON.stringify([name])]
      );

      const lead = await db.one(
        `INSERT INTO leads (company_id) VALUES ($1)
         ON CONFLICT (company_id) DO UPDATE SET company_id = EXCLUDED.company_id
         RETURNING id`,
        [company.id]
      );

      await db.run(
        `UPDATE leads
            SET in_newspaper = true, fresh_owner_id = NULL, fresh_deadline_at = NULL,
                fresh_released_at = $1::timestamptz, released_at = $1::timestamptz,
                last_signal_at = $1::timestamptz, status = 'new'
          WHERE id = $2`,
        [`${date} 10:00:00+05:30`, lead.id]
      );

      await db.run(
        `INSERT INTO signals (lead_id, company, title, url, site, published, signal_type, summary)
         VALUES ($1,$2,$3,$4,'afaqs',$5::timestamptz,'capital',$6)
         ON CONFLICT (url) DO NOTHING`,
        [
          lead.id,
          display,
          headline,
          `https://sample.local/${lead.id}`,
          `${date} 09:00:00+05:30`,
          "Sample entry, so the Newspaper can be tried before real leads age out.",
        ]
      );

      added++;
    }

    res.json({ added, mark: DEMO_MARK });
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

/**
 * Sync one of the two lists.
 *
 *   { mode: 'company' } - the watchlist sweep behind Fresh Leads > Company
 *                         Leads. Scheduled every 3 days.
 *   { mode: 'new' }     - the discovery sweep behind Fresh Leads > New Leads.
 *                         Scheduled daily.
 *
 * Only one may be in flight at a time, so asking for the second while the
 * first is running is refused rather than queued.
 */
router.post("/run", async (req, res, next) => {
  try {
    const mode = req.body && req.body.mode === "new" ? "new" : "company";
    const label = mode === "new" ? "New Leads" : "Company Leads";

    // On Vercel a request dies after 60s, and a full cycle takes minutes, so
    // the button asks GitHub Actions to do the work instead. Locally it just
    // runs in-process as before.
    if (remoteRunConfigured()) {
      await triggerRemoteRun(mode);
      return res.json({
        started: true,
        remote: true,
        mode,
        message: `${label} sync queued on GitHub Actions - results appear here in a few minutes.`,
      });
    }

    if (isRunning()) return res.status(409).json({ error: "A cycle is already running." });
    if (!process.env.NEWSAPI_AI_KEY) {
      return res.status(400).json({ error: "NEWSAPI_AI_KEY is missing." });
    }
    if (mode === "new" && !process.env.GEMINI_API_KEY) {
      return res.status(400).json({
        error: "New Leads needs GEMINI_API_KEY — discovery can't name companies without it.",
      });
    }

    runPipeline("manual", console.log, mode).catch((err) =>
      console.error(`[run:${mode}] failed:`, err.message)
    );
    res.json({ started: true, remote: false, mode });
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
