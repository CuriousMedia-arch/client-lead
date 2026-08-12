require("dotenv").config();
const { runPipeline } = require("./pipeline");
const { pool } = require("../db");

(async () => {
  try {
    const result = await runPipeline("schedule");
    console.log("\nRun summary:", result);
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("\nRun failed:", err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  }
})();
