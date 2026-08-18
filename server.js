/** Local development server. Vercel never runs this file. */
require("dotenv").config();

const app = require("./app");
const db = require("./db");
const { purgeExpiredSessions } = require("./lib/auth");
const scheduler = require("./services/scheduler");

const PORT = Number(process.env.PORT || 3000);

(async () => {
  purgeExpiredSessions().catch(() => {});
  setInterval(() => purgeExpiredSessions().catch(() => {}), 6 * 3600e3).unref();

  // Scores are recomputed on every scan, but the weighting can change between
  // deploys — resync once at boot so the sort order matches what's on screen.
  require("./services/pipeline")
    .recomputeLeadRollups()
    .catch((err) => console.error("[boot] score resync failed:", err.message));

  let userCount = null;
  try {
    const row = await db.one("SELECT COUNT(*)::int AS n FROM users");
    userCount = row.n;
  } catch (err) {
    console.error(`\n  Can't reach the database: ${err.message}`);
    console.error("  Check DATABASE_URL in .env.\n");
  }

  app.listen(PORT, () => {
    console.log(`\n  Curious Media - Lead Intelligence`);
    console.log(`  Running at http://localhost:${PORT}`);
    console.log(`  Database:  Supabase Postgres`);
    if (userCount === 0) {
      console.log(`\n  No accounts yet. Stop the server and run:  npm run setup\n`);
    } else {
      console.log("");
    }
    scheduler.start();
  });
})();
