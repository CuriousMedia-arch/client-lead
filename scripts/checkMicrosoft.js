/**
 * Check the Microsoft setup from the command line.
 *
 *   node scripts/checkMicrosoft.js            # server settings only
 *   node scripts/checkMicrosoft.js <userId>   # the full chain, as that user
 *
 * The same checks the portal runs at Admin → Check Microsoft setup, in a form
 * you can paste into a message to whoever administers the tenant.
 */
require("dotenv").config();

const microsoft = require("../lib/microsoft");

const TICK = { true: "  ok  ", false: " FAIL ", null: " skip " };

(async () => {
  const userId = Number(process.argv[2]) || null;

  if (!userId) {
    console.log("\nChecking the four settings only. Pass a user id for the full check:");
    console.log("  node scripts/checkMicrosoft.js 1\n");
    for (const k of ["MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_TENANT_ID", "MS_REDIRECT_URI"]) {
      const set = Boolean(process.env[k]);
      // Never print the secret itself — this output gets pasted into chats.
      const shown = !set ? "not set" : k === "MS_CLIENT_SECRET" ? "set" : process.env[k];
      console.log(`${TICK[set]} ${k.padEnd(20)} ${shown}`);
    }
    console.log("");
    process.exit(0);
  }

  const result = await microsoft.diagnose(userId);

  console.log("");
  for (const step of result.steps) {
    console.log(`${TICK[String(step.ok)]} ${step.name}`);
    if (step.detail) console.log(`        ${step.detail}`);
    if (step.fix) console.log(`        → ${step.fix}`);
    console.log("");
  }

  console.log(result.ok ? "Everything checks out.\n" : "Something above needs fixing.\n");
  process.exit(result.ok ? 0 : 1);
})().catch((err) => {
  console.error("\nCheck failed to run:", err.message, "\n");
  process.exit(1);
});
