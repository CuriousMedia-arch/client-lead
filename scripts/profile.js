/**
 * What does each screen actually cost?
 *
 * Counts database round trips per HTTP request. Round trips are the number
 * that matters on this stack: the app is in Mumbai-ish, Supabase is remote,
 * and every query is 5-15ms of latency that no amount of local speed fixes.
 * Twenty queries is a third of a second before anything renders.
 *
 * Run: node scripts/profile.js
 */
const Module = require("module");
const http = require("http");
const { newDb } = require("pg-mem");

const mem = newDb({ autoCreateForeignKeyIndices: true });
mem.public.registerFunction({
  name: "now",
  returns: require("pg-mem").DataType.timestamptz,
  implementation: () => new Date(),
});

// Reuse the persistence harness's schema — it already matches production.
const persistence = require("fs").readFileSync(
  require("path").join(__dirname, "testPersistence.js"),
  "utf8"
);
const SCHEMA = persistence.slice(
  persistence.indexOf("const SCHEMA = `") + "const SCHEMA = `".length,
  persistence.indexOf("`;\n\nmem.public.none(SCHEMA)")
);
mem.public.none(SCHEMA);

mem.public.none(`
insert into users (username, display_name, role, active) values ('vihith','Vihith','admin',true);
insert into sessions (id, user_id, expires_at) values ('testsid', 1, now() + interval '1 day');
`);

// A realistic amount of data, not three rows.
const COMPANIES = 300;
const CONTACTS_EACH = 8;
for (let c = 0; c < COMPANIES; c++) {
  mem.public.none(
    `insert into companies (name, industry, approval) values ('Co${c}','Consumer','approved')`
  );
  mem.public.none(`insert into leads (company_id, status) values (${c + 1},'new')`);
  for (let p = 0; p < CONTACTS_EACH; p++) {
    mem.public.none(
      `insert into company_contacts (company, name, role, email, ${c < 20 ? "owner_id, claim_source," : ""} status)
       values ('Co${c}','P${c}x${p}','Manager','p${c}x${p}@co.com', ${c < 20 ? "1,'all'," : ""} 'new')`
    );
  }
}

let queries = 0;
const pgAdapter = mem.adapters.createPg();
// Also time each statement, so a slow screen points at the query responsible
// rather than just "the screen is slow".
const slow = [];
const count = (obj) => {
  const original = obj.query.bind(obj);
  obj.query = async (...args) => {
    queries++;
    const text = typeof args[0] === "string" ? args[0] : (args[0] && args[0].text) || "";
    const t = Date.now();
    try {
      return await original(...args);
    } finally {
      slow.push({ ms: Date.now() - t, text: text.replace(/\s+/g, " ").trim().slice(0, 110) });
    }
  };
  return obj;
};

class CountingPool extends pgAdapter.Pool {
  constructor(...a) { super(...a); count(this); }
  async connect() { return count(await super.connect()); }
}

const realResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) {
  return r === "pg" ? "FAKE_PG" : realResolve.call(this, r, ...rest);
};
require.cache.FAKE_PG = {
  id: "FAKE_PG", filename: "FAKE_PG", loaded: true,
  exports: { ...pgAdapter, Pool: CountingPool, types: { setTypeParser() {} } },
};

process.env.DATABASE_URL = "postgres://mem/mem";
process.env.SESSION_CACHE_MS = "0";
delete process.env.GEMINI_API_KEY;

const app = require("../app");
const server = app.listen(0, run);

function call(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: server.address().port, path, method,
        headers: { "Content-Type": "application/json", Cookie: "sid=testsid" } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, length: d.length }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

const SCREENS = [
  ["Sign-in check", "GET", "/api/auth/me"],
  ["Tab counts (every page)", "GET", "/api/stats"],
  ["All Leads", "GET", "/api/leads?tab=all"],
  ["All Leads + search", "GET", "/api/leads?tab=all&q=manager"],
  ["Fresh Leads", "GET", "/api/leads?tab=fresh&freshKind=company"],
  ["Newspaper", "GET", "/api/leads?tab=newspaper"],
  ["My Outreach — Today", "GET", "/api/outreach/today"],
  ["Bell (polls every 60s)", "GET", "/api/outreach/alerts"],
  ["Pipeline", "GET", "/api/outreach"],
];

async function run() {
  console.log(
    `\n${COMPANIES} companies, ${COMPANIES * CONTACTS_EACH} contacts, 20 claimed.\n`
  );
  console.log("screen                        queries    ms   note");
  console.log("─".repeat(74));

  const results = [];
  for (const [label, method, path] of SCREENS) {
    // Warm once so module-load work isn't charged to the first screen.
    await call(method, path);
    queries = 0;
    slow.length = 0;
    const t = Date.now();
    const res = await call(method, path);
    const ms = Date.now() - t;
    results.push({ label, queries, ms, status: res.status });

    const worst = slow.slice().sort((a, b) => b.ms - a.ms)[0];
    console.log(
      `${label.padEnd(30)}${String(queries).padStart(5)}${String(ms).padStart(7)}` +
        (worst && worst.ms > 40 ? `   slowest ${worst.ms}ms: ${worst.text}` : "")
    );
  }

  console.log("\nA first page load fires several of these together:");
  const load = ["Sign-in check", "Tab counts (every page)", "All Leads"];
  const total = results.filter((r) => load.includes(r.label)).reduce((n, r) => n + r.queries, 0);
  console.log(`  ${load.join(" + ")} = ${total} queries`);
  console.log(`  at 10ms of network latency each, that is ~${(total * 10) / 1000}s before anything appears.`);

  const bell = results.find((r) => r.label.startsWith("Bell"));
  console.log(`\nThe bell polls every 60 seconds at ${bell.queries} queries a poll:`);
  console.log(`  ${bell.queries * 60} queries an hour, per person logged in.`);

  server.close();
  process.exit(0);
}
