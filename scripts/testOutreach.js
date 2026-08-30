/**
 * Smoke test for the outreach module.
 *
 * There is no Postgres here, so `pg` is stubbed: every query is recorded to
 * /tmp/outreach-sql.txt (checked separately against a real Postgres parser)
 * and answered with a canned row shaped like the real one. That is enough to
 * prove the routing, the auth guards, the JSON contracts and the JS itself,
 * which is where the bugs actually live.
 *
 * Run: node scripts/testOutreach.js
 */
const Module = require("module");
const fs = require("fs");
const http = require("http");

const SQL_LOG = "/tmp/outreach-sql.txt";
fs.writeFileSync(SQL_LOG, "");

/* ── canned rows, keyed by what the query is obviously asking for ─────────── */

const NOW = new Date().toISOString();

const OPP = {
  id: 1, contact_id: 7, lead_id: null, company: "Zepto", owner_id: 1, source: "all",
  stage: "contacted",
  service_primary: "Influencer Marketing", service_secondary: "Meme Marketing",
  service_optional: null, service_rationale: "Gen-Z audience, active launch.",
  service_source: "rules", service_accepted: false,
  plan_tier: "growth", plan_name: "Growth — 100 creators",
  plan_config: { geography: "India", language: "Hindi", creator_mix: { nano: 10, micro: 5, macro: 1 }, deliverables: ["Reels"] },
  client_budget: 1000000, quoted_price: 900000,
  vendor_cost: 500000, internal_cost: 50000,
  margin_amount: 350000, margin_pct: 38.9,
  approval_status: null, approval_reason: null,
  next_action: null, last_contacted_at: NOW, last_reply_at: null,
  won_at: null, lost_at: null, won_value: null,
  created_at: NOW, updated_at: NOW,
  owner_name: "Vihith", contact_name: "Rahul Sharma", contact_role: "VP Marketing",
  contact_email: "rahul@zepto.com", contact_phone: "9800000000",
  contact_deadline: new Date(Date.now() + 4 * 864e5).toISOString(),
  industry: "Quick commerce", employees: "5000",
};

// Flipped on for the send-or-lose-it case so the sweep has something to find.
let sweepDue = false;
const released = [];

function answer(sql) {
  // Log the RAW statement, newlines intact. Collapsing whitespace first turned
  // every `-- comment` in a query into one that swallowed the rest of the
  // statement, so the SQL validator reported syntax errors in SQL that is
  // perfectly valid as written.
  fs.appendFileSync(SQL_LOG, sql + "\n;;;\n");

  const s = sql.replace(/\s+/g, " ").trim();
  released.push(s);

  if (/FROM sessions/i.test(s))
    return [{ id: 1, username: "vihith", display_name: "Vihith", role: "admin", active: true,
              expires_at: new Date(Date.now() + 864e5).toISOString() }];
  if (/FROM opportunities o/i.test(s) && /o\.id = /i.test(s)) return [OPP];
  // The alerts query joins subselects the generic OPP row doesn't carry, and
  // OPP itself is deliberately in a calm state — so give this one a row that
  // is actually overdue, or the test proves nothing.
  if (/hours_idle/i.test(s))
    return [{
      id: 1, company: "Zepto", stage: "contacted", next_action: null,
      approval_status: null, last_reply_at: null, last_contacted_at: NOW,
      contact_name: "Rahul Sharma",
      deadline_at: new Date(Date.now() + 6 * 36e5).toISOString(),   // 6h left
      followup_due: new Date(Date.now() - 2 * 864e5).toISOString(),
      followup_step: 1, meeting_at: null, hours_idle: 96,
      silent_until: null, deadline_at: null, deadline_kind: null,
      updated_at: NOW, hours_to_release: null,
    }];
  if (/FROM opportunities/i.test(s) && /COUNT/i.test(s))
    return [{ total: 12, won: 3, lost: 4, won_value: 2500000, n: 2 }];
  // sweepSilent's own query — return nothing so the sweep is a no-op here and
  // the other cases aren't fighting a delete they didn't ask for.
  if (/deadline_at IS NOT NULL/i.test(s))
    return sweepDue
      ? [{ id: 1, contact_id: 7, lead_id: null, source: "all", company: "Zepto" }]
      : [];
  if (/FROM opportunities/i.test(s)) return [OPP];
  if (/FROM opportunity_followups/i.test(s))
    return [{ id: 1, opportunity_id: 1, step: 1, kind: "reminder", due_at: NOW, status: "due", suggestion: null }];
  if (/FROM opportunity_meetings/i.test(s))
    return [{ id: 5, opportunity_id: 1, scheduled_at: NOW, link: null, attendees: null,
              outcome: null, requirement: null, notes: null, structured: {}, user_name: "Vihith" }];
  if (/FROM opportunity_proposals/i.test(s))
    return [{ id: 2, opportunity_id: 1, version: 2, price: 850000, body: "…", change_note: "matched budget", created_at: NOW, user_name: "Vihith" },
            { id: 1, opportunity_id: 1, version: 1, price: 1000000, body: "…", change_note: "First version", created_at: NOW, user_name: "Vihith" }];
  if (/FROM opportunity_stages/i.test(s))
    return [{ id: 1, opportunity_id: 1, from_stage: "new", to_stage: "contacted", created_at: NOW, user_name: "Vihith", stage: "proposal", n: 4 }];
  if (/FROM opportunity_loss/i.test(s))
    return [{ opportunity_id: 1, primary_reason: "budget", reason: "budget", n: 5, lost_at_stage: "proposal",
              reapproach_at: NOW, company: "Zepto", id: 1 }];
  if (/FROM opportunity_messages/i.test(s))
    return [{ id: 1, direction: "in", channel: "email", body: "Please share details.",
              sentiment: "positive", intent: "interested", ai_next_action: "Send the deck.",
              created_at: NOW, user_name: "Vihith" }];
  if (/FROM company_contacts/i.test(s))
    return [{ id: 7, name: "Rahul Sharma", role: "VP Marketing", email: "rahul@zepto.com",
              phone: "9800000000", linkedin: null, company: "Zepto", owner_id: 1, claim_source: "all" }];
  if (/FROM rate_card/i.test(s))
    return [{ id: 1, service: "Influencer Marketing", tier: "growth", label: "Growth",
              price: 500000, creators: 100, views: "12M views", deliverables: "1 Reel", active: true, sort: 2 }];
  if (/FROM pricing_settings/i.test(s))
    return [{ value: { healthy_margin_pct: 35, min_margin_pct: 25, max_discount_pct: 20,
                       creator_rates: { nano: 3000, micro: 12000, macro: 60000 },
                       internal_cost_pct: 10,
                       geo_multiplier: { India: 1 }, language_multiplier: { Hindi: 1 },
                       deliverable_multiplier: { Reels: 1, YouTube: 1.8 } } }];
  if (/FROM signals/i.test(s))
    return [{ title: "Zepto raises $350M", summary: "Fresh capital.", signal_type: "capital" }];
  if (/FROM leads/i.test(s)) return [{ id: 3, company: "Zepto", fresh_owner_id: 1, fresh_from_newspaper: false }];
  if (/alerts_seen_at/i.test(s)) return [{ alerts_seen_at: null }];
  if (/FROM company_blocklist/i.test(s)) return [{ id: 1, company: "Zepto", reason: "x" }];
  if (/FROM content_templates/i.test(s))
    return [{ key: "deck_link", label: "Deck", body: "", hint: "", sort: 3 }];
  if (/FROM google_accounts/i.test(s)) return [];
  if (/FROM opportunity_execution/i.test(s)) return [];
  if (/FROM users/i.test(s)) return [{ n: 1 }];
  if (/RETURNING/i.test(s)) return [{ id: 99, version: 3, ...OPP }];
  return [{ id: 1, n: 0, v: 2, stage: "contacted" }];
}

/* ── stub `pg` before anything requires it ────────────────────────────────── */

const realResolve = Module._resolveFilename;
const fakeClient = {
  query: async (text) => ({ rows: answer(typeof text === "string" ? text : text.text), rowCount: 1 }),
  release() {},
};
const fakePg = {
  types: { setTypeParser() {} },
  Pool: class {
    async query(text) { return { rows: answer(typeof text === "string" ? text : text.text), rowCount: 1 }; }
    async connect() { return fakeClient; }
    on() {}
  },
};
Module._resolveFilename = function (request, ...rest) {
  if (request === "pg") return "FAKE_PG";
  return realResolve.call(this, request, ...rest);
};
require.cache.FAKE_PG = { id: "FAKE_PG", filename: "FAKE_PG", loaded: true, exports: fakePg };

process.env.DATABASE_URL = "postgres://fake/fake";
process.env.SESSION_CACHE_MS = "0";
delete process.env.GEMINI_API_KEY;      // force the rules fallbacks

const app = require("../app");

/* ── drive it ─────────────────────────────────────────────────────────────── */

const server = app.listen(0, run);

function call(method, path, body) {
  return callWith(method, path, body, {});
}

function callWith(method, path, body, extraHeaders) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: "127.0.0.1", port: server.address().port, path, method,
        headers: {
          "Content-Type": "application/json",
          Cookie: "sid=testsession",
          ...extraHeaders,
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, json, raw: data.slice(0, 200) });
        });
      }
    );
    if (payload) req.write(payload);
    req.end();
  });
}

const CASES = [
  ["POST", "/api/outreach/sync"],
  ["GET",  "/api/outreach/today"],
  ["GET",  "/api/outreach/alerts"],
  ["POST", "/api/outreach/alerts/seen"],
  ["DELETE", "/api/leads/3", { blocklist: false, reason: "junk story" }],
  ["DELETE", "/api/leads/3", { blocklist: true, reason: "never a client" }],
  ["GET",  "/api/leads/meta/blocklist"],
  ["GET",  "/api/outreach"],
  ["POST", "/api/outreach/open", { contact_id: 7 }],
  ["GET",  "/api/outreach/1"],
  ["GET",  "/api/outreach/meta/rate-card"],
  ["POST", "/api/outreach/quote", { service: "Influencer Marketing", tier: "growth", price: 500000 }],
  ["POST", "/api/outreach/quote", { service: "Influencer Marketing", tier: "custom",
      plan_config: { geography: "India", language: "Hindi", creator_mix: { nano: 20, micro: 10, macro: 2 }, deliverables: ["Reels", "YouTube"] },
      price: 700000 }],
  ["POST", "/api/outreach/1/recommend-service"],
  ["POST", "/api/outreach/1/service", { primary: "Meme Marketing" }],
  ["POST", "/api/outreach/1/plan", { service: "Influencer Marketing", tier: "growth", price: 300000 }],
  ["POST", "/api/outreach/1/pitch"],
  ["POST", "/api/outreach/1/sent", { channel: "email", subject: "Hi", body: "Test body" }],
  ["POST", "/api/outreach/1/reply", { body: "Sounds interesting. Send me your deck." }],
  ["POST", "/api/outreach/1/reply", { body: "We already have an agency, thanks." }],
  ["POST", "/api/outreach/1/followup/1/draft"],
  ["POST", "/api/outreach/1/followup/1/done"],
  ["POST", "/api/outreach/1/meeting", { scheduled_at: NOW, link: "https://meet" }],
  ["POST", "/api/outreach/meeting/5/notes", { notes: "They want pricing by Friday." }],
  ["POST", "/api/outreach/1/proposal/draft"],
  ["POST", "/api/outreach/1/proposal", { price: 750000, body: "Body", change_note: "discount" }],
  ["POST", "/api/outreach/1/stage", { stage: "negotiation" }],
  ["POST", "/api/outreach/1/stage", { stage: "lost" }],           // must be rejected
  ["POST", "/api/outreach/1/lost", { primary_reason: "budget", chose: "competitor",
      could_have_changed: "A lower price", reapproach: "yes", reapproach_days: 60, disliked: ["price"] }],
  ["POST", "/api/outreach/1/lost", { primary_reason: "nonsense" }], // must be rejected
  ["GET",  "/api/outreach/meta/intelligence"],
  ["GET",  "/api/outreach/meta/approvals"],
  ["GET",  "/api/outreach/meta/templates"],
  ["GET",  "/api/outreach/1/execution"],
  ["POST", "/api/outreach/1/execution", { deliverable: "50 reels", due_date: "2026-09-30", owner_name: "Riya" }],
  ["GET",  "/api/google/status"],
  ["POST", "/api/outreach/1/approval", { decision: "approve" }],
  ["PUT",  "/api/outreach/meta/rate-card", { rows: [{ service: "Meme Marketing", tier: "growth", price: 400000 }],
      guardrail: { healthy_margin_pct: 40, min_margin_pct: 30, max_discount_pct: 15 },
      followup_cadence: { step1_days: 1, step2_days: 4, step3_days: 10, step4_days: 21, nudge_after_hours: 12 } }],
];

const EXPECT_REJECT = new Set([
  'POST /api/outreach/1/stage {"stage":"lost"}',
  'POST /api/outreach/1/lost {"primary_reason":"nonsense"}',
]);

async function run() {
  let pass = 0, fail = 0;

  for (const [method, path, body] of CASES) {
    const key = `${method} ${path}${body ? " " + JSON.stringify(body) : ""}`;
    const res = await call(method, path, body);
    const shouldReject = [...EXPECT_REJECT].some((k) => key.startsWith(k.slice(0, k.indexOf("{"))) && k === key);

    const ok = shouldReject ? res.status === 400 : res.status === 200;
    if (ok) pass++;
    else {
      fail++;
      console.log(`FAIL  ${method} ${path} -> ${res.status}  ${res.raw}`);
    }
  }

  // Spot-check the guardrail arithmetic rather than only that it responded.
  const cheap = await call("POST", "/api/outreach/quote", {
    service: "Influencer Marketing", tier: "growth", price: 350000,
  });
  const q = cheap.json.quote;
  console.log(`\nguardrail on a discounted plan: ${q.status} (${q.margin_pct}% margin, ${q.discount_pct}% off) approval=${q.requires_approval}`);
  if (!q.requires_approval) { console.log("FAIL  a 30% discount should require approval"); fail++; } else pass++;

  const healthy = await call("POST", "/api/outreach/quote", {
    service: "Influencer Marketing", tier: "growth", price: 500000,
  });
  console.log(`guardrail at list price: ${healthy.json.quote.status} (${healthy.json.quote.margin_pct}%)`);
  if (healthy.json.quote.requires_approval) { console.log("FAIL  list price should not need approval"); fail++; } else pass++;

  // The classifier fallback must tell a rejection from an objection.
  const ai = require("../lib/outreachAI");
  const checks = [
    ["Not interested, thanks.", "rejection"],
    ["We already have an agency.", "objection"],
    ["Sounds good, can we set up a call?", "meeting"],
    ["Please share your deck and pricing.", "interested"],
  ];
  for (const [text, expected] of checks) {
    const got = ai.classifyReplyByRules(text).intent;
    if (got === expected) pass++;
    else { fail++; console.log(`FAIL  classify "${text}" -> ${got}, expected ${expected}`); }
  }

  const alerts = await call("GET", "/api/outreach/alerts");
  const items = (alerts.json && alerts.json.items) || [];
  console.log(`\nbell: ${items.length} alert(s) — ${items.map((i) => i.kind).join(", ") || "none"}`);
  if (!items.length) { console.log("FAIL  an overdue opportunity should raise a bell alert"); fail++; }
  else pass++;

  // --- send-or-lose-it ----------------------------------------------------
  // Point the stub at one overdue, never-contacted opportunity and confirm the
  // sweep hands the claim back and clears the opportunity.
  released.length = 0;
  sweepDue = true;
  await call("GET", "/api/outreach/today");
  sweepDue = false;
  const gaveBack = released.some((q) => /UPDATE company_contacts/i.test(q) && /owner_id = NULL/i.test(q));
  const cleared = released.some((q) => /DELETE FROM opportunities/i.test(q));
  console.log(`\nsend-or-lose-it: claim released=${gaveBack}, opportunity cleared=${cleared}`);
  if (gaveBack && cleared) pass++;
  else { console.log("FAIL  an unworked lead should go back to the pool"); fail++; }

  // --- the cron doorbell ---------------------------------------------------
  // Auth first: an endpoint that releases other people's leads must not be
  // callable by anyone who guesses the URL.
  const noSecret = await call("GET", "/api/cron/sweep");
  if (noSecret.status === 401) pass++;
  else { console.log(`FAIL  cron with no secret returned ${noSecret.status}, want 401`); fail++; }

  process.env.CRON_SECRET = "test-secret";

  const wrongSecret = await callWith("GET", "/api/cron/sweep", null, { "x-cron-secret": "nope" });
  if (wrongSecret.status === 401) pass++;
  else { console.log(`FAIL  cron with a wrong secret returned ${wrongSecret.status}, want 401`); fail++; }

  // And with the right secret it must run the SAME sweep the routes run.
  released.length = 0;
  sweepDue = true;
  const good = await callWith("GET", "/api/cron/sweep", null, { "x-cron-secret": "test-secret" });
  sweepDue = false;
  const cronReleased = released.some((q) => /UPDATE company_contacts/i.test(q) && /owner_id = NULL/i.test(q));
  console.log(`\ncron endpoint: ${good.status}, released a claim=${cronReleased}`);
  if (good.status === 200 && cronReleased) pass++;
  else { console.log("FAIL  authorised cron should run the sweeps"); fail++; }

  const bearer = await callWith("GET", "/api/cron/sweep", null, { Authorization: "Bearer test-secret" });
  if (bearer.status === 200) pass++;
  else { console.log(`FAIL  Bearer auth returned ${bearer.status}, want 200`); fail++; }

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail ? 1 : 0);
}
