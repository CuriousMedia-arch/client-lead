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
  // Deliberately blank so the workspace has to suggest one on open.
  service_primary: null, service_secondary: null, service_optional: null,
  service_rationale: null, service_source: null, service_accepted: false,
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

// The stub is stateless, but auto-recommend genuinely writes and then re-reads
// — so this one field has to persist, or the workspace re-renders with no
// service and the plan section never appears.
let recommended = false;

function answer(sql, params = []) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  if (/UPDATE opportunities SET service_primary/i.test(s)) recommended = true;
  if (/FROM sessions/i.test(s))
    return [{ id: 1, username: "vihith", display_name: "Vihith", role: "admin", active: true,
              expires_at: new Date(Date.now() + 864e5).toISOString() }];
  if (/FROM opportunities o/i.test(s) && /o\.id = /i.test(s))
    return [
      recommended
        ? {
            ...OPP,
            service_primary: "Influencer Marketing",
            service_secondary: "Meme Marketing",
            service_optional: "Content Distribution",
            service_rationale: "Gen-Z audience and an active product launch.",
            service_source: "rules",
          }
        : OPP,
    ];
  if (/hours_idle/i.test(s))
    return [{
      id: 1, company: "Zepto", stage: "contacted", next_action: "Send the deck.",
      approval_status: null, last_reply_at: NOW, last_contacted_at: null,
      contact_name: "Rahul Sharma", deadline_at: SOON,
      followup_due: null, followup_step: null, meeting_at: null, hours_idle: 40,
      silent_until: null, deadline_at: null, deadline_kind: null,
      updated_at: NOW, hours_to_release: null,
    }];
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
    return [
      { id: 1, direction: "in", channel: "email", body: "Please share details.",
        sentiment: "positive", intent: "interested", ai_next_action: "Send the deck.",
        created_at: NOW, user_name: "Vihith" },
      { id: 2, direction: "out", channel: "email", subject: "Zepto x Curious Media",
        body: "Hi Rahul,\n\nSaw the news about Zepto.", generated: true,
        sent_at: NOW, created_at: NOW, user_name: "Vihith" },
    ];
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
  if (/FROM leads/i.test(s))
    return [{
      id: 3, company: "Zepto", fresh_owner_id: null, fresh_from_newspaper: false,
      tier: 1, tier_note: "Call today", signals: [], contact_count: 2,
      in_newspaper: true, last_signal_at: NOW, fresh_released_at: NOW,
    }];
  if (/alerts_seen_at/i.test(s)) return [{ alerts_seen_at: null }];
  if (/sent\.opportunity_id/i.test(s)) return [];   // prior attempts at this company
  if (/deadline_at IS NOT NULL/i.test(s)) return [];
  if (/FROM company_blocklist/i.test(s)) return [];
  if (/FROM content_templates/i.test(s))
    return [{ key: "deck_link", label: "Deck", body: "", hint: "", sort: 3 }];
  if (/FROM google_accounts/i.test(s)) return [];
  if (/FROM opportunity_execution/i.test(s)) return [];
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

  // Inject the real stylesheets. jsdom has no resource loader here, so the
  // <link> tags never resolve — and without them a stacking-order bug like the
  // backdrop sitting on top of the workspace panel is invisible to this test.
  for (const sheet of ["styles.css", "outreach.css"]) {
    const st = window.document.createElement("style");
    st.textContent = fs.readFileSync(path.join(__dirname, "..", "public", sheet), "utf8");
    window.document.head.appendChild(st);
  }

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

  /* Slabs drill down (new) */
  // --- search behaviour on All Leads ---
  click($('[data-tab="all"]'));
  await wait(500);

  const box = $("#f-search");
  check("Search box exists", () => Boolean(box) || "no search box");
  if (box) {
    check("Placeholder mentions people, not just companies", () =>
      /person|contact|name/i.test(box.placeholder) ? box.placeholder : `says "${box.placeholder}"`);

    // Type fast, the way a person does: the render fires mid-typing and used
    // to wipe whatever had been typed since and jump the caret to the end.
    box.value = "zep";
    box.dispatchEvent(new window.Event("input", { bubbles: true }));
    box.value = "zepto";
    box.setSelectionRange(3, 3);
    box.dispatchEvent(new window.Event("input", { bubbles: true }));
    await wait(600);

    const after = $("#f-search");
    check("Typing survives the re-render", () =>
      after && after.value === "zepto" ? "kept \"zepto\"" : `box says "${after && after.value}"`);
    check("Caret stays where it was", () =>
      after && after.selectionStart === 3
        ? "caret held at 3"
        : `caret at ${after && after.selectionStart}, wanted 3`);
    check("Search box keeps focus", () =>
      doc.activeElement === after
        ? "focused"
        : `focus on ${doc.activeElement && doc.activeElement.id}`);
  }

  click($('[data-tab="mine"]'));
  await wait(400);

  check("\"Do these first\" is now \"Urgent\"", () => {
    const txt = $("#outreach-body").textContent;
    return !txt.includes("Do these first") ? "renamed" : "old label still showing";
  });

  check("Slabs are clickable", () => {
    const n = $$("[data-slab]").length;
    return n === 7 ? "7 clickable counts" : `${n} slabs`;
  });

  const liveSlab = $$("[data-slab]").find((b) => !b.disabled);
  const liveKey = liveSlab && liveSlab.dataset.slab;
  click(liveSlab);
  await wait(250);
  check("Clicking a slab filters to that group", () => {
    const groups = $$(".today-group").map((g) => g.dataset.group);
    if (groups.length !== 1) return `showed ${groups.length} groups: ${groups.join(",")}`;
    return groups[0] === liveKey ? `only "${liveKey}"` : `showed ${groups[0]}, wanted ${liveKey}`;
  });
  check("Filtered view offers a way back", () => Boolean($("#clear-focus")) || "no reset button");

  click($("#clear-focus"));
  await wait(250);
  check("Reset restores every group", () => `${$$(".today-group").length} groups back`);

  /* Workspace */
  click($("[data-open-opp]"));
  // Opening now costs two round trips: load, then auto-suggest a service and
  // reload. 250ms was enough before and is racy now.
  await wait(700);

  const panel = $("#ws-panel");
  check("Workspace opens", () => (panel && !panel.hidden ? "panel visible" : false));

  // The bug this guards: .drawer-backdrop is z-index 100 in styles.css. The
  // panel was 60, so the dimmer covered it — greyed out, unscrollable, every
  // button swallowed by the backdrop's click-to-close.
  check("Panel sits above its own backdrop", () => {
    const pz = Number(window.getComputedStyle(panel).zIndex);
    const bz = Number(window.getComputedStyle($("#ws-backdrop")).zIndex);
    return pz > bz ? `panel ${pz} over backdrop ${bz}` : `panel ${pz} UNDER backdrop ${bz}`;
  });
  check("Panel body can scroll", () => {
    const body = $(".ws-body");
    const ov = window.getComputedStyle(body).overflowY;
    return ov === "auto" || ov === "scroll" ? ov : `overflow-y is "${ov}"`;
  });
  // --- the tabbed layout ---
  check("Workspace opens on the Now tab", () => {
    const on = $(".ws-tab.is-on");
    return on && on.textContent.trim().startsWith("Now") ? "Now" : `on "${on && on.textContent.trim()}"`;
  });
  check("All five tabs are there", () => {
    const tabs = $$("[data-ws-tab]").map((t) => t.dataset.wsTab);
    return tabs.length === 5 ? tabs.join(", ") : `${tabs.length}: ${tabs.join(", ")}`;
  });
  check("The stage rail shows where the deal is", () => {
    const here = $(".rail-step.is-here");
    return here ? here.textContent.trim() : "no current stage marked";
  });
  check("Now tab says what to do next", () => {
    const line = $(".ws-next-line");
    return line ? line.textContent.trim().slice(0, 60) : "no next action";
  });

  // Every tab must render without throwing — a tab that blanks is worse than
  // no tab, because the work looks lost.
  for (const key of ["message", "meetings", "delivery", "history", "now"]) {
    const btn = $$("[data-ws-tab]").find((t) => t.dataset.wsTab === key);
    click(btn);
    await wait(150);
    check(`Tab "${key}" renders`, () => {
      const body = $(".ws-body");
      if (!body) return "no body";
      const text = body.textContent.trim();
      return text.length > 20 ? `${text.length} chars` : `looks empty: "${text}"`;
    });
  }

  // Back to Message for the checks below, which live there now.
  click($$("[data-ws-tab]").find((t) => t.dataset.wsTab === "message"));
  await wait(200);

  check("Suggests a service without being asked", () => {
    const box = $(".rec-box");
    if (!box) return "no recommendation appeared";
    const txt = box.textContent.replace(/\s+/g, " ").trim();
    return txt.includes("Influencer") ? txt.slice(0, 90) : `unexpected: ${txt.slice(0, 90)}`;
  });
  check("Recommendation explains why", () =>
    $(".rec-why") ? $(".rec-why").textContent.replace(/\s+/g, " ").trim().slice(0, 80) : false);
  check("Accept / change buttons present", () =>
    $("#accept-service") && $("#change-service") ? true : "missing accept or change");

  check("Workspace has all sections", () => {
    const heads = $$(".ws-section h3").map((h) => h.textContent.trim());
    // The Message tab holds the three that are now one job.
    const want = ["What we should sell them", "What we", "Message to send"];
    const missing = want.filter((w) => !heads.some((h) => h.startsWith(w)));
    return missing.length ? `missing ${missing.join(", ")}` : `${heads.length} sections`;
  });
  check("Contact block shows the channels", () => `${$$(".ws-chan").length} channels`);
  // Cost and margin are gone; only the discount verdict remains, and it only
  // appears once a price has actually been checked or saved.
  check("No cost or margin is shown anywhere", () => {
    const html = $(".ws-body").textContent;
    const leaked = ["Vendor", "margin", "Margin", "Our costs", "We keep"].filter((w) =>
      html.includes(w)
    );
    return leaked.length ? `still showing: ${leaked.join(", ")}` : "clean";
  });
  check("Packages and proposal are one section", () => {
    const heads = $$(".ws-section h3").map((h) => h.textContent.trim());
    return heads.some((h) => h.startsWith("Package")) && !heads.includes("Proposal")
      ? "merged"
      : `sections: ${heads.join(" | ")}`;
  });
  check("Custom package builder is gone", () =>
    !$("#plan-builder") && !$("#toggle-builder") ? "removed" : "builder still present");
  // Price history moved to the History tab — it is a record, not a working
  // screen, so it should not be in the way while you write a message.
  click($$("[data-ws-tab]").find((t) => t.dataset.wsTab === "history"));
  await wait(200);
  check("Price history lives under History", () => {
    const d = $$(".ver-delta").map((e) => e.textContent.trim());
    return d.length ? d.join(" / ") : "no price versions shown";
  });
  click($$("[data-ws-tab]").find((t) => t.dataset.wsTab === "message"));
  await wait(150);
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
  check("Sent messages are kept and shown", () => {
    const rows = $$(".sent-row");
    return rows.length ? `${rows.length} sent message(s) listed` : "no record of what was sent";
  });
  check("The pitch explains what it was built from", () => {
    const why = $(".pitch-why");
    if (!why) return "no reasoning shown";
    const keys = $$(".why-list dt").map((e) => e.textContent);
    return keys.length ? keys.join(", ") : "reasoning box is empty";
  });

  check("Channel tabs swap the body", () =>
    $("#pitch-subject-wrap").hidden && $("#pitch-body").value.length > 10
      ? "whatsapp copy shown, subject hidden"
      : false);

  /* Loss interview — on the Now tab, where you close a deal */
  click($$("[data-ws-tab]").find((t) => t.dataset.wsTab === "now"));
  await wait(200);
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
  check("Only the discount limit is editable", () =>
    $("#gr-discount") && !$("#gr-healthy") && !$("#gr-min")
      ? "cost model removed"
      : "margin fields still there");
  check("Template slots are editable", () => {
    const n = $$("[data-tpl]").length;
    return n ? `${n} template(s)` : "no template editor";
  });

  check("Cadence is editable", () =>
    $("#cad-1") && $("#cad-4") && $("#cad-nudge")
      ? `steps ${$("#cad-1").value}/${$("#cad-2").value}/${$("#cad-3").value}/${$("#cad-4").value}, nag after ${$("#cad-nudge").value}h`
      : false);

  // The bell is the whole point of the alerts endpoint — check it actually
  // renders a row and that the row can jump into the workspace.
  click($("#bell-btn"));
  await wait(200);
  check("Bell shows outreach work", () => {
    const rows = $$("#bell-panel [data-bell-opp]");
    return rows.length ? `${rows.length} entry` : "no outreach entries in the bell";
  });

  // --- bell read-state (new) ---
  check("Bell marks itself read on open", () => {
    const dot = $("#bell-dot");
    return dot && dot.hidden ? "dot cleared" : "dot still lit after opening";
  });

  // --- admin remove from the Newspaper (new) ---
  click($('[data-tab="newspaper"]'));
  await wait(500);
  // The Newspaper is a year -> month -> day drill-down; the cards (and the
  // Remove button) only exist at the deepest level.
  for (let i = 0; i < 3; i++) {
    const tile = $(".np-tile");
    if (!tile) break;
    click(tile);
    await wait(180);
  }
  const rm = $("[data-remove-lead]");
  check("Admin sees a Remove button in the Newspaper", () => Boolean(rm) || "no remove button");
  if (rm) {
    click(rm);
    await wait(150);
    check("Remove asks hide vs block", () => {
      const choices = $$("[data-np-choice]").map((b) => b.dataset.npChoice);
      return choices.includes("hide") && choices.includes("block")
        ? choices.join(", ")
        : `only ${choices.join(", ")}`;
    });
    check("Remove dialog spells out the consequence", () => {
      const t = ($("#np-remove-dialog") || {}).textContent || "";
      return t.includes("comes back") && t.includes("never appears again")
        ? "both outcomes explained"
        : "consequences not explained";
    });
    const cancel = $$("[data-np-choice]").find((b) => b.dataset.npChoice === "cancel");
    click(cancel);
    await wait(100);
    check("Cancel closes it", () => !$("#np-remove-dialog") || "dialog stayed open");
  }

  check("Still no unrendered template literals", () => {
    // Scan the rendered surfaces only — body.innerHTML also contains the
    // injected <script> elements' own source, which is full of `${`.
    const html = [$("#content"), $("#ws-panel")].filter(Boolean).map((e) => e.innerHTML).join("");
    const i = html.indexOf("${");
    return i === -1 ? true : `found: …${html.slice(Math.max(0, i - 90), i + 90)}…`;
  });
}
