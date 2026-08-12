const express = require("express");
const db = require("../db");
const { requireAuth, requireAdmin, hashPassword } = require("../lib/auth");
const { runPipeline, isRunning, runState, buildQueries, ensureLead } = require("../services/pipeline");
const { triggerRemoteRun, remoteRunConfigured } = require("../lib/remoteRun");

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


// --- discovered companies (Fresh Leads approval queue) -----------------------

router.get("/discoveries", async (req, res, next) => {
  try {
    const companies = await db.all(
      `SELECT c.id, c.name, c.approval, c.created_at, l.id AS lead_id,
              (SELECT COUNT(*)::int FROM signals s WHERE s.lead_id = l.id) AS signal_count,
              (SELECT MAX(s.score) FROM signals s WHERE s.lead_id = l.id)  AS top_score,
              (SELECT s.title FROM signals s WHERE s.lead_id = l.id
                ORDER BY s.score DESC LIMIT 1)                             AS top_title
         FROM companies c LEFT JOIN leads l ON l.company_id = c.id
        WHERE c.approval = 'pending'
        ORDER BY top_score DESC NULLS LAST, c.name`
    );
    res.json({ companies });
  } catch (err) {
    next(err);
  }
});

/**
 * Approve  -> joins the watchlist and gets scanned on every cycle from now on.
 * Reject   -> stays out of every tab, and the sweep won't file it again.
 */
router.post("/discoveries/:id/:decision", async (req, res, next) => {
  try {
    const decision = req.params.decision;
    if (!["approve", "reject"].includes(decision)) {
      return res.status(400).json({ error: "Approve or reject." });
    }

    const company = await db.one("SELECT * FROM companies WHERE id = $1", [req.params.id]);
    if (!company) return res.status(404).json({ error: "That company is no longer listed." });

    if (decision === "approve") {
      await db.run(
        `UPDATE companies SET approval = 'approved', origin = 'watchlist', active = true
          WHERE id = $1`,
        [company.id]
      );
    } else {
      // Keep the row so the sweep recognises the name and skips it next time.
      await db.run(
        "UPDATE companies SET approval = 'rejected', active = false WHERE id = $1",
        [company.id]
      );
    }

    res.json({ ok: true });
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
