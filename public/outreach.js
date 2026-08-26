/* =========================================================================
   My Outreach.

   Loaded after app.js, and deliberately not part of it. app.js is already
   3,500 lines holding four tabs; folding a fifth of comparable size into it
   would make every future change to any tab riskier. Classic scripts share one
   global scope, so this file uses app.js's $, api, esc, toast and state
   directly — there is no import, and none is needed.

   The organising idea, straight from the brief: opening this tab should not
   show you 200 leads. It should answer "what do I need to do today?".
   ========================================================================= */

const outreach = {
  view: "today",           // today | pipeline | intel | pricing
  today: null,
  pipeline: null,
  intel: null,
  rateCard: null,
  opp: null,               // the workspace payload, when open
  pitch: null,             // last generated pitch, kept out of the DB until sent
  quote: null,             // live guardrail verdict while the builder is open
  // What the salesperson has selected but not yet saved. These have to live
  // outside the DOM: every action repaints the workspace from the server's
  // copy of the opportunity, so an unsaved tier or price held only in an input
  // would be wiped by the next repaint — which is exactly what happened when
  // picking a plan reset the price field it had just filled in.
  pendingTier: null,
  pendingPrice: null,
  builderOpen: false,
  proposalDraft: null,
  synced: false,
  // Which slab is being drilled into, or null for the normal grouped view.
  // Lives in state, not the DOM, so a repaint after any action keeps the
  // filter the user chose.
  focus: null,
  recommending: false,
};

const STAGE_LABEL = {
  new: "New",
  contacted: "Contacted",
  replied: "Replied",
  meeting: "Meeting",
  proposal: "Proposal",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

const CHANNELS = [
  ["email", "Email"],
  ["linkedin", "LinkedIn"],
  ["whatsapp", "WhatsApp"],
  ["call_script", "Call script"],
  ["proposal_intro", "Proposal intro"],
];

const DISLIKES = [
  ["price", "Price"],
  ["idea", "Idea"],
  ["timeline", "Timeline"],
  ["deliverables", "Deliverables"],
  ["trust", "Trust"],
  ["relationship", "Existing relationship"],
];

const MEETING_OUTCOMES = [
  ["interested", "Interested"],
  ["need_proposal", "Need proposal"],
  ["internal_discussion", "Need internal discussion"],
  ["budget_discussion", "Budget discussion"],
  ["not_interested", "Not interested"],
  ["followup_later", "Follow up later"],
];

/** ₹ with Indian digit grouping, and nothing at all for a missing number. */
function inr(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/** ₹10L rather than ₹10,00,000 where space is tight. */
function inrShort(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "—";
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(n % 1e7 ? 2 : 0)}Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(n % 1e5 ? 1 : 0)}L`;
  if (n >= 1e3) return `₹${(n / 1e3).toFixed(0)}K`;
  return `₹${n}`;
}

function shortDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-IN", {
    day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
  });
}

function dateOnly(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/* ── entry point ──────────────────────────────────────────────────────────── */

async function renderOutreach() {
  const content = $("#content");

  // One backfill per session — see the /sync comment on the server. Failing is
  // survivable: the tab still renders, it just shows fewer opportunities.
  if (!outreach.synced) {
    outreach.synced = true;
    try { await api("/api/outreach/sync", { method: "POST" }); } catch { /* non-fatal */ }
  }

  content.innerHTML = `
    ${outreachNav()}
    <div id="outreach-body"><p class="muted" style="padding:24px">Loading…</p></div>`;

  wireOutreachNav();

  if (outreach.view === "today") return renderToday();
  if (outreach.view === "pipeline") return renderPipeline();
  if (outreach.view === "intel") return renderIntel();
  if (outreach.view === "pricing") return renderPricing();
}

function outreachNav() {
  const views = [
    ["today", "Today"],
    ["pipeline", "All my leads"],
    ["intel", "What's working"],
  ];
  if (state.user.role === "admin") views.push(["pricing", "Pricing"]);

  return `
    <div class="mine-subtabs">
      ${views
        .map(
          ([key, label]) =>
            `<button class="chip ${outreach.view === key ? "is-on" : ""}" data-oview="${key}">${label}</button>`
        )
        .join("")}
    </div>`;
}

function wireOutreachNav() {
  for (const btn of $$("[data-oview]")) {
    btn.addEventListener("click", () => {
      outreach.view = btn.dataset.oview;
      renderOutreach();
    });
  }
}

/* ── item 2: the TODAY screen ─────────────────────────────────────────────── */

/**
 * Six counts and then the work itself, grouped by what the work IS. The brief
 * asked for exactly this and it is right: a salesperson opening the portal at
 * 10am needs to be told what to do, not handed a table to sort.
 */
async function renderToday() {
  const body = $("#outreach-body");

  let data;
  try {
    data = await api("/api/outreach/today");
  } catch (err) {
    body.innerHTML = `<div class="empty"><h2>Couldn't load today</h2><p>${esc(err.message)}</p></div>`;
    return;
  }
  outreach.today = data;

  const c = data.counts;
  // Every caption says what to DO, in words a salesperson uses out loud.
  // "the drip is waiting on you" was the sort of thing that reads fine to
  // whoever wrote it and means nothing to the person using it at 10am.
  // First item is the bucket key: clicking a slab shows exactly that group.
  const slabs = [
    ["urgent", "Do these first", c.urgent, "time is running out on these", c.urgent ? "is-late" : ""],
    ["followup", "Time to follow up", c.followup, "you said you'd check back", c.followup ? "is-urgent" : ""],
    ["new", "Not started", c.new, "you haven't contacted them yet", ""],
    ["replied", "They replied", c.replied, "waiting for your answer", c.replied ? "is-urgent" : ""],
    ["meeting", "Meetings today", c.meeting, "happening today", ""],
    ["proposal", "Waiting on price approval", c.proposal, "sent, or with your manager", ""],
    ["working", "In progress", c.working || 0, "live conversations, nothing due", ""],
  ];

  const groups = [
    ["urgent", "🔥 Do these first", data.buckets.urgent],
    ["replied", "🟢 They replied — answer them", data.buckets.replied],
    ["meeting", "📅 Meetings today", data.buckets.meeting],
    ["followup", "🟠 Time to follow up", data.buckets.followup],
    ["proposal", "📄 Quote sent — waiting", data.buckets.proposal],
    ["new", "⚪ Not contacted yet", data.buckets.new],
    ["working", "🔵 In progress", data.buckets.working],
  ]
    .filter(([, , list]) => list && list.length)
    // Drilling into a slab hides the other groups rather than scrolling to
    // one, so the screen shows only the job they picked.
    .filter(([key]) => !outreach.focus || key === outreach.focus);

  const focusedLabel = outreach.focus
    ? (slabs.find(([k]) => k === outreach.focus) || [null, outreach.focus])[1]
    : null;

  body.innerHTML = `
    <div class="stats today-slabs">
      ${slabs
        .map(
          ([key, label, value, note, tone]) => `
        <button class="stat stat-click ${value ? tone : ""} ${
            outreach.focus === key ? "is-focused" : ""
          }" data-slab="${key}" ${value ? "" : "disabled"}>
          <p class="stat-label">${esc(label)}</p>
          <p class="stat-value">${value}</p>
          <p class="stat-note">${esc(note)}</p>
        </button>`
        )
        .join("")}
    </div>

    ${
      outreach.focus
        ? `<div class="focus-bar">
             <span>Showing only <strong>${esc(focusedLabel)}</strong></span>
             <button class="btn btn-sm" id="clear-focus">Show everything</button>
           </div>`
        : ""
    }

    ${
      groups.length
        ? groups
            .map(
              ([key, title, list]) => `
        <section class="today-group" data-group="${key}">
          <h3 class="today-group-head">${title} <span class="pill">${list.length}</span></h3>
          <div class="today-cards">${list.map((o) => todayCard(o, key)).join("")}</div>
        </section>`
            )
            .join("")
        : outreach.focus
        ? `<div class="empty">
             <h2>Nothing here right now</h2>
             <p>No leads under "${esc(focusedLabel)}" at the moment.</p>
             <button class="btn btn-sm" id="clear-focus-empty">Show everything</button>
           </div>`
        : `<div class="empty">
             <h2>You're all caught up</h2>
             <p>Nothing needs you right now. Pick up a lead from All Leads or Fresh Leads and it will show up here.</p>
           </div>`
    }`;

  wireToday();
}

/**
 * One card per opportunity, and every card ends in a single button.
 *
 * The next action is a sentence, not a status: "Send first pitch", not "New".
 * Where the classifier has written one it wins, because it read the actual
 * reply and this function only knows which bucket the card is in.
 */
function todayCard(o, bucket) {
  const action =
    o.next_action ||
    {
      urgent:
        o.stage === "new"
          ? "Send your first message — you're about to lose this lead"
          : "Move this forward today, or you lose the lead",
      replied: "Read what they wrote and reply",
      meeting: "Meeting today — after it, write down what was said",
      followup: o.due_followup
        ? `Time to check back (message ${o.due_followup.step} of 4)`
        : "Time to check back with them",
      proposal:
        o.approval_status === "pending"
          ? "Your manager is checking the price"
          : "Chase the quote you sent",
      new: "Send your first message",
      working: o.next_meeting_at
        ? `Meeting booked for ${dateOnly(o.next_meeting_at)} — nothing due until then`
        : "Keep this moving — set up a meeting or send a proposal",
    }[bucket];

  const clock = o.countdown
    ? `<span class="clock ${o.countdown.overdue ? "clock-over" : o.countdown.urgent ? "clock-soon" : ""}">${esc(
        o.countdown.overdue ? "Time's up" : `${o.countdown.label} to close this`
      )}</span>`
    : "";

  return `
    <article class="opp-card" data-opp="${o.id}">
      <div class="opp-card-top">
        <div>
          <div class="company-name">${esc(o.company)}</div>
          <div class="opp-card-meta">
            ${o.contact_name ? esc(o.contact_name) : "No specific person yet"}${
    o.contact_role ? ` · ${esc(o.contact_role)}` : ""
  }
          </div>
        </div>
        ${clock}
      </div>

      <div class="opp-card-tags">
        <span class="stage-chip stage-${esc(o.stage)}">${esc(STAGE_LABEL[o.stage] || o.stage)}</span>
        ${o.service_primary ? `<span class="tag-soft">${esc(o.service_primary)}</span>` : ""}
        ${o.quoted_price ? `<span class="tag-soft">${inrShort(o.quoted_price)}</span>` : ""}
        ${
          o.approval_status === "pending"
            ? `<span class="tag-warn">Price needs approval</span>`
            : ""
        }
      </div>

      <p class="opp-next"><span class="mono-label">What to do next</span>${esc(action)}</p>

      <button class="btn btn-sm btn-primary" data-open-opp="${o.id}">Open</button>
    </article>`;
}

function wireToday() {
  for (const btn of $$("[data-open-opp]")) {
    btn.addEventListener("click", () => openWorkspace(btn.dataset.openOpp));
  }

  for (const slab of $$("[data-slab]")) {
    slab.addEventListener("click", () => {
      // Clicking the slab you're already in goes back to everything, so the
      // same button both drills in and backs out.
      outreach.focus = outreach.focus === slab.dataset.slab ? null : slab.dataset.slab;
      renderToday();
    });
  }

  for (const id of ["clear-focus", "clear-focus-empty"]) {
    const btn = $(`#${id}`);
    if (btn)
      btn.addEventListener("click", () => {
        outreach.focus = null;
        renderToday();
      });
  }
}

/* ── pipeline: the flat list, for when you do want the table ──────────────── */

async function renderPipeline() {
  const body = $("#outreach-body");
  let data;
  try {
    data = await api("/api/outreach");
  } catch (err) {
    body.innerHTML = `<div class="empty"><h2>Couldn't load your leads</h2><p>${esc(err.message)}</p></div>`;
    return;
  }

  const rows = data.opportunities;
  if (!rows.length) {
    body.innerHTML = `<div class="empty"><h2>Nothing here yet</h2><p>Pick up a lead from All Leads or Fresh Leads and it will show up here.</p></div>`;
    return;
  }

  body.innerHTML = `
    <div class="db-table">
      <div class="pipe-head">
        <span>Company</span><span>Person</span><span>Where it stands</span>
        <span>What we're selling</span><span>Deal size</span><span>Profit</span><span>Time left</span><span></span>
      </div>
      ${rows
        .map(
          (o) => `
        <div class="pipe-row">
          <span class="company-name">${esc(o.company)}</span>
          <span>${esc(o.contact_name || "—")}</span>
          <span><span class="stage-chip stage-${esc(o.stage)}">${esc(STAGE_LABEL[o.stage] || o.stage)}</span></span>
          <span>${esc(o.service_primary || "—")}</span>
          <span class="num">${inrShort(o.quoted_price)}</span>
          <span class="num ${marginTone(o.margin_pct)}">${
            o.margin_pct == null ? "—" : `${Number(o.margin_pct).toFixed(0)}%`
          }</span>
          <span>${o.countdown ? esc(o.countdown.label) : "—"}</span>
          <span><button class="btn btn-sm" data-open-opp="${o.id}">Open</button></span>
        </div>`
        )
        .join("")}
    </div>`;

  wireToday();
}

function marginTone(pct) {
  if (pct == null) return "";
  const n = Number(pct);
  if (n >= 35) return "num-good";
  if (n >= 25) return "num-warn";
  return "num-bad";
}

/* ── items 13 & 15: the intelligence view ─────────────────────────────────── */

/**
 * Two questions, answered separately because they have different fixes.
 *
 * "Where do we lose them" is a process problem — a bad proposal step is a
 * different job from a bad meeting step. "Why do we lose them" is a market or
 * pricing problem. Putting both on one screen is what lets a manager tell
 * which one they actually have.
 */
async function renderIntel() {
  const body = $("#outreach-body");
  let data;
  try {
    data = await api(`/api/outreach/meta/intelligence${state.user.role === "admin" ? "?scope=team" : ""}`);
  } catch (err) {
    body.innerHTML = `<div class="empty"><h2>Couldn't load this</h2><p>${esc(err.message)}</p></div>`;
    return;
  }
  outreach.intel = data;

  const t = data.totals;

  const focusedLabel = outreach.focus
    ? (slabs.find(([k]) => k === outreach.focus) || [null, outreach.focus])[1]
    : null;

  body.innerHTML = `
    <div class="stats today-slabs">
      <div class="stat"><p class="stat-label">Total leads</p><p class="stat-value">${t.total}</p><p class="stat-note">${
    data.scope === "team" ? "whole team" : "yours"
  }</p></div>
      <div class="stat"><p class="stat-label">Won</p><p class="stat-value">${t.won}</p><p class="stat-note">${inrShort(
    t.won_value
  )} earned</p></div>
      <div class="stat"><p class="stat-label">Lost</p><p class="stat-value">${t.lost}</p><p class="stat-note">and we know why</p></div>
      <div class="stat"><p class="stat-label">Deals we win</p><p class="stat-value">${
        t.won + t.lost ? Math.round((t.won / (t.won + t.lost)) * 100) : 0
      }%</p><p class="stat-note">out of every 100 closed</p></div>
    </div>

    <section class="intel-block">
      <h3>Where deals fall apart</h3>
      <p class="hint">Out of every 100 leads that reach one step, how many make it to the next. A low number tells you which step to fix — getting meetings and closing deals are two different problems.</p>
      ${
        data.funnel.some((f) => f.reached)
          ? `<div class="funnel">
              ${data.funnel
                .map(
                  (f) => `
                <div class="funnel-row">
                  <span class="funnel-label">${esc(STAGE_LABEL[f.from])} → ${esc(STAGE_LABEL[f.to])}</span>
                  <span class="funnel-bar"><i style="width:${f.rate == null ? 0 : Math.min(100, f.rate)}%"></i></span>
                  <span class="funnel-pct">${f.rate == null ? "—" : `${f.rate}%`}</span>
                  <span class="funnel-n">${f.converted}/${f.reached}</span>
                </div>`
                )
                .join("")}
             </div>`
          : `<p class="muted">No deals have moved forward yet, so there's nothing to measure.</p>`
      }
    </section>

    <section class="intel-block">
      <h3>Why we lose deals</h3>
      <p class="hint">Taken from the questions you answer when a deal is lost. ${
        data.loss_total
          ? `Based on ${data.loss_total} lost deal${data.loss_total === 1 ? "" : "s"}.`
          : "Nothing filed yet."
      }</p>
      ${
        data.objections.length
          ? `<div class="funnel">
              ${data.objections
                .map(
                  (o) => `
                <div class="funnel-row">
                  <span class="funnel-label">${esc(o.label)}</span>
                  <span class="funnel-bar"><i class="bar-warm" style="width:${o.pct}%"></i></span>
                  <span class="funnel-pct">${o.pct}%</span>
                  <span class="funnel-n">${o.n}</span>
                </div>`
                )
                .join("")}
             </div>`
          : `<p class="muted">No lost deals recorded yet. This fills in as deals close.</p>`
      }
    </section>

    ${
      data.died_at && data.died_at.length
        ? `<section class="intel-block">
             <h3>The step where we lost them</h3>
             <div class="chips">${data.died_at
               .map((d) => `<span class="chip is-static">${esc(STAGE_LABEL[d.stage] || d.stage)} · ${d.n}</span>`)
               .join("")}</div>
           </section>`
        : ""
    }

    ${
      data.reapproach && data.reapproach.length
        ? `<section class="intel-block">
             <h3>Worth trying again</h3>
             <p class="hint">Deals you lost but said were worth another try, now due. This is the payoff for filling in those questions.</p>
             <div class="today-cards">
               ${data.reapproach
                 .map(
                   (r) => `
                 <article class="opp-card">
                   <div class="company-name">${esc(r.company)}</div>
                   <div class="opp-card-meta">Lost because of ${esc(r.primary_reason.replace(/_/g, " "))} · try again ${esc(
                     dateOnly(r.reapproach_at)
                   )}</div>
                   <button class="btn btn-sm" data-open-opp="${r.id}">Open</button>
                 </article>`
                 )
                 .join("")}
             </div>
           </section>`
        : ""
    }`;

  wireToday();
}

/* ── admin: the rate card (items 5-7 need real numbers eventually) ────────── */

async function renderPricing() {
  const body = $("#outreach-body");
  let data;
  try {
    data = await api("/api/outreach/meta/rate-card");
  } catch (err) {
    body.innerHTML = `<div class="empty"><h2>Couldn't load pricing</h2><p>${esc(err.message)}</p></div>`;
    return;
  }
  outreach.rateCard = data;

  const rows = data.rate_card.flatMap((g) => g.plans);
  const g = data.guardrail;
  const m = data.cost_model;
  const cad = data.cadence || {};

  body.innerHTML = `
    <section class="intel-block">
      <h3>Standard packages and prices</h3>
      <p class="hint">These are made-up numbers so the screens work. Type your real prices over them — every price in the portal comes from this table.</p>
      <div class="rate-table">
        <div class="rate-head">
          <span>Service</span><span>Tier</span><span>Label</span><span>Price ₹</span>
          <span>Creators</span><span>Views</span><span>Deliverables</span>
        </div>
        ${rows
          .map(
            (r, i) => `
          <div class="rate-row" data-rate="${i}">
            <span>${esc(r.service)}</span>
            <span>${esc(r.tier)}</span>
            <input value="${esc(r.label)}" data-f="label" />
            <input type="number" value="${Number(r.price)}" data-f="price" />
            <input type="number" value="${Number(r.creators || 0)}" data-f="creators" />
            <input value="${esc(r.views || "")}" data-f="views" />
            <input value="${esc(r.deliverables || "")}" data-f="deliverables" />
          </div>`
          )
          .join("")}
      </div>
    </section>

    <section class="intel-block">
      <h3>What things cost us</h3>
      <p class="hint">What we pay one creator. The custom package builder starts from these and adjusts for region, language and what they produce.</p>
      <div class="grid-3">
        ${["nano", "micro", "macro"]
          .map(
            (k) => `
          <label class="field">
            <span>${k} creator ₹</span>
            <input type="number" id="cm-${k}" value="${Number((m.creator_rates || {})[k] || 0)}" />
          </label>`
          )
          .join("")}
        <label class="field">
          <span>Our overhead %</span>
          <input type="number" id="cm-internal" value="${Number(m.internal_cost_pct || 0)}" />
        </label>
      </div>
    </section>

    <section class="intel-block">
      <h3>Profit rules</h3>
      <p class="hint">If a price makes too little profit, or the discount is too big, it goes to a manager before the deal can be marked won.</p>
      <div class="grid-3">
        <label class="field"><span>Good profit %</span><input type="number" id="gr-healthy" value="${Number(
          g.healthy_margin_pct
        )}" /></label>
        <label class="field"><span>Lowest profit we allow %</span><input type="number" id="gr-min" value="${Number(
          g.min_margin_pct
        )}" /></label>
        <label class="field"><span>Biggest discount allowed %</span><input type="number" id="gr-discount" value="${Number(
          g.max_discount_pct
        )}" /></label>
      </div>
    </section>

    <section class="intel-block">
      <h3>Reminder timing</h3>
      <p class="hint">How many days after your first message each reminder appears. The last box is different: if you pick up a lead and send nothing at all, that is how long before we start reminding you.</p>
      <div class="grid-3">
        ${[1, 2, 3, 4]
          .map(
            (n) => `
          <label class="field">
            <span>Reminder ${n} — day</span>
            <input type="number" min="1" id="cad-${n}" value="${Number(cad[`step${n}_days`] || 0)}" />
          </label>`
          )
          .join("")}
        <label class="field">
          <span>Remind me if nothing sent after (hours)</span>
          <input type="number" min="1" id="cad-nudge" value="${Number(cad.nudge_after_hours || 24)}" />
        </label>
      </div>
      <button class="btn btn-primary" id="save-pricing">Save pricing</button>
    </section>`;

  $("#save-pricing").addEventListener("click", async () => {
    const payload = {
      rows: rows.map((r, i) => {
        const el = $(`[data-rate="${i}"]`);
        const f = (name) => el.querySelector(`[data-f="${name}"]`).value;
        return {
          service: r.service, tier: r.tier, sort: r.sort,
          label: f("label"), price: f("price"), creators: f("creators"),
          views: f("views"), deliverables: f("deliverables"),
        };
      }),
      cost_model: {
        ...m,
        creator_rates: {
          nano: Number($("#cm-nano").value),
          micro: Number($("#cm-micro").value),
          macro: Number($("#cm-macro").value),
        },
        internal_cost_pct: Number($("#cm-internal").value),
      },
      guardrail: {
        healthy_margin_pct: Number($("#gr-healthy").value),
        min_margin_pct: Number($("#gr-min").value),
        max_discount_pct: Number($("#gr-discount").value),
      },
      followup_cadence: {
        step1_days: Number($("#cad-1").value),
        step2_days: Number($("#cad-2").value),
        step3_days: Number($("#cad-3").value),
        step4_days: Number($("#cad-4").value),
        nudge_after_hours: Number($("#cad-nudge").value),
      },
    };

    try {
      await api("/api/outreach/meta/rate-card", { method: "PUT", body: payload });
      toast("Pricing saved");
      renderPricing();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ── item 3: the Opportunity Workspace ────────────────────────────────────── */

function workspaceEls() {
  let backdrop = $("#ws-backdrop");
  let panel = $("#ws-panel");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.id = "ws-backdrop";
    backdrop.className = "drawer-backdrop";
    backdrop.hidden = true;
    backdrop.addEventListener("click", closeWorkspace);
    document.body.appendChild(backdrop);

    panel = document.createElement("aside");
    panel.id = "ws-panel";
    panel.className = "ws-panel";
    panel.hidden = true;
    document.body.appendChild(panel);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("#ws-panel").hidden) closeWorkspace();
    });
  }
  return { backdrop, panel };
}

function closeWorkspace() {
  const { backdrop, panel } = workspaceEls();
  backdrop.hidden = true;
  panel.hidden = true;
  outreach.opp = null;
  outreach.pitch = null;
  outreach.quote = null;
  outreach.proposalDraft = null;
  outreach.pendingTier = null;
  outreach.pendingPrice = null;
  outreach.builderOpen = false;
}

async function openWorkspace(id) {
  const { backdrop, panel } = workspaceEls();
  backdrop.hidden = false;
  panel.hidden = false;
  panel.innerHTML = `<p class="muted" style="padding:32px">Opening…</p>`;

  outreach.pendingTier = null;
  outreach.pendingPrice = null;
  outreach.builderOpen = false;

  try {
    outreach.opp = await api(`/api/outreach/${id}`);
    if (!outreach.rateCard) outreach.rateCard = await api("/api/outreach/meta/rate-card");
  } catch (err) {
    panel.innerHTML = `<div class="empty"><h2>Couldn't open it</h2><p>${esc(err.message)}</p></div>`;
    return;
  }

  paintWorkspace();

  // Suggest what to sell without being asked. The brief's point was "don't
  // make the salesperson decide everything" — a button they have to find and
  // press is still making them decide. Fires only when nothing has been
  // picked yet, so it never overwrites a choice someone already made.
  if (!outreach.opp.opportunity.service_primary) {
    outreach.recommending = true;
    paintWorkspace();
    try {
      await api(`/api/outreach/${id}/recommend-service`, { method: "POST" });
      await reloadWorkspace();
    } catch {
      // A failed suggestion is not a failed workspace — fall back to the
      // manual picker rather than blocking the whole panel.
      paintWorkspace();
    } finally {
      outreach.recommending = false;
    }
  }
}

/** Re-fetch and repaint without closing — used after every write. */
async function reloadWorkspace() {
  if (!outreach.opp) return;
  const id = outreach.opp.opportunity.id;
  outreach.opp = await api(`/api/outreach/${id}`);
  paintWorkspace();
}

function paintWorkspace() {
  const { panel } = workspaceEls();
  const d = outreach.opp;
  const o = d.opportunity;

  panel.innerHTML = `
    <header class="ws-head">
      <div>
        <p class="eyebrow"><span class="dot"></span>${esc(STAGE_LABEL[o.stage] || o.stage)}</p>
        <h2>${esc(o.company)} — ${esc(o.service_primary || "Opportunity")}</h2>
      </div>
      <button class="drawer-close" id="ws-close" aria-label="Close">×</button>
    </header>

    <div class="ws-body">
      ${wsContactBlock(d)}
      ${wsServiceBlock(d)}
      ${wsPlanBlock(d)}
      ${wsPitchBlock(d)}
      ${wsReplyBlock(d)}
      ${wsFollowupBlock(d)}
      ${wsMeetingBlock(d)}
      ${wsProposalBlock(d)}
      ${wsTimelineBlock(d)}
      ${wsCloseBlock(d)}
    </div>`;

  $("#ws-close").addEventListener("click", closeWorkspace);
  wireWorkspace();
}

/* --- contact header (item 3) --- */

function wsContactBlock(d) {
  const o = d.opportunity;
  const primary = d.contacts.find((c) => c.id === o.contact_id) || d.contacts[0];

  const clock = o.countdown
    ? `<span class="clock ${o.countdown.overdue ? "clock-over" : o.countdown.urgent ? "clock-soon" : ""}">${esc(
        o.countdown.overdue ? "Claim expired" : o.countdown.label
      )}</span>`
    : "";

  return `
    <section class="ws-section ws-contact">
      <div class="ws-contact-main">
        <div>
          <span class="mono-label">Company</span>
          <p class="ws-strong">${esc(o.company)}</p>
          <p class="muted">${[o.industry, o.employees].filter(Boolean).map(esc).join(" · ") || "—"}</p>
        </div>
        <div>
          <span class="mono-label">Contact</span>
          <p class="ws-strong">${esc(primary ? primary.name : "No contact selected")}</p>
          <p class="muted">${esc((primary && primary.role) || "—")}</p>
        </div>
        <div class="ws-channels">
          ${primary && primary.phone ? `<a class="ws-chan" href="tel:${esc(primary.phone)}">📞 ${esc(primary.phone)}</a>` : ""}
          ${primary && primary.email ? `<a class="ws-chan" href="mailto:${esc(primary.email)}">✉️ ${esc(primary.email)}</a>` : ""}
          ${primary && primary.linkedin ? `<a class="ws-chan" href="${esc(primary.linkedin)}" target="_blank" rel="noopener">🔗 LinkedIn</a>` : ""}
          ${!primary || (!primary.phone && !primary.email) ? `<span class="muted">No phone or email on file.</span>` : ""}
        </div>
      </div>
      <div class="ws-contact-side">${clock}</div>
    </section>`;
}

/* --- item 4: AI recommended service --- */

function wsServiceBlock(d) {
  const o = d.opportunity;
  const services = (outreach.rateCard && outreach.rateCard.services) || [];

  return `
    <section class="ws-section">
      <h3>What we should sell them</h3>
      ${
        o.service_primary
          ? `<div class="rec-box ${o.service_accepted ? "is-accepted" : ""}">
               <div class="rec-line"><span class="mono-label">Main</span><strong>${esc(o.service_primary)}</strong></div>
               ${o.service_secondary ? `<div class="rec-line"><span class="mono-label">Add on</span>${esc(o.service_secondary)}</div>` : ""}
               ${o.service_optional ? `<div class="rec-line"><span class="mono-label">If they want</span>${esc(o.service_optional)}</div>` : ""}
               ${
                 o.service_rationale
                   ? `<p class="rec-why"><span class="mono-label">Why</span>${esc(o.service_rationale)}
                        ${o.service_source === "rules" ? `<span class="tag-soft">standard suggestion</span>` : ""}</p>`
                   : ""
               }
               ${
                 o.service_accepted
                   ? `<p class="muted">Decided.</p>`
                   : `<div class="ws-actions">
                        <button class="btn btn-sm btn-primary" id="accept-service">Yes, sell this</button>
                        <button class="btn btn-sm" id="change-service">Pick something else</button>
                      </div>`
               }
             </div>`
          : outreach.recommending
          ? `<div class="rec-box is-thinking">
               <p class="muted">Working out what to sell them…</p>
             </div>`
          : `<p class="muted">Not decided yet.</p>
             <button class="btn btn-sm btn-primary" id="recommend-service">Suggest what to sell</button>`
      }

      <div id="service-picker" hidden>
        <label class="field">
          <span>What are we selling?</span>
          <select id="svc-primary">${services
            .map((s) => `<option ${s === o.service_primary ? "selected" : ""}>${esc(s)}</option>`)
            .join("")}</select>
        </label>
        <button class="btn btn-sm btn-primary" id="save-service">Save</button>
      </div>
    </section>`;
}

/* --- items 5-7: plan selection, custom builder, guardrail --- */

function wsPlanBlock(d) {
  const o = d.opportunity;
  const card = (outreach.rateCard && outreach.rateCard.rate_card) || [];
  const group = card.find((g) => g.service === o.service_primary);
  const cfg = o.plan_config || {};
  const q = outreach.quote;
  const tier = outreach.pendingTier || o.plan_tier;
  const price = outreach.pendingPrice != null ? outreach.pendingPrice : Number(o.quoted_price || 0);

  if (!o.service_primary) {
    return `<section class="ws-section"><h3>Package &amp; price</h3><p class="muted">First decide what you're selling them, above.</p></section>`;
  }

  return `
    <section class="ws-section">
      <h3>Package &amp; price</h3>

      ${
        group
          ? `<div class="plan-grid">
               ${group.plans
                 .map(
                   (p) => `
                 <button class="plan-card ${tier === p.tier ? "is-on" : ""}" data-plan="${esc(p.tier)}">
                   <span class="plan-price">${inrShort(p.price)}</span>
                   <span class="plan-label">${esc(p.label)}</span>
                   <span class="plan-detail">${p.creators ? `${p.creators} creators` : "—"}</span>
                   <span class="plan-detail">${esc(p.views || "")}</span>
                   <span class="plan-detail">${esc(p.deliverables || "")}</span>
                 </button>`
                 )
                 .join("")}
             </div>`
          : `<p class="muted">No standard packages for ${esc(o.service_primary)} yet. Build one below.</p>`
      }

      <button class="btn btn-sm" id="toggle-builder">Build a custom package</button>

      <div id="plan-builder" ${outreach.builderOpen || tier === "custom" ? "" : "hidden"}>
        <div class="grid-3">
          <label class="field"><span>Geography</span>
            <select id="pb-geo">${["India", "North", "South", "Regional"]
              .map((g) => `<option ${cfg.geography === g ? "selected" : ""}>${g}</option>`)
              .join("")}</select></label>
          <label class="field"><span>Language</span>
            <select id="pb-lang">${["Hindi", "English", "Tamil", "Telugu", "Marathi", "Bengali", "Kannada"]
              .map((g) => `<option ${cfg.language === g ? "selected" : ""}>${g}</option>`)
              .join("")}</select></label>
          <label class="field"><span>Views promised (in millions)</span>
            <input type="number" id="pb-views" value="${Number(cfg.views_m || 0)}" /></label>
        </div>

        <span class="mono-label">How many creators</span>
        <div class="grid-3">
          ${["nano", "micro", "macro"]
            .map(
              (t) => `
            <label class="field"><span>${t}</span>
              <input type="number" min="0" id="pb-${t}" value="${Number((cfg.creator_mix || {})[t] || 0)}" /></label>`
            )
            .join("")}
        </div>

        <span class="mono-label">What they get</span>
        <div class="chips" id="pb-deliverables">
          ${["Reels", "YouTube", "Stories", "Static post"]
            .map(
              (dv) =>
                `<button class="chip ${
                  (cfg.deliverables || []).includes(dv) ? "is-on" : ""
                }" data-deliv="${esc(dv)}">${dv}</button>`
            )
            .join("")}
        </div>
      </div>

      <div class="grid-3">
        <label class="field"><span>What the client can spend ₹</span>
          <input type="number" id="pb-budget" value="${Number(o.client_budget || 0)}" /></label>
        <label class="field"><span>What we'll charge ₹</span>
          <input type="number" id="pb-price" value="${price}" /></label>
        <div class="field"><span class="mono-label">&nbsp;</span>
          <button class="btn btn-sm" id="run-quote">Check the profit</button></div>
      </div>

      ${guardrailBox(q, o)}

      <button class="btn btn-primary" id="save-plan">Save</button>
    </section>`;
}

/**
 * Item 7's traffic light.
 *
 * Shows the working, not just the verdict — vendor cost, internal cost, margin
 * — because a salesperson who can see WHY the number is red can fix it by
 * changing the plan, and one who only sees "blocked" goes and asks their
 * manager to override it.
 */
function guardrailBox(q, o) {
  const source = q || (o.margin_pct != null
    ? {
        revenue: o.quoted_price, vendor_cost: o.vendor_cost, internal_cost: o.internal_cost,
        margin_amount: o.margin_amount, margin_pct: o.margin_pct,
        status: o.approval_status === "pending" ? "blocked" : o.margin_pct >= 35 ? "healthy" : "thin",
        label: o.approval_status === "pending"
          ? "Needs your manager's approval"
          : o.margin_pct >= 35
          ? "Good deal — go ahead"
          : "Tight, but you can sell it",
        reasons: o.approval_reason ? [o.approval_reason] : [],
      }
    : null);

  if (!source) {
    return `<p class="muted">Put in a price and press "Check the profit" to see if this deal is worth doing.</p>`;
  }

  const tone =
    source.status === "healthy" ? "gr-good" : source.status === "thin" ? "gr-warn" : "gr-bad";

  return `
    <div class="guardrail ${tone}">
      <div class="gr-verdict">
        <span class="gr-dot"></span>
        <strong>${esc(source.label)}</strong>
        <span class="gr-margin">${source.margin_pct == null ? "—" : `we keep ${Number(source.margin_pct).toFixed(1)}%`}</span>
      </div>
      <div class="gr-lines">
        <span><span class="mono-label">They pay us</span>${inr(source.revenue)}</span>
        <span><span class="mono-label">Creators cost</span>${inr(source.vendor_cost)}</span>
        <span><span class="mono-label">Our costs</span>${inr(source.internal_cost)}</span>
        <span><span class="mono-label">We keep</span>${inr(source.margin_amount)}</span>
      </div>
      ${
        source.reasons && source.reasons.length
          ? `<ul class="gr-reasons">${source.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
          : ""
      }
      ${
        o.approval_status
          ? `<p class="gr-approval">Manager: <strong>${esc(
              { pending: "still checking", approved: "said yes", rejected: "said no" }[
                o.approval_status
              ] || o.approval_status
            )}</strong>${o.approval_note ? ` — ${esc(o.approval_note)}` : ""}</p>`
          : ""
      }
    </div>`;
}

/* --- items 8-9: pitch generator + composer --- */

function wsPitchBlock(d) {
  const p = outreach.pitch;

  return `
    <section class="ws-section">
      <h3>Message to send</h3>
      <p class="hint">We write this using their company, their recent news, the job title of your contact, and what you are selling — so it does not read like a template.</p>
      <button class="btn btn-sm btn-primary" id="gen-pitch">Write my message</button>

      ${
        p
          ? `<div class="pitch-box">
               ${p.source === "rules" ? `<p class="tag-warn">Our AI writer is switched off, so this is a standard template. Please edit it before you send.</p>` : ""}
               <div class="chips" id="pitch-tabs">
                 ${CHANNELS.map(
                   ([k, label], i) =>
                     `<button class="chip ${i === 0 ? "is-on" : ""}" data-pitch-tab="${k}">${label}</button>`
                 ).join("")}
               </div>

               <label class="field" id="pitch-subject-wrap">
                 <span>Subject</span>
                 <input id="pitch-subject" value="${esc(p.email.subject)}" />
               </label>
               <label class="field">
                 <span>Message</span>
                 <textarea id="pitch-body" rows="10">${esc(p.email.body)}</textarea>
               </label>

               <div class="ws-actions">
                 <button class="btn btn-sm" id="copy-pitch">Copy</button>
                 <button class="btn btn-sm btn-primary" id="log-sent">Mark as sent</button>
               </div>
               <p class="hint">Copy this, paste it into your email or WhatsApp, send it, then click Mark as sent. That schedules your reminders and adds it to the history below.</p>
             </div>`
          : ""
      }
    </section>`;
}

/* --- items 11 & 17: log a reply, get it classified --- */

function wsReplyBlock(d) {
  const inbound = d.messages.filter((m) => m.direction === "in").slice(0, 3);

  return `
    <section class="ws-section">
      <h3>Replies</h3>

      ${inbound
        .map(
          (m) => `
        <div class="reply-box reply-${esc(m.sentiment || "neutral")}">
          <div class="reply-head">
            <span class="reply-verdict">${esc((m.intent || "reply").replace(/_/g, " "))}</span>
            <span class="muted">${esc(shortDateTime(m.created_at))}</span>
          </div>
          <p class="reply-body">${esc(m.body)}</p>
          ${
            m.ai_next_action
              ? `<p class="reply-action"><span class="mono-label">Recommended</span>${esc(m.ai_next_action)}</p>`
              : ""
          }
        </div>`
        )
        .join("")}

      <label class="field">
        <span>Paste what they wrote back</span>
        <textarea id="reply-body" rows="3" placeholder="e.g. Sounds interesting, send me your deck"></textarea>
      </label>
      <button class="btn btn-sm btn-primary" id="log-reply">Save their reply</button>
      <p class="hint">Saving a reply switches off your pending reminders, so you never send "just following up" after they have already written back.</p>
    </section>`;
}

/* --- items 18-19: the sequence --- */

function wsFollowupBlock(d) {
  const f = d.followups;
  if (!f.length) {
    return `<section class="ws-section"><h3>Reminder schedule</h3><p class="muted">Your reminders get scheduled as soon as you send the first message.</p></section>`;
  }

  const KIND = {
    reminder: "A gentle nudge",
    value: "Share something useful",
    angle: "Try a different angle",
    nurture: "Stop chasing, stay in touch",
  };

  return `
    <section class="ws-section">
      <h3>Reminder schedule</h3>
      <div class="fu-list">
        ${f
          .map(
            (s) => `
          <div class="fu-row fu-${esc(s.status)}">
            <span class="fu-step">${s.step}</span>
            <span class="fu-kind">${esc(KIND[s.kind] || s.kind)}</span>
            <span class="fu-due">${esc(dateOnly(s.due_at))}</span>
            <span class="fu-status">${esc(s.status)}</span>
            <span>
              ${
                s.status === "due"
                  ? `<button class="btn btn-sm" data-fu-draft="${s.step}">Draft</button>
                     <button class="btn btn-sm btn-ghost" data-fu-done="${s.step}">Done</button>`
                  : ""
              }
            </span>
          </div>
          ${s.suggestion ? `<pre class="fu-suggestion">${esc(s.suggestion)}</pre>` : ""}`
          )
          .join("")}
      </div>
    </section>`;
}

/* --- items 20-21: meetings --- */

function wsMeetingBlock(d) {
  return `
    <section class="ws-section">
      <h3>Meetings</h3>

      ${d.meetings
        .map(
          (m) => `
        <div class="meet-box">
          <div class="meet-head">
            <strong>${esc(shortDateTime(m.scheduled_at))}</strong>
            ${m.link ? `<a href="${esc(m.link)}" target="_blank" rel="noopener">Join</a>` : ""}
            ${m.outcome ? `<span class="tag-soft">${esc(m.outcome.replace(/_/g, " "))}</span>` : ""}
          </div>
          ${m.requirement ? `<p><span class="mono-label">Requirement</span>${esc(m.requirement)}</p>` : ""}
          ${
            m.structured && m.structured.next_step
              ? `<p><span class="mono-label">Next step</span>${esc(m.structured.next_step)}</p>`
              : ""
          }
          ${
            !m.notes
              ? `<label class="field"><span>Meeting notes</span>
                   <textarea rows="3" data-notes-for="${m.id}" placeholder="What was discussed, what they asked for, who was in the room"></textarea></label>
                 <label class="field"><span>Outcome</span>
                   <select data-outcome-for="${m.id}">
                     <option value="">Let the system read the notes</option>
                     ${MEETING_OUTCOMES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
                   </select></label>
                 <button class="btn btn-sm btn-primary" data-save-notes="${m.id}">Save notes</button>`
              : `<p class="meet-notes">${esc(m.notes)}</p>`
          }
        </div>`
        )
        .join("")}

      <div class="grid-3">
        <label class="field"><span>Schedule a meeting</span><input type="datetime-local" id="mt-when" /></label>
        <label class="field"><span>Link</span><input id="mt-link" placeholder="Meet / Zoom URL" /></label>
        <label class="field"><span>Attendees</span><input id="mt-who" /></label>
      </div>
      <button class="btn btn-sm" id="add-meeting">Add meeting</button>
    </section>`;
}

/* --- items 22-23: proposals and versions --- */

function wsProposalBlock(d) {
  const draft = outreach.proposalDraft;

  return `
    <section class="ws-section">
      <h3>Proposal</h3>

      ${
        d.proposals.length
          ? `<div class="ver-list">
               ${d.proposals
                 .map(
                   (p, i) => `
                 <div class="ver-row">
                   <span class="ver-tag">V${p.version}</span>
                   <span class="ver-price">${inrShort(p.price)}</span>
                   ${
                     i < d.proposals.length - 1
                       ? `<span class="ver-delta">${deltaLabel(p.price, d.proposals[i + 1].price)}</span>`
                       : `<span class="ver-delta">—</span>`
                   }
                   <span class="muted">${esc(p.user_name || "")} · ${esc(dateOnly(p.created_at))}</span>
                   <span class="ver-note">${esc(p.change_note || "")}</span>
                 </div>`
                 )
                 .join("")}
             </div>`
          : `<p class="muted">No versions yet.</p>`
      }

      <button class="btn btn-sm btn-primary" id="gen-proposal">Write the proposal</button>

      ${
        draft
          ? `<label class="field"><span>Proposal body</span>
               <textarea id="prop-body" rows="14">${esc(draft.body)}</textarea></label>
             <div class="grid-3">
               <label class="field"><span>Price ₹</span>
                 <input type="number" id="prop-price" value="${Number(d.opportunity.quoted_price || 0)}" /></label>
               <label class="field"><span>What changed</span>
                 <input id="prop-note" placeholder="e.g. dropped to match their budget" /></label>
             </div>
             <button class="btn btn-primary" id="save-proposal">Save as V${d.proposals.length + 1}</button>`
          : ""
      }
    </section>`;
}

/** V2 against V3 — the number that makes discounting visible at a glance. */
function deltaLabel(newer, older) {
  const a = Number(newer);
  const b = Number(older);
  if (!a || !b) return "—";
  const pct = ((a - b) / b) * 100;
  if (Math.abs(pct) < 0.5) return "no change";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`;
}

/* --- item 16: the timeline --- */

function wsTimelineBlock(d) {
  if (!d.timeline.length) return "";
  return `
    <section class="ws-section">
      <h3>History</h3>
      <div class="tl">
        ${d.timeline
          .map(
            (t) => `
          <div class="tl-row">
            <span class="tl-date">${esc(dateOnly(t.at))}</span>
            <span class="tl-dot tl-${esc(t.kind)}"></span>
            <span class="tl-text">${esc(t.text)}${t.who ? ` · ${esc(t.who)}` : ""}</span>
          </div>`
          )
          .join("")}
      </div>
    </section>`;
}

/* --- items 12 & 14: closing it, won or lost --- */

function wsCloseBlock(d) {
  const o = d.opportunity;

  if (o.stage === "won") {
    return `<section class="ws-section ws-won"><h3>Won</h3><p>Booked at ${inr(o.won_value || o.quoted_price)}.</p></section>`;
  }

  if (o.stage === "lost" && d.loss) {
    const l = d.loss;
    return `
      <section class="ws-section ws-lost">
        <h3>Lost</h3>
        <p><span class="mono-label">Reason</span>${esc(l.primary_reason.replace(/_/g, " "))}</p>
        ${l.note ? `<p><span class="mono-label">Note</span>${esc(l.note)}</p>` : ""}
        ${l.competitor_name ? `<p><span class="mono-label">Went to</span>${esc(l.competitor_name)}</p>` : ""}
        ${l.could_have_changed ? `<p><span class="mono-label">What would have changed it</span>${esc(l.could_have_changed)}</p>` : ""}
        ${l.reapproach_at ? `<p><span class="mono-label">Try again on</span>${esc(dateOnly(l.reapproach_at))}</p>` : ""}
      </section>`;
  }

  const reasons = d.loss_reasons || [];

  return `
    <section class="ws-section">
      <h3>Close this deal</h3>
      <div class="ws-actions">
        <button class="btn btn-sm btn-primary" id="mark-won">We won this</button>
        <button class="btn btn-sm btn-danger" id="open-lost">We lost this</button>
      </div>
      ${
        o.approval_status === "pending"
          ? `<p class="tag-warn">You cannot mark this won until a manager approves the price.</p>`
          : ""
      }

      <div id="lost-form" hidden>
        <p class="hint">A minute here tells the whole company why deals are being lost. Please fill it in properly.</p>

        <label class="field"><span>1. What happened? *</span>
          <select id="ls-primary">
            <option value="">Pick a reason</option>
            ${reasons.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}
          </select></label>

        <label class="field"><span>Any other reason</span>
          <select id="ls-secondary">
            <option value="">None</option>
            ${reasons.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}
          </select></label>

        <label class="field"><span>2. Who did the client choose?</span>
          <select id="ls-chose">
            <option value="">Don't know</option>
            <option value="competitor">A competitor</option>
            <option value="internal">Did it internally</option>
            <option value="nobody">Nobody</option>
          </select></label>

        <div class="grid-2">
          <label class="field"><span>Competitor name</span><input id="ls-comp" /></label>
          <label class="field"><span>3. Approximate competitor budget ₹</span><input type="number" id="ls-compbudget" /></label>
        </div>

        <span class="mono-label">4. What did the client dislike?</span>
        <div class="chips" id="ls-dislikes">
          ${DISLIKES.map(([v, l]) => `<button class="chip" data-dislike="${v}">${l}</button>`).join("")}
        </div>

        <label class="field"><span>5. What could have changed the outcome?</span>
          <textarea id="ls-changed" rows="2"></textarea></label>

        <label class="field"><span>Your notes</span>
          <textarea id="ls-note" rows="2" placeholder="e.g. Client liked the concept but budget was ₹5L against ₹8L proposed"></textarea></label>

        <div class="grid-2">
          <label class="field"><span>6. Should we try again later?</span>
            <select id="ls-reapproach"><option value="">No</option><option value="yes">Yes</option></select></label>
          <label class="field"><span>7. When?</span>
            <select id="ls-days"><option value="">—</option><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option></select></label>
        </div>

        <button class="btn btn-danger btn-block" id="save-lost">Record the loss</button>
      </div>
    </section>`;
}

/* ── workspace wiring ─────────────────────────────────────────────────────── */

function wireWorkspace() {
  const panel = $("#ws-panel");
  const d = outreach.opp;
  const o = d.opportunity;
  const id = o.id;

  const on = (sel, event, fn) => {
    const el = $(sel, panel);
    if (el) el.addEventListener(event, fn);
  };

  const guard = async (fn) => {
    try { await fn(); } catch (err) { toast(err.message, true); }
  };

  /* item 4 */
  on("#recommend-service", "click", () =>
    guard(async () => {
      toast("Thinking…");
      await api(`/api/outreach/${id}/recommend-service`, { method: "POST" });
      await reloadWorkspace();
    })
  );

  on("#accept-service", "click", () =>
    guard(async () => {
      await api(`/api/outreach/${id}/service`, {
        method: "POST",
        body: {
          primary: o.service_primary,
          secondary: o.service_secondary,
          optional: o.service_optional,
          accepted_ai: true,
        },
      });
      await reloadWorkspace();
    })
  );

  on("#change-service", "click", () => {
    const picker = $("#service-picker", panel);
    picker.hidden = !picker.hidden;
  });

  on("#save-service", "click", () =>
    guard(async () => {
      await api(`/api/outreach/${id}/service`, {
        method: "POST",
        body: { primary: $("#svc-primary", panel).value },
      });
      await reloadWorkspace();
    })
  );

  /* items 5-7 */
  for (const btn of $$("[data-plan]", panel)) {
    btn.addEventListener("click", () =>
      guard(async () => {
        const { quote } = await api("/api/outreach/quote", {
          method: "POST",
          body: { service: o.service_primary, tier: btn.dataset.plan },
        });
        // Record the choice in state BEFORE repainting. Picking a plan
        // pre-fills the price with its list price — the salesperson is pricing
        // off the card unless they deliberately change it.
        outreach.pendingTier = btn.dataset.plan;
        outreach.builderOpen = false;
        if (quote.list_price) outreach.pendingPrice = quote.list_price;
        outreach.quote = quote;
        paintWorkspace();
      })
    );
  }

  on("#toggle-builder", "click", () => {
    outreach.builderOpen = !($("#plan-builder", panel) && !$("#plan-builder", panel).hidden);
    if (outreach.builderOpen) outreach.pendingTier = "custom";
    $("#plan-builder", panel).hidden = !outreach.builderOpen;
  });

  for (const chip of $$("[data-deliv]", panel)) {
    chip.addEventListener("click", () => chip.classList.toggle("is-on"));
  }

  const readPlanConfig = () => ({
    geography: $("#pb-geo", panel) ? $("#pb-geo", panel).value : null,
    language: $("#pb-lang", panel) ? $("#pb-lang", panel).value : null,
    views_m: $("#pb-views", panel) ? Number($("#pb-views", panel).value) : 0,
    creator_mix: {
      nano: $("#pb-nano", panel) ? Number($("#pb-nano", panel).value) : 0,
      micro: $("#pb-micro", panel) ? Number($("#pb-micro", panel).value) : 0,
      macro: $("#pb-macro", panel) ? Number($("#pb-macro", panel).value) : 0,
    },
    deliverables: $$("[data-deliv].is-on", panel).map((c) => c.dataset.deliv),
  });

  // A custom build always wins over a card selection: opening the builder is
  // the salesperson saying "not one of these".
  const currentTier = () => {
    if (outreach.builderOpen) return "custom";
    return outreach.pendingTier || o.plan_tier || "custom";
  };

  on("#run-quote", "click", () =>
    guard(async () => {
      const { quote } = await api("/api/outreach/quote", {
        method: "POST",
        body: {
          service: o.service_primary,
          tier: currentTier(),
          plan_config: readPlanConfig(),
          price: Number($("#pb-price", panel).value),
          budget: Number($("#pb-budget", panel).value),
        },
      });
      outreach.quote = quote;
      outreach.pendingPrice = Number($("#pb-price", panel).value) || 0;
      paintWorkspace();
    })
  );

  on("#save-plan", "click", () =>
    guard(async () => {
      const { quote } = await api(`/api/outreach/${id}/plan`, {
        method: "POST",
        body: {
          service: o.service_primary,
          tier: currentTier(),
          plan_config: readPlanConfig(),
          price: Number($("#pb-price", panel).value),
          budget: Number($("#pb-budget", panel).value),
        },
      });
      outreach.quote = quote;
      toast(
        quote.requires_approval
          ? "Saved — your manager has to approve this price"
          : `Saved — ${quote.margin_pct}% margin`,
        quote.requires_approval
      );
      outreach.pendingTier = null;
      outreach.pendingPrice = null;
      await reloadWorkspace();
    })
  );

  /* items 8-9 */
  on("#gen-pitch", "click", () =>
    guard(async () => {
      toast("Writing…");
      const { pitch } = await api(`/api/outreach/${id}/pitch`, { method: "POST" });
      outreach.pitch = pitch;
      paintWorkspace();
    })
  );

  for (const tab of $$("[data-pitch-tab]", panel)) {
    tab.addEventListener("click", () => {
      const key = tab.dataset.pitchTab;
      const p = outreach.pitch;
      $$("[data-pitch-tab]", panel).forEach((t) => t.classList.toggle("is-on", t === tab));
      $("#pitch-subject-wrap", panel).hidden = key !== "email";
      $("#pitch-body", panel).value = key === "email" ? p.email.body : p[key] || "";
    });
  }

  on("#copy-pitch", "click", () => {
    const text = $("#pitch-body", panel).value;
    navigator.clipboard.writeText(text).then(
      () => toast("Copied"),
      () => toast("Couldn't copy — select the text and copy manually", true)
    );
  });

  on("#log-sent", "click", () =>
    guard(async () => {
      const active = $("[data-pitch-tab].is-on", panel);
      const channel = active ? active.dataset.pitchTab : "email";
      await api(`/api/outreach/${id}/sent`, {
        method: "POST",
        body: {
          channel: channel === "call_script" ? "call" : channel === "proposal_intro" ? "note" : channel,
          subject: $("#pitch-subject", panel) ? $("#pitch-subject", panel).value : null,
          body: $("#pitch-body", panel).value,
          generated: true,
        },
      });
      outreach.pitch = null;
      toast("Logged — follow-up sequence started");
      await reloadWorkspace();
    })
  );

  /* items 11 & 17 */
  on("#log-reply", "click", () =>
    guard(async () => {
      const body = $("#reply-body", panel).value.trim();
      if (!body) return toast("Paste the reply first", true);
      toast("Reading it…");
      const { classification } = await api(`/api/outreach/${id}/reply`, {
        method: "POST",
        body: { body },
      });
      toast(`${classification.intent} — ${classification.next_action}`);
      await reloadWorkspace();
    })
  );

  /* items 18-19 */
  for (const btn of $$("[data-fu-draft]", panel)) {
    btn.addEventListener("click", () =>
      guard(async () => {
        toast("Writing…");
        await api(`/api/outreach/${id}/followup/${btn.dataset.fuDraft}/draft`, { method: "POST" });
        await reloadWorkspace();
      })
    );
  }
  for (const btn of $$("[data-fu-done]", panel)) {
    btn.addEventListener("click", () =>
      guard(async () => {
        await api(`/api/outreach/${id}/followup/${btn.dataset.fuDone}/done`, { method: "POST" });
        await reloadWorkspace();
      })
    );
  }

  /* items 20-21 */
  on("#add-meeting", "click", () =>
    guard(async () => {
      const when = $("#mt-when", panel).value;
      if (!when) return toast("Pick a date and time", true);
      await api(`/api/outreach/${id}/meeting`, {
        method: "POST",
        body: {
          scheduled_at: new Date(when).toISOString(),
          link: $("#mt-link", panel).value,
          attendees: $("#mt-who", panel).value,
        },
      });
      await reloadWorkspace();
    })
  );

  for (const btn of $$("[data-save-notes]", panel)) {
    btn.addEventListener("click", () =>
      guard(async () => {
        const mid = btn.dataset.saveNotes;
        toast("Reading the notes…");
        await api(`/api/outreach/meeting/${mid}/notes`, {
          method: "POST",
          body: {
            notes: $(`[data-notes-for="${mid}"]`, panel).value,
            outcome: $(`[data-outcome-for="${mid}"]`, panel).value || null,
          },
        });
        await reloadWorkspace();
      })
    );
  }

  /* items 22-23 */
  on("#gen-proposal", "click", () =>
    guard(async () => {
      toast("Drafting…");
      const { draft } = await api(`/api/outreach/${id}/proposal/draft`, { method: "POST" });
      outreach.proposalDraft = draft;
      paintWorkspace();
    })
  );

  on("#save-proposal", "click", () =>
    guard(async () => {
      const { quote } = await api(`/api/outreach/${id}/proposal`, {
        method: "POST",
        body: {
          body: $("#prop-body", panel).value,
          price: Number($("#prop-price", panel).value),
          change_note: $("#prop-note", panel).value,
        },
      });
      outreach.proposalDraft = null;
      toast(
        quote.requires_approval ? "Saved — that discount needs your manager's approval" : "Proposal saved",
        quote.requires_approval
      );
      await reloadWorkspace();
    })
  );

  /* items 12 & 14 */
  on("#mark-won", "click", () =>
    guard(async () => {
      await api(`/api/outreach/${id}/stage`, { method: "POST", body: { stage: "won" } });
      toast("Marked won");
      await reloadWorkspace();
      renderOutreach();
    })
  );

  on("#open-lost", "click", () => {
    const form = $("#lost-form", panel);
    form.hidden = !form.hidden;
  });

  for (const chip of $$("[data-dislike]", panel)) {
    chip.addEventListener("click", () => chip.classList.toggle("is-on"));
  }

  on("#save-lost", "click", () =>
    guard(async () => {
      const primary = $("#ls-primary", panel).value;
      if (!primary) return toast("Pick a primary reason", true);

      await api(`/api/outreach/${id}/lost`, {
        method: "POST",
        body: {
          primary_reason: primary,
          secondary_reason: $("#ls-secondary", panel).value || null,
          chose: $("#ls-chose", panel).value || null,
          competitor_name: $("#ls-comp", panel).value || null,
          competitor_budget: Number($("#ls-compbudget", panel).value) || null,
          disliked: $$("[data-dislike].is-on", panel).map((c) => c.dataset.dislike),
          could_have_changed: $("#ls-changed", panel).value || null,
          note: $("#ls-note", panel).value || null,
          reapproach: $("#ls-reapproach", panel).value === "yes",
          reapproach_days: Number($("#ls-days", panel).value) || null,
        },
      });
      toast("Recorded — it'll show up in Intelligence");
      await reloadWorkspace();
      renderOutreach();
    })
  );
}
