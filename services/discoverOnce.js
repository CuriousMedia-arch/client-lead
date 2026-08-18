/**
 * Runs ONLY the discovery sweep, printing every step.
 *
 *   npm run discover
 *
 * Use this when Today's Leads is empty and you need to know why. It reports
 * what it searched, how many articles came back, what the AI made of them,
 * and which companies were filed — rather than failing quietly inside a
 * larger scan.
 */
require("dotenv").config();

const db = require("../db");
const playbook = require("../lib/triggers");
const gemini = require("../lib/gemini");
const { runDiscovery } = require("./pipeline");

const line = (s = "") => console.log(s);

(async () => {
  line("\n  Discovery sweep — diagnostic run\n");

  // --- preconditions -------------------------------------------------------
  const [sites, companies, topics] = await Promise.all([
    db.all("SELECT name, domain FROM sites WHERE active ORDER BY name"),
    db.value("SELECT COUNT(*) n FROM companies"),
    db.all("SELECT keyword FROM topics"),
  ]);

  line(`  Sources active .......... ${sites.length}`);
  line(`  Companies already known . ${companies}`);
  line(`  Playbook keywords ....... ${playbook.allKeywords().length}`);
  line(`  Extra topic keywords .... ${topics.length}`);
  line(`  NEWSAPI_AI_KEY .......... ${process.env.NEWSAPI_AI_KEY ? "set" : "MISSING"}`);
  // keyFingerprint arrived in a later build than gemini.js may be — don't let
  // a diagnostic tool die because one helper is missing.
  const fingerprint =
    typeof gemini.keyFingerprint === "function"
      ? gemini.keyFingerprint()
      : process.env.GEMINI_API_KEY
      ? `${process.env.GEMINI_API_KEY.slice(0, 10)}…${process.env.GEMINI_API_KEY.slice(-4)}`
      : null;

  line(`  GEMINI_API_KEY .......... ${fingerprint || "MISSING"}`);
  line(`  GEMINI_MODEL ............ ${gemini.MODEL || process.env.GEMINI_MODEL || "(default)"}`);
  line(`  Window .................. last ${process.env.DISCOVERY_WINDOW_HOURS || 48}h`);
  line(`  Articles per sweep ...... ${process.env.DISCOVERY_PER_SITE || 60}`);
  line("");

  if (!sites.length) {
    line("  STOP: no active sources. Add one in Admin.\n");
    process.exit(1);
  }
  if (!process.env.NEWSAPI_AI_KEY) {
    line("  STOP: NEWSAPI_AI_KEY is not set.\n");
    process.exit(1);
  }

  // --- is the AI reachable? ------------------------------------------------
  const health =
    typeof gemini.healthCheck === "function"
      ? await gemini.healthCheck()
      : { ok: Boolean(process.env.GEMINI_API_KEY), model: process.env.GEMINI_MODEL, reason: "GEMINI_API_KEY is not set" };

  if (!health.ok) {
    line(`  STOP: Gemini is not answering — ${health.reason}`);
    line("  Discovery needs it to work out which company each article is about.\n");
    process.exit(1);
  }
  line(`  Gemini responding via ${health.model || "the configured model"}. Sweeping…\n`);

  // --- the sweep -----------------------------------------------------------
  const runRow = await db.one(
    "INSERT INTO runs (trigger) VALUES ('discovery-only') RETURNING id"
  );

  const counters = { errors: 0 };
  const stored = await runDiscovery(runRow.id, (m) => line("  " + m), counters);

  await db.run(
    `UPDATE runs SET status = 'done', new_signals = $1, errors = $2, finished_at = now()
      WHERE id = $3`,
    [stored, counters.errors, runRow.id]
  );

  // --- what landed ---------------------------------------------------------
  const pending = await db.all(
    `SELECT c.name, COUNT(s.id)::int AS signals, MAX(s.score) AS top
       FROM companies c
       LEFT JOIN leads l ON l.company_id = c.id
       LEFT JOIN signals s ON s.lead_id = l.id
      WHERE c.approval = 'pending'
      GROUP BY c.name
      ORDER BY top DESC NULLS LAST`
  );

  line("");
  line(`  Signals stored this run . ${stored}`);
  line(`  Errors .................. ${counters.errors}`);
  line(`  Companies now in Today's  ${pending.length}`);

  if (pending.length) {
    line("");
    for (const p of pending.slice(0, 20)) {
      line(`    ${String(p.top ?? "-").padStart(3)}  ${p.name}  (${p.signals} signal${p.signals === 1 ? "" : "s"})`);
    }
  } else {
    line("");
    line("  Nothing landed. The likely reasons, in order:");
    line("   1. Every company found is already on your watchlist — that's a good");
    line("      outcome, not a failure. Widen DISCOVERY_WINDOW_HOURS to look further back.");
    line("   2. The sources carried no business-event stories in the window.");
    line("   3. Gemini declined to name a company for any of them (it returns null");
    line("      rather than guessing, so junk leads don't get created).");
  }

  line("");
  await db.pool.end();
  process.exit(0);
})().catch(async (err) => {
  console.error("\n  Discovery failed:", err.message, "\n");
  await db.pool.end().catch(() => {});
  process.exit(1);
});
