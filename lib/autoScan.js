/**
 * Kicks off a collection cycle when someone signs in, so the team never has to
 * remember to press a button in Admin.
 *
 * A full cycle is ~90 news queries plus Gemini calls, so this is throttled: it
 * only fires when the last completed run is older than AUTOSCAN_HOURS. Ten
 * people signing in on a Monday morning triggers one scan, not ten.
 */
const db = require("../db");
const { runPipeline, isRunning } = require("../services/pipeline");

const HOURS = Number(process.env.AUTOSCAN_HOURS || 12);

/**
 * Returns what it decided, so /api/stats can tell the user a scan is running
 * rather than leaving them staring at an unchanged dashboard.
 */
async function maybeScanOnLogin() {
  if (process.env.AUTOSCAN === "false") return { started: false, reason: "disabled" };
  if (!process.env.NEWSAPI_AI_KEY) return { started: false, reason: "no-api-key" };
  if (isRunning()) return { started: false, reason: "already-running" };

  // Serverless has no long-lived process to run this in — the function would
  // be killed mid-scan. There, the GitHub Actions schedule does the work.
  if (process.env.VERCEL) return { started: false, reason: "serverless" };

  const last = await db.one(
    `SELECT started_at FROM runs
      WHERE status <> 'failed'
      ORDER BY id DESC LIMIT 1`
  );

  if (last) {
    const ageHours = (Date.now() - new Date(last.started_at).getTime()) / 3600e3;
    if (ageHours < HOURS) {
      return { started: false, reason: "too-soon", hoursAgo: Math.round(ageHours * 10) / 10 };
    }
  }

  // Fire and forget. The response must not wait for a scan that takes minutes.
  runPipeline("login").catch((err) => console.error("[autoscan] failed:", err.message));

  return { started: true };
}

module.exports = { maybeScanOnLogin, AUTOSCAN_HOURS: HOURS };
