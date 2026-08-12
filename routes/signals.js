const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");

const router = express.Router();
router.use(requireAuth);

// Whitelisted so a query string can never inject an interval.
const FRESHNESS = { "24h": "1 day", "48h": "2 days", "7d": "7 days", "30d": "30 days" };

const list = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

router.get("/", async (req, res, next) => {
  try {
    const where = [];
    const args = [];
    const bind = (v) => `$${args.push(v)}`;

    const freshness = FRESHNESS[req.query.freshness];
    if (freshness) {
      where.push(`COALESCE(s.published, s.created_at) >= now() - interval '${freshness}'`);
    }

    const types = list(req.query.types);
    if (types.length) where.push(`s.signal_type = ANY(${bind(types)})`);

    if (req.query.q) {
      const q = bind(`%${String(req.query.q).toLowerCase()}%`);
      where.push(`(LOWER(s.company) LIKE ${q} OR LOWER(COALESCE(s.title,'')) LIKE ${q})`);
    }

    if (req.query.company) where.push(`s.company = ${bind(req.query.company)}`);

    const signals = await db.all(
      `SELECT s.id, s.lead_id, s.company, s.title, s.url, s.author, s.site,
              s.published, s.created_at, s.signal_type, s.score, s.summary,
              s.why_it_matters, s.enriched
         FROM signals s
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY COALESCE(s.published, s.created_at) DESC
        LIMIT 400`,
      args
    );

    res.json({ signals });
  } catch (err) {
    next(err);
  }
});

router.get("/breakdown", async (req, res, next) => {
  try {
    const window = `COALESCE(published, created_at) >= now() - interval '30 days'`;

    const [byType, bySite, byCompany] = await Promise.all([
      db.all(
        `SELECT signal_type, COUNT(*)::int AS n FROM signals
          WHERE ${window} GROUP BY signal_type ORDER BY n DESC`
      ),
      db.all(
        `SELECT site, COUNT(*)::int AS n FROM signals
          WHERE ${window} GROUP BY site ORDER BY n DESC LIMIT 12`
      ),
      db.all(
        `SELECT company, COUNT(*)::int AS n, MAX(score) AS top_score FROM signals
          WHERE ${window} GROUP BY company ORDER BY n DESC`
      ),
    ]);

    res.json({ byType, bySite, byCompany });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
