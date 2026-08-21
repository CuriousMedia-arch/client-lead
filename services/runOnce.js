require("dotenv").config();
const { runPipeline } = require("./pipeline");
const { pool } = require("../db");

/**
 * One cycle from the command line or CI.
 *
 *   node services/runOnce.js            -> Company Leads (watchlist sweep)
 *   node services/runOnce.js new        -> New Leads (discovery sweep)
 *   RUN_MODE=new node services/runOnce.js
 *
 * The mode picks which of the two cadences this run belongs to; it's stamped
 * on the runs row so the portal can report each list's last sync separately.
 */
const arg = (process.argv[2] || process.env.RUN_MODE || "company").toLowerCase();
const MODE = arg === "new" || arg === "discovery" ? "new" : "company";

(async () => {
  try {
    const result = await runPipeline("schedule", console.log, MODE);
    console.log(`\n${MODE === "new" ? "New Leads" : "Company Leads"} run summary:`, result);
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("\nRun failed:", err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  }
})();
