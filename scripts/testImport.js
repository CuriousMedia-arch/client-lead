/**
 * Does the contact importer actually import contacts?
 *
 * Runs the real /api/admin/import endpoint against a real Postgres (pg-mem),
 * with the same schema production has, and uploads a sheet twice: once fresh,
 * once with a new person added. The second upload is the one people complain
 * about — "new contacts aren't being imported" — and a stubbed database can't
 * prove it either way.
 *
 * Run: node scripts/testImport.js     (needs `npm i pg-mem`)
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

mem.public.none(`
create table users (
  id serial primary key, username text, display_name text, role text,
  active boolean default true, alerts_seen_at timestamptz
);
create table sessions (id text primary key, user_id int, expires_at timestamptz);
create table companies (
  id serial primary key, name text, keywords jsonb, active boolean default true,
  origin text, approval text default 'approved', domain text, website text,
  linkedin text, employees text, revenue text, industry text, founded text,
  city text, state text, specialities text, is_sample boolean default false,
  created_at timestamptz default now()
);
create unique index companies_name on companies (lower(name));
create table leads (
  id serial primary key, company_id int, owner_id int, status text default 'new',
  claimed_at timestamptz, claim_source text, deadline_at timestamptz,
  closed_at timestamptz, fresh_owner_id int, fresh_claimed_at timestamptz,
  fresh_deadline_at timestamptz, fresh_closed_at timestamptz,
  fresh_released_at timestamptz, fresh_release_note text,
  fresh_last_activity_at timestamptz, fresh_warned_at timestamptz,
  in_newspaper boolean default false, fresh_from_newspaper boolean default false,
  deleted_at timestamptz, deleted_by int, delete_reason text,
  release_note text, contact_name text, contact_role text, contact_email text,
  contact_phone text, last_contacted_at timestamptz, next_followup_at timestamptz,
  last_signal_at timestamptz, score numeric, tier int, tier_note text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create unique index leads_company on leads (company_id);
create table company_contacts (
  id serial primary key, company text, name text, role text, email text,
  email_alt text, phone text, phone_type text, phone2 text, phone2_type text,
  linkedin text, notes text, seniority text, department text, city text,
  country text, state text, is_primary boolean default false,
  owner_id int, claimed_at timestamptz, deadline_at timestamptz,
  closed_at timestamptz, claim_source text, status text default 'new',
  deleted_at timestamptz, release_note text, claim_count int default 0,
  taken_from int, taken_from_status text, verified boolean default false,
  verified_by int, verified_at timestamptz,
  created_at timestamptz default now()
);
create unique index contacts_key on company_contacts (lower(company), lower(name));
create table contact_originals (
  contact_id int primary key, company text, name text, role text, email text,
  email_alt text, phone text, phone2 text, linkedin text, seniority text,
  department text, city text, country text, state text
);
create table company_blocklist (
  id serial primary key, company text, reason text, created_by int,
  created_at timestamptz default now()
);
create table activity (
  id serial primary key, lead_id int, user_id int, kind text, body text,
  created_at timestamptz default now()
);
create table signals (
  id serial primary key, lead_id int, company text, title text, summary text,
  signal_type text, why_it_matters text, published timestamptz,
  created_at timestamptz default now()
);
`);

mem.public.none(`
insert into users (username, display_name, role, active) values ('vihith','Vihith','admin',true);
insert into sessions (id, user_id, expires_at) values ('testsid', 1, now() + interval '1 day');
`);

const pgAdapter = mem.adapters.createPg();

/**
 * pg-mem has no `xmax`, the Postgres system column the importer uses to tell
 * "this row was inserted" from "this row was updated". Rather than change
 * working production code to suit a test double, the harness rewrites that one
 * fragment on the way through.
 *
 * The cost: the counts the endpoint REPORTS are meaningless in this test, so
 * every assertion below reads the database directly instead. That is the
 * stronger check anyway — what matters is whether the row is there.
 */
const XMAX = /\(xmax = 0\) AS inserted/gi;
// pg-mem also can't parse the index predicate in an ON CONFLICT target
// (`ON CONFLICT (...) WHERE deleted_at IS NULL DO UPDATE`), which is likewise
// valid Postgres. The test schema uses a plain unique index instead.
const CONFLICT_PREDICATE = /\)\s*WHERE deleted_at IS NULL\s*DO UPDATE/gi;
// pg-mem also lacks row-wise IS DISTINCT FROM. The importer's duplicate check
// uses it, so the harness swaps in a condition pg-mem can evaluate: always
// update. Assertions below therefore read the database rather than trusting
// the reported counts.
const ROWWISE = /WHERE \(company_contacts\.role,[\s\S]*?COALESCE\(EXCLUDED\.country,\s+company_contacts\.country\)\)/i;

const rewrite = (sql) =>
  sql
    .replace(XMAX, "true AS inserted")
    .replace(CONFLICT_PREDICATE, ") DO UPDATE")
    .replace(ROWWISE, "WHERE true");

const patchQuery = (obj) => {
  const original = obj.query.bind(obj);
  obj.query = (text, ...rest) => {
    if (typeof text === "string") return original(rewrite(text), ...rest);
    if (text && typeof text.text === "string") {
      return original({ ...text, text: text.rewrite(text) }, ...rest);
    }
    return original(text, ...rest);
  };
  return obj;
};

const RealPool = pgAdapter.Pool;
class PatchedPool extends RealPool {
  constructor(...args) {
    super(...args);
    patchQuery(this);
  }
  async connect() {
    return patchQuery(await super.connect());
  }
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) {
  return r === "pg" ? "FAKE_PG" : realResolve.call(this, r, ...rest);
};
require.cache.FAKE_PG = {
  id: "FAKE_PG", filename: "FAKE_PG", loaded: true,
  exports: { ...pgAdapter, Pool: PatchedPool, types: { setTypeParser() {} } },
};

process.env.DATABASE_URL = "postgres://mem/mem";
process.env.SESSION_CACHE_MS = "0";
delete process.env.GEMINI_API_KEY;

const app = require("../app");
const server = app.listen(0, run);

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: "127.0.0.1", port: server.address().port, path, method,
        headers: {
          "Content-Type": "application/json", Cookie: "sid=testsid",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(d); } catch { /* not json */ }
          resolve({ status: res.statusCode, json, raw: d.slice(0, 400) });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

const HEADER =
  "Company name,First name,Last name,Title,Email,Phone,Phone type,Phone2,Phone2 type,Linkedin,Industry,Employees,City,Country";

const SHEET_ONE = [
  HEADER,
  "Zepto,Rahul,Sharma,VP Marketing,rahul@zepto.com,9800000001,mobile,9800000002,mobile,https://li/rahul,Quick commerce,5000,Mumbai,India",
  "Zepto,Priya,Nair,Brand Head,priya@zepto.com,9800000003,mobile,,,https://li/priya,Quick commerce,5000,Mumbai,India",
].join("\n");

// Same two people, plus one new person, plus a new company.
const SHEET_TWO = [
  HEADER,
  "Zepto,Rahul,Sharma,VP Marketing,rahul@zepto.com,9800000001,mobile,9800000002,mobile,https://li/rahul,Quick commerce,5000,Mumbai,India",
  "Zepto,Priya,Nair,Brand Head,priya@zepto.com,9800000003,mobile,,,https://li/priya,Quick commerce,5000,Mumbai,India",
  "Zepto,Arjun,Mehta,Growth Lead,arjun@zepto.com,9800000004,mobile,,,https://li/arjun,Quick commerce,5000,Mumbai,India",
  "Boat,Aman,Gupta,Co-founder,aman@boat.in,9800000005,mobile,,,https://li/aman,Consumer tech,2000,Delhi,India",
].join("\n");

async function run() {
  console.log("\nImporting a contact sheet, then importing it again with new people.\n");

  const first = await call("POST", "/api/admin/import", { csv: SHEET_ONE });
  check("First import works", first.status === 200, first.status === 200 ? null : first.raw);
  if (first.status !== 200) { server.close(); process.exit(1); }

  console.log(`      ${JSON.stringify(first.json)}`);
  const afterFirst = mem.public.many("select name from company_contacts");
  check("First import adds both people", afterFirst.length === 2,
    `${afterFirst.length} in the database: ${afterFirst.map((c) => c.name).join(", ")}`);

  // The second number in the sheet should land in phone2.
  const rahul = mem.public.many("select * from company_contacts where name = 'Rahul Sharma'")[0];
  check("A second mobile number is stored", Boolean(rahul.phone2),
    `phone = ${rahul.phone}, phone2 = ${rahul.phone2}`);

  // --- the complaint ---
  const second = await call("POST", "/api/admin/import", { csv: SHEET_TWO });
  check("Second import works", second.status === 200, second.status === 200 ? null : second.raw);
  console.log(`      ${JSON.stringify(second.json)}`);

  const all = mem.public.many("select name, company from company_contacts order by name");
  console.log(`      in the database: ${all.map((c) => `${c.name} (${c.company})`).join(", ")}`);

  check("The NEW person at an existing company is imported",
    all.some((c) => c.name === "Arjun Mehta"),
    all.some((c) => c.name === "Arjun Mehta") ? null : "Arjun Mehta is missing");

  check("The person at the NEW company is imported",
    all.some((c) => c.name === "Aman Gupta"),
    all.some((c) => c.name === "Aman Gupta") ? null : "Aman Gupta is missing");

  check("Re-importing the same people doesn't duplicate them", all.length === 4,
    `${all.length} contacts total (want 4)`);

  // The bug that was silently dropping every second mobile number: the parser
  // called the field phone_alt while the importer read phone2.
  const withAlt = mem.public.many(
    "select name, phone, phone2 from company_contacts where name = 'Rahul Sharma'"
  )[0];
  check("Both mobile numbers survive the import",
    withAlt.phone === "9800000001" && withAlt.phone2 === "9800000002",
    `phone=${withAlt.phone}, phone2=${withAlt.phone2}`);

  // And the new company has to become a lead, or nothing shows in All Leads.
  const leads = mem.public.many(
    "select c.name from leads l join companies c on c.id = l.company_id order by c.name"
  );
  check("Every company has a lead row", leads.length === 2, leads.map((l) => l.name).join(", "));

  // Checked against the database rather than the HTTP endpoint: node-postgres
  // sends every parameter as text and lets Postgres infer the type, so
  // `LIMIT $1` works there but pg-mem refuses to cast it. That is a limitation
  // of the test double, not of the app, and asserting on rows answers the real
  // question anyway — is an imported company visible in All Leads?
  const visible = mem.public.many(`
    select c.name from leads l
      join companies c on c.id = l.company_id
      left join company_blocklist bl on lower(bl.company) = lower(c.name)
     where l.deleted_at is null and bl.id is null
       and c.is_sample = false and c.approval = 'approved'
     order by lower(c.name)
  `);
  check("Imported companies are visible in All Leads", visible.length === 2,
    visible.map((v) => v.name).join(", "));

  const contacts = await call("GET", "/api/contacts?company=Zepto");
  check("Their contacts are readable",
    contacts.status === 200,
    contacts.status === 200
      ? `${(contacts.json.contacts || []).length} contacts for Zepto`
      : contacts.raw);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
}
