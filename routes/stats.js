const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const lifecycle = require("../lib/lifecycle");
const { isRunning, runState, lastRunByMode } = require("../services/pipeline");
const { SCHEDULE_COMPANY, SCHEDULE_NEW, TIMEZONE } = require("../services/scheduler");

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    await lifecycle.sweepExpired();
    // This used to be ten separate COUNT queries. Over a remote connection
    // that's ten lots of latency for numbers that all fit in one row, so
    // they're scalar subqueries in a single round trip instead.
    const days = Number(process.env.FRESH_WINDOW_DAYS || 3);

    const [row, lastRun, byMode] = await Promise.all([
      db.one(
        `SELECT
           (SELECT COUNT(*) FROM leads l JOIN companies c ON c.id = l.company_id
             WHERE c.is_sample = false AND c.approval = 'approved')            AS total_leads,
           -- Unclaimed on the FRESH track specifically — an All Leads claim
           -- on the same company doesn't count against this. Split by which
           -- Fresh Leads sub-tab the row lands in: approved companies are
           -- Company Leads, pending discoveries are New Leads.
           (SELECT COUNT(*) FROM leads l JOIN companies c ON c.id = l.company_id
             WHERE l.fresh_owner_id IS NULL AND l.in_newspaper = false
               AND c.is_sample = false AND c.approval = 'approved'
               AND EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id
                            AND COALESCE(s.published, s.created_at) >= now() - ($2 || ' days')::interval))
                                                                               AS fresh_company,
           (SELECT COUNT(*) FROM leads l JOIN companies c ON c.id = l.company_id
             WHERE l.fresh_owner_id IS NULL AND l.in_newspaper = false
               AND c.is_sample = false AND c.approval = 'pending'
               AND EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id
                            AND COALESCE(s.published, s.created_at) >= now() - ($2 || ' days')::interval))
                                                                               AS fresh_new,
           -- My Outreach has two halves and the count must match them exactly:
           -- people claimed in All Leads, plus companies claimed in Fresh Leads.
           -- It used to count leads.owner_id, a company-level All Leads claim
           -- that no longer has a view to appear in — hence a count of 3 over
           -- an empty page.
           ((SELECT COUNT(*) FROM company_contacts WHERE owner_id = $1 AND deleted_at IS NULL)
            + (SELECT COUNT(*) FROM leads WHERE fresh_owner_id = $1))          AS mine,
           (SELECT COUNT(*) FROM leads WHERE in_newspaper = true)              AS newspaper,
           ((SELECT COUNT(*) FROM company_contacts
              WHERE owner_id = $1 AND deleted_at IS NULL AND closed_at IS NULL AND deadline_at IS NOT NULL
                AND deadline_at < now() + interval '3 days')
            + (SELECT COUNT(*) FROM leads
                WHERE fresh_owner_id = $1 AND fresh_closed_at IS NULL
                  AND fresh_deadline_at IS NOT NULL
                  AND fresh_deadline_at < now() + interval '3 days'))          AS due_soon,
           ((SELECT COUNT(*) FROM company_contacts WHERE owner_id = $1 AND deleted_at IS NULL AND closed_at IS NOT NULL)
            + (SELECT COUNT(*) FROM leads WHERE fresh_owner_id = $1 AND fresh_closed_at IS NOT NULL))
                                                                               AS closed_by_me,
           (SELECT COUNT(*) FROM leads l JOIN companies c ON c.id = l.company_id
             WHERE l.fresh_owner_id IS NULL AND l.in_newspaper = false
               AND c.is_sample = false AND c.approval IN ('approved', 'pending')
               AND EXISTS (SELECT 1 FROM signals s WHERE s.lead_id = l.id
                            AND COALESCE(s.published, s.created_at) >= now() - ($2 || ' days')::interval))
                                                                               AS unclaimed_fresh,
           (SELECT COUNT(*) FROM signals)                                      AS total_signals,
           (SELECT COUNT(*) FROM companies WHERE active)                       AS total_companies,
           (SELECT COUNT(*) FROM sites WHERE active)                           AS total_sites,
           (SELECT COUNT(*) FROM company_contacts WHERE deleted_at IS NULL)                             AS total_contacts`,
        [req.user.id, days]
      ),
      db.one("SELECT * FROM runs WHERE status <> 'running' ORDER BY id DESC LIMIT 1"),
      lastRunByMode(),
    ]);

    res.json({
      stats: {
        fresh: Number(row.fresh_company) + Number(row.fresh_new),
        dueSoon: row.due_soon,
        mine: row.mine,
        closedByMe: row.closed_by_me,
        unclaimedFresh: row.unclaimed_fresh,
      },
      totals: {
        leads: row.total_leads,
        fresh: Number(row.fresh_company) + Number(row.fresh_new),
        freshCompany: Number(row.fresh_company),
        freshNew: Number(row.fresh_new),
        mine: row.mine,
        newspaper: row.newspaper,
        signals: row.total_signals,
        companies: row.total_companies,
        sites: row.total_sites,
        contacts: row.total_contacts,
      },
      run: {
        running: isRunning(),
        current: runState(),
        last: lastRun || null,
        // Each Fresh Leads sub-tab reports its own last sync, because they run
        // on different clocks and "last sync 2 days ago" would be wrong for
        // one of them whichever single number was shown.
        lastCompany: byMode.company || null,
        lastNew: byMode.new || null,
      },
      schedule: {
        cron: SCHEDULE_COMPANY,
        cronCompany: SCHEDULE_COMPANY,
        cronNew: SCHEDULE_NEW,
        timezone: TIMEZONE,
        freshWindowDays: days,
        // How often each list refreshes, in days — the copy under each tab.
        companyEveryDays: 3,
        newEveryDays: 1,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
