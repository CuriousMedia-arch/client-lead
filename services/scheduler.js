const cron = require("node-cron");
const { runPipeline, isRunning } = require("./pipeline");
const freshClock = require("../lib/freshClock");
const sweeps = require("../lib/sweeps");

/**
 * Two schedules, because Fresh Leads is two lists on two clocks.
 *
 *   Company Leads - the watchlist sweep, every 3 days at 2am. It's the
 *                   expensive one (a query per watched company across every
 *                   source) and the companies in it are already ours, so
 *                   nightly would be spend without news to show for it.
 *
 *   New Leads     - the discovery sweep, daily at 3am. This is how unknown
 *                   companies surface at all, and a company that made the
 *                   wire on Tuesday is stale by Friday, so it runs every day.
 *                   Nothing it finds enters All Leads without an admin
 *                   approving it.
 *
 * They're offset by an hour so the two never collide on the same night — only
 * one run may be in flight at a time.
 */
const SCHEDULE_COMPANY = process.env.CRON_SCHEDULE_COMPANY || process.env.CRON_SCHEDULE || "0 2 */3 * *";
const SCHEDULE_NEW = process.env.CRON_SCHEDULE_NEW || "0 3 * * *";
const TIMEZONE = process.env.TZ_NAME || "Asia/Kolkata";

// Kept for anything still importing the old single-schedule name.
const SCHEDULE = SCHEDULE_COMPANY;

function schedule(expression, mode, label) {
  if (!cron.validate(expression)) {
    console.error(`[scheduler] "${expression}" is not a valid cron expression. ${label} off.`);
    return false;
  }

  cron.schedule(
    expression,
    async () => {
      if (isRunning()) {
        console.log(`[scheduler] Previous run still going - skipping this ${label} cycle.`);
        return;
      }
      try {
        await runPipeline("schedule", console.log, mode);
      } catch (err) {
        console.error(`[scheduler] ${label} run failed:`, err.message);
      }
    },
    { timezone: TIMEZONE }
  );

  return true;
}

function start() {
  // The Fresh Leads checkpoints are time-based, so they need a heartbeat as
  // well as the on-request check — a lead should be released twelve hours
  // after it went quiet, not the next time somebody happens to load a page.
  cron.schedule(
    process.env.FRESH_CLOCK_CRON || "*/30 * * * *",
    () => freshClock.runChecks().catch((err) => console.error("[freshClock]", err.message)),
    { timezone: process.env.TZ_NAME || "Asia/Kolkata" }
  );

  // The claim clocks need the same treatment, and for the same reason: a lead
  // due back on Saturday should come back on Saturday, not on Monday when
  // somebody finally opens a page. Every 15 minutes, which is fine granularity
  // for deadlines measured in hours and days, and cheap — three small UPDATEs
  // that touch nothing when nothing is overdue.
  //
  // The routes still sweep on request too. That is not redundant: it keeps the
  // page in front of a person truthful in the seconds between heartbeats.
  cron.schedule(
    process.env.SWEEP_CRON || "*/15 * * * *",
    async () => {
      const r = await sweeps.runAllSweeps();
      // Only speak up when something actually moved, or the log becomes 96
      // lines a day of "nothing happened" and nobody reads it.
      const moved =
        (r.leads && (r.leads.released || r.leads.toNewspaper)) || r.contacts || r.silent;
      if (moved) console.log("[sweeps]", JSON.stringify(r));
    },
    { timezone: process.env.TZ_NAME || "Asia/Kolkata" }
  );

  // Serverless has no always-on process, so an in-process cron would never
  // fire. GitHub Actions runs both schedules for the deployed app instead.
  if (process.env.VERCEL) return;

  if (process.env.DISABLE_SCHEDULER === "true") {
    console.log("[scheduler] Disabled via DISABLE_SCHEDULER.");
    return;
  }

  if (schedule(SCHEDULE_COMPANY, "company", "Company Leads")) {
    console.log(`[scheduler] Company Leads: "${SCHEDULE_COMPANY}" (${TIMEZONE})`);
  }

  if (schedule(SCHEDULE_NEW, "new", "New Leads")) {
    console.log(`[scheduler] New Leads: "${SCHEDULE_NEW}" (${TIMEZONE})`);
  }
}

module.exports = { start, SCHEDULE, SCHEDULE_COMPANY, SCHEDULE_NEW, TIMEZONE };
