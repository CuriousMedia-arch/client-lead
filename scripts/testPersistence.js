/**
 * Does the work actually survive a refresh?
 *
 * The other two test scripts stub the database with canned rows, which proves
 * routing and rendering but cannot prove persistence — a canned row comes back
 * whether or not anything was ever written. This one runs a real Postgres
 * (pg-mem, in process) so a write that doesn't land simply isn't there on the
 * next read.
 *
 * Run: node scripts/testPersistence.js     (needs `npm i pg-mem`)
 */
const Module = require("module");
const http = require("http");
const { newDb } = require("pg-mem");

/* ── a real database, in memory ───────────────────────────────────────────── */

const mem = newDb({ autoCreateForeignKeyIndices: true });

// pg-mem doesn't implement every builtin. These are the ones this app touches.
mem.public.registerFunction({
  name: "now", returns: require("pg-mem").DataType.timestamptz, implementation: () => new Date(),
});
mem.registerLanguage("plpgsql", () => () => {});

const SCHEMA = `
create table users (
  id serial primary key, username text, display_name text, role text,
  active boolean default true, alerts_seen_at timestamptz
);
create table sessions (id text primary key, user_id int, expires_at timestamptz);
create table companies (
  id serial primary key, name text, industry text, employees text, revenue text,
  website text, domain text, linkedin text, is_sample boolean default false,
  approval text default 'approved'
);
create table leads (
  id serial primary key, company_id int, owner_id int, claimed_at timestamptz,
  claim_source text, deadline_at timestamptz, closed_at timestamptz, status text default 'new',
  fresh_owner_id int, fresh_claimed_at timestamptz, fresh_deadline_at timestamptz,
  fresh_closed_at timestamptz, fresh_released_at timestamptz, fresh_release_note text,
  in_newspaper boolean default false, fresh_from_newspaper boolean default false,
  deleted_at timestamptz, deleted_by int, delete_reason text,
  tier int, tier_note text, updated_at timestamptz
);
create table company_contacts (
  id serial primary key, company text, name text, role text, email text, phone text,
  phone2 text, linkedin text, owner_id int, claimed_at timestamptz, deadline_at timestamptz,
  closed_at timestamptz, claim_source text, status text default 'new',
  deleted_at timestamptz, is_primary boolean default false, release_note text,
  claim_count int default 0
);
create table signals (
  id serial primary key, lead_id int, company text, title text, summary text,
  signal_type text, why_it_matters text, published timestamptz, created_at timestamptz default now()
);
create table company_blocklist (
  id serial primary key, company text, reason text, created_by int, created_at timestamptz default now()
);
create table opportunities (
  id serial primary key, contact_id int, lead_id int, company text, owner_id int,
  source text default 'all', stage text default 'new',
  service_primary text, service_secondary text, service_optional text,
  service_rationale text, service_source text, service_accepted boolean default false,
  plan_tier text, plan_name text, plan_config jsonb default '{}',
  client_budget numeric, quoted_price numeric, vendor_cost numeric, internal_cost numeric,
  margin_amount numeric, margin_pct numeric,
  approval_status text, approval_note text, approval_reason text,
  approved_by int, approval_at timestamptz,
  next_action text, next_action_at timestamptz,
  last_contacted_at timestamptz, last_reply_at timestamptz,
  won_at timestamptz, lost_at timestamptz, won_value numeric,
  silent_until timestamptz,
  created_at timestamptz default now(), updated_at timestamptz
);
create table opportunity_stages (
  id serial primary key, opportunity_id int, from_stage text, to_stage text,
  user_id int, created_at timestamptz default now()
);
create table opportunity_messages (
  id serial primary key, opportunity_id int, direction text, channel text,
  subject text, body text, sentiment text, intent text, ai_next_action text,
  ai_source text, generated boolean default false, sent_at timestamptz,
  created_by int, created_at timestamptz default now()
);
create table opportunity_followups (
  id serial primary key, opportunity_id int, step int, kind text, due_at date,
  status text default 'due', suggestion text, done_at timestamptz, created_at timestamptz default now()
);
create table opportunity_meetings (
  id serial primary key, opportunity_id int, scheduled_at timestamptz, link text,
  attendees text, outcome text, requirement text, notes text,
  structured jsonb default '{}', created_by int, created_at timestamptz default now()
);
create table opportunity_proposals (
  id serial primary key, opportunity_id int, version int, price numeric, service text,
  plan_name text, body text, change_note text, sent_at timestamptz,
  created_by int, created_at timestamptz default now()
);
create table opportunity_loss (
  opportunity_id int primary key, primary_reason text, secondary_reason text, note text,
  chose text, competitor_name text, competitor_budget numeric, disliked jsonb default '[]',
  could_have_changed text, reapproach boolean, reapproach_days int, reapproach_at date,
  lost_at_stage text, created_by int, created_at timestamptz default now()
);
create table rate_card (
  id serial primary key, service text, tier text, label text, price numeric,
  creators int, views text, deliverables text, active boolean default true, sort int default 0
);
create table pricing_settings (key text primary key, value jsonb, updated_by int, updated_at timestamptz);
create table contact_activity (
  id serial primary key, contact_id int, user_id int, kind text, body text,
  stage text, created_at timestamptz default now()
);
`;

mem.public.none(SCHEMA);

mem.public.none(`
insert into users (username, display_name, role, active) values ('vihith','Vihith','admin',true);
insert into sessions (id, user_id, expires_at) values ('testsid', 1, now() + interval '1 day');
insert into companies (name, industry) values ('Zepto','Quick commerce');
insert into leads (company_id, status) values (1,'new');
insert into company_contacts (company, name, role, email, phone, owner_id, claim_source, deadline_at)
  values ('Zepto','Rahul Sharma','VP Marketing','rahul@zepto.com','98000',1,'all', now() + interval '20 days');
insert into rate_card (service,tier,label,price,creators,views,deliverables,sort) values
  ('Influencer Marketing','starter','Starter',300000,50,'5M','1 Reel',1),
  ('Influencer Marketing','growth','Growth',500000,100,'12M','1 Reel + 2 Stories',2),
  ('Influencer Marketing','scale','Scale',1000000,250,'30M','2 Reels',3);
insert into pricing_settings (key,value) values
  ('cost_model','{"creator_rates":{"nano":3000,"micro":12000,"macro":60000},"internal_cost_pct":10,"geo_multiplier":{"India":1},"language_multiplier":{"Hindi":1},"deliverable_multiplier":{"Reels":1}}'),
  ('guardrail','{"healthy_margin_pct":35,"min_margin_pct":25,"max_discount_pct":20}'),
  ('followup_cadence','{"step1_days":3,"step2_days":7,"step3_days":14,"step4_days":30,"nudge_after_hours":12,"release_after_hours":24}');
`);

const pgAdapter = mem.adapters.createPg();

const realResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) {
  return r === "pg" ? "FAKE_PG" : realResolve.call(this, r, ...rest);
};
require.cache.FAKE_PG = {
  id: "FAKE_PG", filename: "FAKE_PG", loaded: true,
  exports: { ...pgAdapter, types: { setTypeParser() {} } },
};

process.env.DATABASE_URL = "postgres://mem/mem";
process.env.SESSION_CACHE_MS = "0";
delete process.env.GEMINI_API_KEY;

const app = require("../app");
const server = app.listen(0, run);

/* ── driving it ───────────────────────────────────────────────────────────── */

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
          resolve({ status: res.statusCode, json, raw: d.slice(0, 300) });
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

async function run() {
  console.log("\nWorking a lead the way a salesperson would, then reloading it.\n");

  const opened = await call("POST", "/api/outreach/open", { contact_id: 1 });
  if (opened.status !== 200) {
    console.log("could not open an opportunity:", opened.status, opened.raw);
    server.close();
    process.exit(1);
  }
  const id = opened.json.opportunity.id;
  check("Opportunity opens", true, `id ${id}`);

  // 1. Book a meeting.
  const when = new Date(Date.now() + 3 * 864e5).toISOString();
  const meeting = await call("POST", `/api/outreach/${id}/meeting`, {
    scheduled_at: when, link: "https://meet.example", attendees: "Rahul",
  });
  check("Meeting saves", meeting.status === 200, meeting.status === 200 ? null : meeting.raw);
  const meetingId = meeting.json && meeting.json.meeting && meeting.json.meeting.id;

  // 2. Write notes on it.
  const notes = await call("POST", `/api/outreach/meeting/${meetingId}/notes`, {
    notes: "They want pricing by Friday. Budget around 8L.",
    outcome: "need_proposal",
  });
  check("Notes save", notes.status === 200, notes.status === 200 ? null : notes.raw);

  // 3. Set a price.
  const plan = await call("POST", `/api/outreach/${id}/plan`, {
    service: "Influencer Marketing", tier: "growth", price: 500000,
  });
  check("Price saves", plan.status === 200, plan.status === 200 ? null : plan.raw);

  // ---- now RELOAD, exactly as a browser refresh would ----
  console.log("\n  --- refresh ---\n");
  const after = await call("GET", `/api/outreach/${id}`);
  check("Reload works", after.status === 200, after.status === 200 ? null : after.raw);
  const d = after.json || {};

  check("Meeting survived the refresh", (d.meetings || []).length === 1,
    `${(d.meetings || []).length} meetings`);

  const savedNotes = d.meetings && d.meetings[0] && d.meetings[0].notes;
  check("Meeting NOTES survived the refresh", Boolean(savedNotes),
    savedNotes ? `"${savedNotes.slice(0, 40)}…"` : "notes are empty");

  check("History timeline survived the refresh", (d.timeline || []).length > 1,
    `${(d.timeline || []).length} entries: ${(d.timeline || []).map((t) => t.kind).join(", ")}`);

  check("Price survived the refresh", Number(d.opportunity.quoted_price) === 500000,
    `quoted_price = ${d.opportunity.quoted_price}`);

  // ---- the "still not contacted" complaint ----
  console.log("");
  check("Stage moved off 'new' after booking a meeting", d.opportunity.stage !== "new",
    `stage = ${d.opportunity.stage}`);

  const today = await call("GET", "/api/outreach/today");
  const buckets = today.json.buckets || {};
  const where = Object.entries(buckets)
    .filter(([, list]) => list.some((o) => o.id === id))
    .map(([k]) => k);
  check("Lead appears somewhere on Today", where.length > 0,
    where.length ? `in "${where.join(", ")}"` : "in NO bucket — it vanished from Today");
  check("Lead is NOT counted as 'not contacted'", !where.includes("new"),
    `counts: ${JSON.stringify(today.json.counts)}`);

  // ---- All Leads must not still say "new" while a deal is in flight ----
  const contactRow = mem.public.many("select status from company_contacts where id = 1")[0];
  check("Contact status in All Leads follows the outreach stage",
    contactRow.status !== "new", `contact status = ${contactRow.status}`);

  await call("POST", `/api/outreach/${id}/stage`, { stage: "won" });
  const wonRow = mem.public.many("select status, closed_at from company_contacts where id = 1")[0];
  check("Winning marks the contact won and stops its clock",
    wonRow.status === "won" && wonRow.closed_at,
    `status = ${wonRow.status}, closed = ${Boolean(wonRow.closed_at)}`);

  // ---- and the auto-release must not eat a lead being actively worked ----
  console.log("");
  mem.public.none(`update opportunities set silent_until = now() - interval '1 hour'`);
  await call("GET", "/api/outreach/today");
  const survived = await call("GET", `/api/outreach/${id}`);
  check("Auto-release does not delete a lead with a meeting on it",
    survived.status === 200,
    survived.status === 200 ? "still there" : "IT WAS DELETED along with all its history");

  console.log(`\n${pass} passed, ${fail} failed\n`);
  server.close();
  process.exit(fail ? 1 : 0);
}
