const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const lifecycle = require("../lib/lifecycle");
const { isRunning, runState } = require("../services/pipeline");
const { SCHEDULE, TIMEZONE } = require("../services/scheduler");

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    await lifecycle.sweepExpired();
    // This used to be ten separate COUNT queries. Over a remote connection
    // that's ten lots of latency for numbers that all fit in one row, so
    // they're scalar subqueries in a single round trip instead.
    const days = Number(process.env.FRESH_WINDOW_DAYS || 3);

    const [row, lastRun] = await Promise.all([
      db.one(
        `SELECT
           (SELECT COUNT(*) FROM leads)                                        AS total_leads,
           -- Unclaimed on the FRESH track specifically — an All Leads claim
           -- on the same company doesn't count against this.
           (SELECT COUNT(*) FROM leads l
             WHERE l.fresh_owner_id IS NULL AND l.in_newspaper = false
               AND EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id
                            AND COALESCE(s.published, s.created_at) >= now() - ($2 || ' days')::interval))
                                                                               AS fresh,
           (SELECT COUNT(*) FROM leads WHERE owner_id = $1 OR fresh_owner_id = $1)
                                                                               AS mine,
           (SELECT COUNT(*) FROM leads WHERE in_newspaper = true)              AS newspaper,
           (SELECT COUNT(*) FROM leads
             WHERE (owner_id = $1 AND closed_at IS NULL AND deadline_at IS NOT NULL
                    AND deadline_at < now() + interval '3 days')
                OR (fresh_owner_id = $1 AND fresh_closed_at IS NULL AND fresh_deadline_at IS NOT NULL
                    AND fresh_deadline_at < now() + interval '3 days'))        AS due_soon,
           (SELECT COUNT(*) FROM leads
             WHERE (owner_id = $1 AND closed_at IS NOT NULL)
                OR (fresh_owner_id = $1 AND fresh_closed_at IS NOT NULL))      AS closed_by_me,
           (SELECT COUNT(*) FROM leads l
             WHERE l.fresh_owner_id IS NULL AND l.in_newspaper = false
               AND EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id
                            AND COALESCE(s.published, s.created_at) >= now() - ($2 || ' days')::interval))
                                                                               AS unclaimed_fresh,
           (SELECT COUNT(*) FROM signals)                                      AS total_signals,
           (SELECT COUNT(*) FROM companies WHERE active)                       AS total_companies,
           (SELECT COUNT(*) FROM sites WHERE active)                           AS total_sites,
           (SELECT COUNT(*) FROM company_contacts)                             AS total_contacts`,
        [req.user.id, days]
      ),
      db.one("SELECT * FROM runs WHERE status <> 'running' ORDER BY id DESC LIMIT 1"),
    ]);

    res.json({
      stats: {
        fresh: row.fresh,
        dueSoon: row.due_soon,
        mine: row.mine,
        closedByMe: row.closed_by_me,
        unclaimedFresh: row.unclaimed_fresh,
      },
      totals: {
        leads: row.total_leads,
        fresh: row.fresh,
        mine: row.mine,
        newspaper: row.newspaper,
        signals: row.total_signals,
        companies: row.total_companies,
        sites: row.total_sites,
        contacts: row.total_contacts,
      },
      run: { running: isRunning(), current: runState(), last: lastRun || null },
      schedule: { cron: SCHEDULE, timezone: TIMEZONE, freshWindowDays: days },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
