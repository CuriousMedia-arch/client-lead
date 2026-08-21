/**
 * Kicks off collection when someone signs in, so the team never has to
 * remember to press a button in Admin.
 *
 * There are two cadences and this respects both independently:
 *
 *   Company Leads (watchlist sweep) - every 3 days.
 *   New Leads     (discovery sweep) - daily.
 *
 * Each is throttled against the last completed run OF THAT MODE, so ten people
 * signing in on a Monday morning triggers at most one of each, not twenty. If
 * both are due at once the company sweep goes first and the discovery sweep
 * waits for the next sign-in — only one run may be in flight at a time.
 */
const db = require("../db");
const { runPipeline, isRunning } = require("../services/pipeline");

// Company Leads sync every 3 days, New Leads daily. Hours, so they can be
// tightened without touching the code.
const COMPANY_HOURS = Number(process.env.AUTOSCAN_HOURS_COMPANY || process.env.AUTOSCAN_HOURS || 72);
const NEW_HOURS = Number(process.env.AUTOSCAN_HOURS_NEW || 24);

/** Hours since the last completed run of one mode, or null if there's never been one. */
async function hoursSince(mode) {
  const last = await db.one(
    `SELECT started_at FROM runs
      WHERE status <> 'failed' AND mode = $1
      ORDER BY id DESC LIMIT 1`,
    [mode]
  );
  if (!last) return null;
  return (Date.now() - new Date(last.started_at).getTime()) / 3600e3;
}

/**
 * Returns what it decided, so /api/stats can tell the user a scan is running
 * rather than leaving them staring at an unchanged dashboard.
 */
async function maybeScanOnLogin() {
  if (process.env.AUTOSCAN === "false") return { started: false, reason: "disabled" };
  if (!process.env.NEWSAPI_AI_KEY) return { started: false, reason: "no-api-key" };
  if (isRunning()) return { started: false, reason: "already-running" };

  // Serverless has no long-lived process to run this in — the function would
  // be killed mid-scan. There, the GitHub Actions schedules do the work.
  if (process.env.VERCEL) return { started: false, reason: "serverless" };

  const [companyAge, newAge] = await Promise.all([hoursSince("company"), hoursSince("new")]);

  const companyDue = companyAge === null || companyAge >= COMPANY_HOURS;
  const newDue = newAge === null || newAge >= NEW_HOURS;

  // The watchlist sweep is the one the team actually works from, so it wins
  // when both are overdue. Discovery catches up on the next sign-in.
  const mode = companyDue ? "company" : newDue ? "new" : null;

  if (!mode) {
    return {
      started: false,
      reason: "too-soon",
      hoursAgo: Math.round(Math.min(companyAge, newAge) * 10) / 10,
    };
  }

  // Fire and forget. The response must not wait for a scan that takes minutes.
  runPipeline("login", console.log, mode).catch((err) =>
    console.error("[autoscan] failed:", err.message)
  );

  return { started: true, mode };
}

module.exports = {
  maybeScanOnLogin,
  AUTOSCAN_HOURS: COMPANY_HOURS,
  AUTOSCAN_HOURS_COMPANY: COMPANY_HOURS,
  AUTOSCAN_HOURS_NEW: NEW_HOURS,
};
