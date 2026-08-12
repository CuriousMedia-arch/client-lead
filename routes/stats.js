const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const { isRunning, runState } = require("../services/pipeline");
const { SCHEDULE, TIMEZONE } = require("../services/scheduler");

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    // This used to be ten separate COUNT queries. Over a remote connection
    // that's ten lots of latency for numbers that all fit in one row, so
    // they're scalar subqueries in a single round trip instead.
    const [row, lastRun] = await Promise.all([
      db.one(
        `SELECT
           (SELECT COUNT(DISTINCT s.lead_id) FROM signals s
              JOIN leads l ON l.id = s.lead_id
              JOIN companies c ON c.id = l.company_id
             WHERE s.created_at >= now() - interval '1 day'
               AND c.approval = 'approved')                                   AS new_in_24h,
           (SELECT COUNT(*) FROM leads
             WHERE status IN ('working','contacted','replied','qualified'))   AS active_pipeline,
           (SELECT COUNT(*) FROM leads
             WHERE next_followup_at IS NOT NULL
               AND next_followup_at <= current_date)                          AS followups_due,
           (SELECT COUNT(DISTINCT lead_id) FROM activity
             WHERE created_at >= now() - interval '7 days')                   AS touched_this_week,
           (SELECT COUNT(*) FROM leads l JOIN companies c ON c.id = l.company_id
             WHERE c.approval = 'approved')                                   AS total_leads,
           (SELECT COUNT(*) FROM signals)                                     AS total_signals,
           (SELECT COUNT(*) FROM companies WHERE active)                      AS total_companies,
           (SELECT COUNT(*) FROM sites WHERE active)                          AS total_sites,
           (SELECT COUNT(*) FROM leads l JOIN companies c ON c.id = l.company_id
             WHERE l.owner_id = $1 AND c.approval <> 'rejected')              AS mine,
           (SELECT COUNT(*) FROM leads l JOIN companies c ON c.id = l.company_id
             WHERE c.approval = 'pending')                                   AS fresh`,
        [req.user.id]
      ),
      db.one("SELECT * FROM runs WHERE status <> 'running' ORDER BY id DESC LIMIT 1"),
    ]);

    res.json({
      stats: {
        newIn24h: row.new_in_24h,
        activePipeline: row.active_pipeline,
        followupsDue: row.followups_due,
        touchedThisWeek: row.touched_this_week,
      },
      totals: {
        leads: row.total_leads,
        signals: row.total_signals,
        companies: row.total_companies,
        sites: row.total_sites,
        mine: row.mine,
        fresh: row.fresh,
      },
      run: { running: isRunning(), current: runState(), last: lastRun || null },
      schedule: { cron: SCHEDULE, timezone: TIMEZONE },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
