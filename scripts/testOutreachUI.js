/**
 * Front-end render test.
 *
 * Loads index.html in jsdom, runs app.js and outreach.js for real, points
 * fetch at the stubbed-database server from testOutreach's harness, and drives
 * the UI: open the tab, walk every sub-view, open the workspace and click the
 * things a salesperson clicks.
 *
 * The point is the render path. A template literal with a typo, a helper that
 * doesn't exist, a handler bound to an element that isn't there — none of that
 * shows up in `node --check`, and all of it is a blank screen in production.
 *
 * Run: node scripts/testOutreachUI.js
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const Module = require("module");
const { JSDOM, VirtualConsole } = require("jsdom");

/* ── same stubbed database as the API test ────────────────────────────────── */

const NOW = new Date().toISOString();
const SOON = new Date(Date.now() + 36e5 * 20).toISOString();

const OPP = {
  id: 1, contact_id: 7, lead_id: null, company: "Zepto", owner_id: 1, source: "all",
  stage: "proposal",
  service_primary: "Influencer Marketing", service_secondary: "Meme Marketing",
  service_optional: "Content Distribution",
  service_rationale: "Gen-Z audience and an active product launch.",
  service_source: "rules", service_accepted: false,
  plan_tier: "growth", plan_name: "Growth — 100 creators",
  plan_config: { geography: "India", language: "Hindi",
                 creator_mix: { nano: 10, micro: 5, macro: 1 }, deliverables: ["Reels"] },
  client_budget: 1000000, quoted_price: 900000,
  vendor_cost: 500000, internal_cost: 50000,
  margin_amount: 350000, margin_pct: 38.9,
  approval_status: null, approval_reason: null, approval_note: null,
  next_action: "Send credentials plus one case study.",
  last_contacted_at: NOW, last_reply_at: NOW,
  won_at: null, lost_at: null, won_value: null,
  created_at: NOW, updated_at: NOW,
  owner_name: "Vihith", contact_name: "Rahul Sharma", contact_role: "VP Marketing",
  contact_email: "rahul@zepto.com", contact_phone: "9800000000", contact_linkedin: null,
  contact_deadline: SOON, industry: "Quick commerce", employees: "5000",
};

function answer(sql, params = []) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  if (/FROM sessions/i.test(s))
    return [{ id: 1, username: "vihith", display_name: "Vihith", role: "admin", active: true,
              expires_at: new Date(Date.now() + 864e5).toISOString() }];
  if (/FROM opportunities o/i.test(s) && /o\.id = /i.test(s)) return [OPP];
  if (/FROM opportunities/i.test(s) && /COUNT/i.test(s))
    return [{ total: 12, won: 3, lost: 4, won_value: 2500000, n: 2 }];
  if (/FROM opportunities/i.test(s)) return [OPP];
  if (/FROM opportunity_followups/i.test(s))
    return [{ id: 1, opportunity_id: 1, step: 1, kind: "reminder", due_at: NOW, status: "due",
              suggestion: "Hi Rahul,\n\nFloating this back up." },
            { id: 2, opportunity_id: 1, step: 2, kind: "value", due_at: NOW, status: "due", suggestion: null }];
  if (/FROM opportunity_meetings/i.test(s))
    return [{ id: 5, opportunity_id: 1, scheduled_at: NOW, link: "https://meet.example",
              attendees: "Rahul", outcome: null, requirement: null, notes: null,
              structured: {}, user_name: "Vihith" }];
  if (/FROM opportunity_proposals/i.test(s))
    return [{ id: 2, version: 2, price: 850000, body: "x", change_note: "matched budget", created_at: NOW, user_name: "Vihith" },
            { id: 1, version: 1, price: 1000000, body: "x", change_note: "First version", created_at: NOW, user_name: "Vihith" }];
  if (/FROM opportunity_stages/i.test(s) && /GROUP BY/i.test(s))
    return [{ stage: "new", n: 40 }, { stage: "contacted", n: 34 },
            { stage: "replied", n: 21 }, { stage: "meeting", n: 18 },
            { stage: "proposal", n: 11 }, { stage: "negotiation", n: 4 },
            { stage: "won", n: 3 }];
  if (/FROM opportunity_stages/i.test(s))
    return [{ id: 1, from_stage: "new", to_stage: "contacted", created_at: NOW, user_name: "Vihith" },
            { id: 2, from_stage: "contacted", to_stage: "proposal", created_at: NOW, user_name: "Vihith" }];
  if (/FROM opportunity_loss/i.test(s))
    return [{ opportunity_id: 1, primary_reason: "budget", reason: "budget", n: 5,
              lost_at_stage: "proposal", reapproach_at: NOW, company: "Zepto", id: 1 }];
  if (/FROM opportunity_messages/i.test(s))
    return [{ id: 1, direction: "in", channel: "email", body: "Please share details.",
              sentiment: "positive", intent: "interested", ai_next_action: "Send the deck.",
              created_at: NOW, user_name: "Vihith" }];
  if (/FROM company_contacts/i.test(s))
    return [{ id: 7, name: "Rahul Sharma", role: "VP Marketing", email: "rahul@zepto.com",
              phone: "9800000000", linkedin: "https://linkedin.com/in/x", company: "Zepto",
              owner_id: 1, claim_source: "all" }];
  if (/FROM rate_card/i.test(s)) {
    const all = [
      { id: 1, service: "Influencer Marketing", tier: "starter", label: "Starter", price: 300000, creators: 50, views: "5M views", deliverables: "1 Reel", active: true, sort: 1 },
      { id: 2, service: "Influencer Marketing", tier: "growth", label: "Growth", price: 500000, creators: 100, views: "12M views", deliverables: "1 Reel + 2 Stories", active: true, sort: 2 },
      { id: 3, service: "Influencer Marketing", tier: "scale", label: "Scale", price: 1000000, creators: 250, views: "30M views", deliverables: "2 Reels", active: true, sort: 3 },
    ];
    // planFor() looks up one tier; the grouped rate-card read wants them all.
    const tier = params.find((p) => ["starter", "growth", "scale"].includes(String(p).toLowerCase()));
    return tier ? all.filter((r) => r.tier === String(tier).toLowerCase()) : all;
  }
  if (/FROM pricing_settings/i.test(s))
    return [{ value: { healthy_margin_pct: 35, min_margin_pct: 25, max_discount_pct: 20,
                       creator_rates: { nano: 3000, micro: 12000, macro: 60000 },
                       internal_cost_pct: 10, geo_multiplier: { India: 1 },
                       language_multiplier: { Hindi: 1 },
                       deliverable_multiplier: { Reels: 1, YouTube: 1.8 } } }];
  if (/FROM signals/i.test(s)) return [{ title: "Zepto raises $350M", summary: "Fresh capital.", signal_type: "capital" }];
  if (/FROM leads/i.test(s)) return [{ id: 3, company: "Zepto", fresh_owner_id: 1, fresh_from_newspaper: false }];
  if (/FROM users/i.test(s)) return [{ n: 1 }];
  if (/FROM companies/i.test(s)) return [{ id: 1, name: "Zepto" }];
  if (/RETURNING/i.test(s)) return [{ id: 99, version: 3, ...OPP }];
  return [{ id: 1, n: 0, v: 2, stage: "proposal", totals: {} }];
}

const realResolve = Module._resolveFilename;
const fakeClient = {
  query: async (t, p) => ({ rows: answer(t.text || t, t.values || p || []), rowCount: 1 }),
  release() {},
};
const fakePg = {
  types: { setTypeParser() {} },
  Pool: class {
    async query(t, p) { return { rows: answer(t.text || t, t.values || p || []), rowCount: 1 }; }
    async connect() { return fakeClient; }
    on() {}
  },
};
Module._resolveFilename = function (r, ...rest) { return r === "pg" ? "FAKE_PG" : realResolve.call(this, r, ...rest); };
require.cache.FAKE_PG = { id: "FAKE_PG", filename: "FAKE_PG", loaded: true, exports: fakePg };

process.env.DATABASE_URL = "postgres://fake/fake";
process.env.SESSION_CACHE_MS = "0";
delete process.env.GEMINI_API_KEY;

const app = require("../app");
const server = app.listen(0, boot);

/* ── boot the page ────────────────────────────────────────────────────────── */

const problems = [];
const notes = [];

async function boot() {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => problems.push(`jsdom: ${e.message}`));

  // The two <script src> tags are stripped and re-injected inline below.
  // jsdom has no resource loader here, and — more importantly — a script has
  // to be a real <script> element for its top-level `const` to land in the
  // global lexical environment. Inside eval() it would not, and app.js and
  // outreach.js share `state`, `api` and `esc` through exactly that scope.
  const html = fs
    .readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8")
    .replace(/<script src="\/(?:app|outreach)\.js"><\/script>/g, "");

  const dom = new JSDOM(html, {
    url: base + "/",
    runScripts: "dangerously",
    virtualConsole: vc,
    pretendToBeVisual: true,
  });

  const { window } = dom;
  window.fetch = makeFetch(base, window);
  window.navigator.clipboard = { writeText: async () => {} };
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.prompt = () => "test note";
  window.onerror = (msg) => problems.push(`window.onerror: ${msg}`);
  window.addEventListener("unhandledrejection", (e) =>
    problems.push(`unhandled rejection: ${e.reason && e.reason.message}`)
  );

  for (const file of ["app.js", "outreach.js"]) {
    const el = window.document.createElement("script");
    el.textContent = fs.readFileSync(path.join(__dirname, "..", "public", file), "utf8");
    window.document.body.appendChild(el);
  }

  // app.js self-boots: /api/auth/me -> enterApp -> renders All Leads.
  await wait(600);

  await drive(window);

  console.log("\n--- notes ---");
  for (const n of notes) console.log(" ", n);
  console.log("\n--- problems ---");
  if (!problems.length) console.log("  (none)");
  for (const p of problems) console.log("  " + p);

  server.close();
  process.exit(problems.length ? 1 : 0);
}

function makeFetch(base, window) {
  return (url, opts = {}) =>
    new Promise((resolve, reject) => {
      const full = url.startsWith("http") ? url : base + url;
      const u = new URL(full);
      const payload = opts.body || null;
      const req = http.request(
        { host: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method || "GET",
          headers: { "Content-Type": "application/json", Cookie: "sid=test",
                     ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}) } },
        (res) => {
          let data = "";
          res.on("data", (d) => (data += d));
          res.on("end", () =>
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              json: async () => JSON.parse(data),
              text: async () => data,
            })
          );
        }
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
}

const wait = (ms = 90) => new Promise((r) => setTimeout(r, ms));

async function drive(window) {
  const doc = window.document;
  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => [...doc.querySelectorAll(s)];
  const click = (el) => el && el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  const check = (label, fn) => {
    try {
      const r = fn();
      if (r === false) problems.push(`${label}: assertion failed`);
      else notes.push(`${label}: ${r === true ? "ok" : r}`);
    } catch (err) {
      problems.push(`${label}: threw — ${err.message}`);
    }
  };

  /* Today */
  const mineTab = $('[data-tab="mine"]');
  if (!mineTab) return problems.push("no My Outreach tab in the page");
  click(mineTab);
  await wait(450);

  check("Today renders slabs", () => `${$$(".today-slabs .stat").length} counts`);
  check("Today renders cards", () => {
    const n = $$(".opp-card").length;
    return n > 0 ? `${n} opportunity cards` : false;
  });
  check("Card shows a next action", () => Boolean($(".opp-next")) || false);
  check("No unrendered template literals", () => {
    // Scan the rendered surfaces only — body.innerHTML also contains the
    // injected <script> elements' own source, which is full of `${`.
    const html = [$("#content"), $("#ws-panel")].filter(Boolean).map((e) => e.innerHTML).join("");
    const i = html.indexOf("${");
    return i === -1 ? true : `found: …${html.slice(Math.max(0, i - 90), i + 90)}…`;
  });

  /* Workspace */
  click($("[data-open-opp]"));
  await wait(250);

  const panel = $("#ws-panel");
  check("Workspace opens", () => (panel && !panel.hidden ? "panel visible" : false));
  check("Workspace has all sections", () => {
    const heads = $$(".ws-section h3").map((h) => h.textContent.trim());
    const want = ["Recommended solution", "Plan & pricing", "Pitch", "Replies",
                  "Follow-up sequence", "Meetings", "Proposal", "Timeline"];
    const missing = want.filter((w) => !heads.some((h) => h.startsWith(w)));
    return missing.length ? `missing ${missing.join(", ")}` : `${heads.length} sections`;
  });
  check("Contact block shows the channels", () => `${$$(".ws-chan").length} channels`);
  check("Guardrail renders", () => {
    const g = $(".guardrail");
    return g ? g.className.replace("guardrail ", "") : false;
  });
  check("Proposal versions show the delta", () => {
    const d = $$(".ver-delta").map((e) => e.textContent.trim());
    return d.length ? d.join(" / ") : false;
  });
  check("Timeline renders", () => `${$$(".tl-row").length} events`);

  /* Pick a plan — the bug that ate the price field */
  const growth = $$("[data-plan]").find((b) => b.dataset.plan === "growth");
  const scale = $$("[data-plan]").find((b) => b.dataset.plan === "scale");
  click(scale);
  await wait(220);
  check("Picking a plan keeps the selection", () =>
    $("[data-plan].is-on") && $("[data-plan].is-on").dataset.plan === "scale"
      ? "scale stays selected"
      : `selected=${$("[data-plan].is-on") && $("[data-plan].is-on").dataset.plan}`);
  check("Picking a plan fills the price", () => {
    const v = Number($("#pb-price").value);
    return v === 1000000 ? "₹10,00,000 prefilled" : `price=${v}`;
  });

  /* Discount it below the floor and confirm the guardrail turns red */
  $("#pb-price").value = "600000";
  click($("#run-quote"));
  await wait(220);
  check("Guardrail blocks a deep discount", () => {
    const g = $(".guardrail");
    if (!g) return false;
    return g.classList.contains("gr-bad") ? "red, approval required" : `tone=${g.className}`;
  });
  check("Typed price survives the repaint", () => Number($("#pb-price").value) === 600000 || `price=${$("#pb-price").value}`);

  /* Generate a pitch and switch channels */
  click($("#gen-pitch"));
  await wait(260);
  check("Pitch generates", () => ($("#pitch-body") && $("#pitch-body").value.length > 40 ? "draft written" : false));
  const waTab = $$("[data-pitch-tab]").find((t) => t.dataset.pitchTab === "whatsapp");
  click(waTab);
  await wait(80);
  check("Channel tabs swap the body", () =>
    $("#pitch-subject-wrap").hidden && $("#pitch-body").value.length > 10
      ? "whatsapp copy shown, subject hidden"
      : false);

  /* Loss interview */
  click($("#open-lost"));
  await wait(80);
  check("Loss interview opens", () => {
    const f = $("#lost-form");
    if (!f || f.hidden) return false;
    const qs = $$("#lost-form .field span").length;
    return `${qs} fields, ${$$("#ls-primary option").length - 1} reasons`;
  });
  check("Loss reasons come from the server", () =>
    $$("#ls-primary option").length >= 15 ? true : `${$$("#ls-primary option").length} options`);

  /* Intelligence */
  click($("#ws-close"));
  await wait(80);
  click($$("[data-oview]").find((b) => b.dataset.oview === "intel"));
  await wait(250);
  check("Intelligence renders the funnel", () => `${$$(".funnel-row").length} rows`);
  check("Funnel bars have width", () => {
    const w = $$(".funnel-bar > i").map((i) => i.style.width).filter(Boolean);
    return w.length ? w.slice(0, 3).join(" ") : "all zero";
  });

  /* Pipeline */
  click($$("[data-oview]").find((b) => b.dataset.oview === "pipeline"));
  await wait(220);
  check("Pipeline renders rows", () => `${$$(".pipe-row").length} rows`);

  /* Pricing (admin) */
  click($$("[data-oview]").find((b) => b.dataset.oview === "pricing"));
  await wait(220);
  check("Rate card is editable", () => `${$$(".rate-row input").length} inputs`);
  check("Guardrail thresholds are editable", () =>
    $("#gr-healthy") && $("#gr-min") && $("#gr-discount") ? true : false);

  check("Still no unrendered template literals", () => {
    // Scan the rendered surfaces only — body.innerHTML also contains the
    // injected <script> elements' own source, which is full of `${`.
    const html = [$("#content"), $("#ws-panel")].filter(Boolean).map((e) => e.innerHTML).join("");
    const i = html.indexOf("${");
    return i === -1 ? true : `found: …${html.slice(Math.max(0, i - 90), i + 90)}…`;
  });
}
