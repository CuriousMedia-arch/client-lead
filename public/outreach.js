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
  proposalDraft: null,
  // Which slab is being drilled into, or null for the normal grouped view.
  // Lives in state, not the DOM, so a repaint after any action keeps the
  // filter the user chose.
  focus: null,
  recommending: false,
  pitchTab: "email",
  wsTab: "now",
  google: {},              // whether Google is set up / connected
  deckLink: null,          // the packages deck, from the admin templates
  noteMessages: {},        // per-meeting explanation of why notes aren't ready
  writingNotes: null,      // which meeting has its manual notes box open
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

  // No client-side backfill any more. It used to run once per page load, which
  // meant a lead claimed AFTER this tab had been opened never got an
  // opportunity and simply never appeared — only a browser refresh fixed it.
  // The server now does it inside /today, so it cannot fall behind.

  // Cheap, cached for the session, and both are needed by the workspace — so
  // fetch them here rather than on every panel open.
  try {
    outreach.google = await api("/api/microsoft/status");
  } catch {
    outreach.google = { available: [], connected: null };
  }
  try {
    const { templates } = await api("/api/outreach/meta/templates");
    const deck = templates.find((t) => t.key === "deck_link");
    outreach.deckLink = deck && deck.body ? deck.body.trim() : null;
    outreach.templates = templates;
  } catch {
    outreach.templates = [];
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
  if (state.user.role === "admin") views.push(["pricing", "Settings"]);

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
    ["urgent", "Urgent", c.urgent, "time is running out on these", c.urgent ? "is-late" : ""],
    ["followup", "Time to follow up", c.followup, "you said you'd check back", c.followup ? "is-urgent" : ""],
    ["new", "Not started", c.new, "you haven't contacted them yet", ""],
    ["replied", "They replied", c.replied, "waiting for your answer", c.replied ? "is-urgent" : ""],
    ["meeting", "Meetings today", c.meeting, "happening today", ""],
    ["proposal", "Waiting on price approval", c.proposal, "sent, or with your manager", ""],
    ["working", "In progress", c.working || 0, "live conversations, nothing due", ""],
  ];

  const groups = [
    ["urgent", "🔥 Urgent", data.buckets.urgent],
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
        o.countdown.full || o.countdown.label
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
        <span>What we're selling</span><span>Deal size</span><span>Time left</span><span></span>
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
          <span>${o.countdown ? esc(o.countdown.label) : "—"}</span>
          <span><button class="btn btn-sm" data-open-opp="${o.id}">Open</button></span>
        </div>`
        )
        .join("")}
    </div>`;

  wireToday();
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
  let data, tpl;
  try {
    data = await api("/api/outreach/meta/rate-card");
    tpl = await api("/api/outreach/meta/templates");
  } catch (err) {
    body.innerHTML = `<div class="empty"><h2>Couldn't load settings</h2><p>${esc(err.message)}</p></div>`;
    return;
  }
  outreach.rateCard = data;

  const rows = data.rate_card.flatMap((g) => g.plans);
  const g = data.guardrail;
  const cad = data.cadence || {};
  const templates = tpl.templates || [];

  body.innerHTML = `
    <section class="intel-block">
      <h3>Packages and prices</h3>
      <p class="hint">What the team can sell and for how much. Every price in the portal comes from this table.</p>
      <div class="rate-table">
        <div class="rate-head">
          <span>Service</span><span>Tier</span><span>Name</span><span>Price ₹</span>
          <span>Creators</span><span>Views</span><span>What they get</span>
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
      <h3>Discount limit</h3>
      <p class="hint">How much a salesperson can knock off a package on their own. Past this, it goes to a manager before the deal can be marked won.</p>
      <div class="grid-3">
        <label class="field"><span>Biggest discount allowed %</span>
          <input type="number" id="gr-discount" value="${Number(g.max_discount_pct)}" /></label>
      </div>
    </section>

    <section class="intel-block">
      <h3>Reminder timing</h3>
      <p class="hint">How many days after the first message each reminder appears. The last box is different: if someone picks up a lead and sends nothing at all, that's how long before we start nudging them.</p>
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
        <label class="field"><span>Nudge if nothing sent after (hours)</span>
          <input type="number" min="1" id="cad-nudge" value="${Number(cad.nudge_after_hours || 12)}" /></label>
      </div>
      <button class="btn btn-primary" id="save-pricing">Save these settings</button>
    </section>

    <section class="intel-block">
      <h3>Wording and templates</h3>
      <p class="hint">Everything the portal writes on your behalf. Change it here and it applies everywhere — no code change needed. Placeholders like <code>{{company}}</code> get filled in automatically.</p>
      ${templates
        .map(
          (t) => `
        <div class="tpl-block" data-tpl="${esc(t.key)}">
          <label class="field">
            <span>${esc(t.label)}</span>
            <p class="hint tpl-hint">${esc(t.hint || "")}</p>
            ${
              t.key === "deck_link"
                ? `<input data-tpl-body value="${esc(t.body || "")}" placeholder="https://…" />`
                : `<textarea data-tpl-body rows="${t.key === "service_guidance" ? 8 : 5}"
                     placeholder="${esc(t.body ? "" : "Not filled in yet")}">${esc(t.body || "")}</textarea>`
            }
          </label>
        </div>`
        )
        .join("")}
      <button class="btn btn-primary" id="save-templates">Save wording</button>
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
      guardrail: { max_discount_pct: Number($("#gr-discount").value) },
      followup_cadence: {
        step1_days: Number($("#cad-1").value),
        step2_days: Number($("#cad-2").value),
        step3_days: Number($("#cad-3").value),
        step4_days: Number($("#cad-4").value),
        nudge_after_hours: Number($("#cad-nudge").value),
        contact_hours: Number(cad.contact_hours) || 24,
        reply_days: Number(cad.reply_days) || 7,
        close_days: Number(cad.close_days) || 7,
      },
    };

    try {
      await api("/api/outreach/meta/rate-card", { method: "PUT", body: payload });
      toast("Saved");
      renderPricing();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#save-templates").addEventListener("click", async () => {
    const payload = {
      templates: $$("[data-tpl]").map((el) => ({
        key: el.dataset.tpl,
        body: el.querySelector("[data-tpl-body]").value,
      })),
    };
    try {
      await api("/api/outreach/meta/templates", { method: "PUT", body: payload });
      toast("Wording saved");
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
}

async function openWorkspace(id) {
  const { backdrop, panel } = workspaceEls();
  backdrop.hidden = false;
  panel.hidden = false;
  panel.innerHTML = `<p class="muted" style="padding:32px">Opening…</p>`;

  outreach.pendingTier = null;
  outreach.pendingPrice = null;

  try {
    outreach.opp = await api(`/api/outreach/${id}`);
    outreach.opp.execution = (await api(`/api/outreach/${id}/execution`)).items;
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
  outreach.opp.execution = (await api(`/api/outreach/${id}/execution`)).items;
  paintWorkspace();
}

/**
 * The five tabs, and what lives in each.
 *
 * The workspace used to be ten sections stacked in one scroll, all open, all
 * the same weight. Nothing said where the deal was or what to do next — you
 * read the whole thing every time to find the one part that mattered.
 *
 *   Now       what this deal needs today: the reply waiting, the reminder
 *             due, and the buttons that close it
 *   Message   one place to decide what you're selling, at what price, and to
 *             write the message that says so — package, price and pitch are
 *             one job, so they are one screen
 *   Meetings  booking, notes, forwarding them on
 *   Delivery  what we've promised, once there is something to promise
 *   History   everything that has happened, including how the price moved
 */
const WS_TABS = [
  ["now", "Now"],
  ["message", "Message"],
  ["meetings", "Meetings"],
  ["delivery", "Delivery"],
  ["history", "History"],
];

/** The funnel as a rail, so position is visible without reading anything. */
function wsStageRail(o) {
  const steps = [
    ["new", "Not started"],
    ["contacted", "Contacted"],
    ["replied", "Replied"],
    ["meeting", "Meeting"],
    ["proposal", "Quoted"],
    ["negotiation", "Negotiating"],
  ];

  if (o.stage === "won" || o.stage === "lost") {
    return `<div class="stage-rail is-closed">
              <span class="rail-closed rail-${esc(o.stage)}">
                ${o.stage === "won" ? "Won" : "Lost"}
              </span>
            </div>`;
  }

  const here = steps.findIndex(([k]) => k === o.stage);

  return `
    <div class="stage-rail">
      ${steps
        .map(
          ([key, label], i) => `
        <span class="rail-step ${i < here ? "is-done" : ""} ${i === here ? "is-here" : ""}">
          <i></i><span>${esc(label)}</span>
        </span>`
        )
        .join("")}
    </div>`;
}

/**
 * How many things in each tab want attention. A number on a tab is what makes
 * a collapsed section discoverable — without it, work hides behind a label
 * nobody clicks.
 */
function wsTabBadges(d) {
  const o = d.opportunity;
  const waiting =
    o.last_reply_at && (!o.last_contacted_at || o.last_reply_at > o.last_contacted_at) ? 1 : 0;
  const dueReminders = (d.followups || []).filter(
    (f) => f.status === "due" && new Date(f.due_at) <= new Date()
  ).length;
  const notesToWrite = (d.meetings || []).filter(
    (m) => !m.notes && new Date(m.scheduled_at) < new Date()
  ).length;

  return {
    now: waiting + dueReminders + (o.approval_status === "pending" ? 1 : 0),
    meetings: notesToWrite,
    message: 0,
    delivery: (d.execution || []).filter((e) => e.status === "blocked").length,
    history: 0,
  };
}

function paintWorkspace() {
  const { panel } = workspaceEls();
  const d = outreach.opp;
  const o = d.opportunity;
  const tab = outreach.wsTab || "now";
  const badges = wsTabBadges(d);

  // Every action repaints the whole panel, which resets the scroll to the top.
  // Generating a message is the worst case: you press a button in the middle
  // of the panel and get thrown back to the company name with the thing you
  // asked for somewhere off screen.
  const wasScrolled = $(".ws-body", panel) ? $(".ws-body", panel).scrollTop : 0;

  const bodies = {
    now: () => wsNowTab(d),
    message: () => wsServiceBlock(d) + wsPlanBlock(d) + wsPitchBlock(d),
    meetings: () => wsMeetingBlock(d),
    delivery: () => wsExecutionBlock(d) || emptyTab("Nothing to deliver yet.",
      "Once a price is out, plan what we've promised here."),
    history: () => wsTimelineBlock(d) + wsPriceHistory(d) + wsHistoryBlock(d),
  };

  panel.innerHTML = `
    <header class="ws-head">
      <div>
        <p class="eyebrow"><span class="dot"></span>${esc(STAGE_LABEL[o.stage] || o.stage)}</p>
        <h2>${esc(o.company)}</h2>
      </div>
      <button class="drawer-close" id="ws-close" aria-label="Close">×</button>
    </header>

    ${wsContactBlock(d)}
    ${wsStageRail(o)}

    <nav class="ws-tabs">
      ${WS_TABS.map(
        ([key, label]) => `
        <button class="ws-tab ${key === tab ? "is-on" : ""}" data-ws-tab="${key}">
          ${esc(label)}${badges[key] ? `<i class="ws-tab-badge">${badges[key]}</i>` : ""}
        </button>`
      ).join("")}
    </nav>

    <div class="ws-body">
      ${(bodies[tab] || bodies.now)()}
    </div>`;

  // Restore before the browser paints, so there is no visible jump.
  const body = $(".ws-body", panel);
  if (body && wasScrolled) body.scrollTop = wasScrolled;

  for (const btn of $$("[data-ws-tab]", panel)) {
    btn.addEventListener("click", () => {
      outreach.wsTab = btn.dataset.wsTab;
      paintWorkspace();
      // A new tab starts at the top; carrying the old tab's scroll into it
      // lands you halfway down something you have not seen.
      const body = $(".ws-body", $("#ws-panel"));
      if (body) body.scrollTop = 0;
    });
  }

  // Buttons on the Now tab that send you somewhere to act.
  for (const btn of $$("[data-goto-tab]", panel)) {
    btn.addEventListener("click", () => {
      outreach.wsTab = btn.dataset.gotoTab;
      paintWorkspace();
      const body = $(".ws-body", $("#ws-panel"));
      if (body) body.scrollTop = 0;
    });
  }

  $("#ws-close").addEventListener("click", closeWorkspace);
  wireWorkspace();
}

/**
 * Repaint, then bring one section into view.
 *
 * Used after something is generated: staying exactly where you were is right
 * for a save, but wrong when the whole point of the click was to produce
 * something new further down.
 */
function paintAndReveal(selector) {
  paintWorkspace();
  const el = $(selector, $("#ws-panel"));
  if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function emptyTab(title, hint) {
  return `<section class="ws-section"><p class="muted">${esc(title)}</p>
            ${hint ? `<p class="hint">${esc(hint)}</p>` : ""}</section>`;
}

/**
 * The Now tab: what this deal needs from you today, and nothing else.
 *
 * Ordered by what it costs to ignore — an unanswered reply first, because
 * somebody is sitting there waiting, then a reminder that has fallen due,
 * then the clock, then closing it out.
 */
function wsNowTab(d) {
  const o = d.opportunity;
  const waiting =
    o.last_reply_at && (!o.last_contacted_at || o.last_reply_at > o.last_contacted_at);
  const dueReminder = (d.followups || []).find(
    (f) => f.status === "due" && new Date(f.due_at) <= new Date()
  );
  const lastReply = (d.messages || []).find((m) => m.direction === "in");

  // One line at the top saying what to do. The classifier's own words when it
  // has read a reply, otherwise derived from the stage.
  const nextAction =
    o.next_action ||
    {
      new: "Send the first message — open the Message tab.",
      contacted: "Waiting on a reply. Send a reminder when one falls due.",
      replied: "They've answered. Read it and decide the next move.",
      meeting: "Meeting booked. Write the notes straight after it.",
      proposal: "Price is out. Chase it, or close the deal.",
      negotiation: "Close it — won or lost.",
    }[o.stage] ||
    "Keep this moving.";

  return `
    <section class="ws-section ws-next">
      <span class="mono-label">What to do next</span>
      <p class="ws-next-line">${esc(nextAction)}</p>
      ${
        o.stage === "new"
          ? `<button class="btn btn-sm btn-primary" data-goto-tab="message">Write the first message</button>`
          : ""
      }
    </section>

    ${
      waiting && lastReply
        ? `<section class="ws-section ws-urgent">
             <h3>They replied — your turn</h3>
             <div class="reply-box reply-${esc(lastReply.sentiment || "neutral")}">
               <div class="reply-head">
                 <span class="reply-verdict">${esc((lastReply.intent || "reply").replace(/_/g, " "))}</span>
                 <span class="muted">${esc(shortDateTime(lastReply.created_at))}</span>
               </div>
               <p class="reply-body">${esc(lastReply.body)}</p>
               ${
                 lastReply.ai_next_action
                   ? `<p class="reply-action"><span class="mono-label">Suggested</span>${esc(
                       lastReply.ai_next_action
                     )}</p>`
                   : ""
               }
             </div>
             <div class="ws-actions">
               <button class="btn btn-sm btn-primary" data-goto-tab="message">Reply</button>
               <button class="btn btn-sm" data-goto-tab="meetings">Book a meeting</button>
             </div>
           </section>`
        : ""
    }

    ${
      dueReminder
        ? `<section class="ws-section ws-urgent">
             <h3>Reminder ${dueReminder.step} is due</h3>
             <p class="hint">${esc(FOLLOWUP_KIND[dueReminder.kind] || dueReminder.kind)}</p>
             ${dueReminder.suggestion ? `<pre class="fu-suggestion">${esc(dueReminder.suggestion)}</pre>` : ""}
             <div class="ws-actions">
               <button class="btn btn-sm btn-primary" data-fu-draft="${dueReminder.step}">Write it for me</button>
               <button class="btn btn-sm btn-ghost" data-fu-done="${dueReminder.step}">Mark done</button>
             </div>
           </section>`
        : ""
    }

    ${
      o.approval_status === "pending"
        ? `<section class="ws-section ws-urgent">
             <h3>Waiting on your manager</h3>
             <p class="hint">${esc(o.approval_reason || "This price is discounted past the limit.")}</p>
           </section>`
        : ""
    }

    ${wsLogReplyBlock(d)}
    ${wsFollowupBlock(d)}
    ${wsCloseBlock(d)}`;
}

const FOLLOWUP_KIND = {
  reminder: "A gentle nudge — no new pitch, no pressure.",
  value: "Share something useful, rather than asking again.",
  angle: "Try a different angle. Reference something recent about them.",
  nurture: "Stop chasing. Leave the door open.",
};

/* --- contact header (item 3) --- */

function wsContactBlock(d) {
  const o = d.opportunity;

  // Two kinds of opportunity, one block.
  //
  //   A claim on a PERSON (from All Leads) has exactly one contact and there is
  //   nothing to choose.
  //
  //   A claim on a COMPANY (from Fresh Leads) borrowed that company's people
  //   for the news window. There is one thing to sell and one price, but
  //   several people who could receive it — so this one gets a picker.
  const companyLevel = Boolean(o.lead_id);
  const primary =
    d.contacts.find((c) => c.id === (o.focus_contact_id || o.contact_id)) ||
    (companyLevel ? null : d.contacts[0]);

  const clock = o.countdown
    ? `<span class="clock ${o.countdown.overdue ? "clock-over" : o.countdown.urgent ? "clock-soon" : ""}">${esc(
        o.countdown.full || o.countdown.label
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
          <span class="mono-label">${companyLevel ? "Who we're writing to" : "Contact"}</span>
          ${
            companyLevel
              ? `<select id="focus-pick" class="focus-pick">
                   <option value="">Choose a person…</option>
                   ${d.contacts
                     .map(
                       (c) =>
                         `<option value="${c.id}" ${
                           c.id === o.focus_contact_id ? "selected" : ""
                         }>${esc(c.name)}${c.role ? ` — ${esc(c.role)}` : ""}</option>`
                     )
                     .join("")}
                 </select>
                 <p class="hint">${d.contacts.length} ${
                   d.contacts.length === 1 ? "person" : "people"
                 } came with this company for the news window.</p>`
              : `<p class="ws-strong">${esc(primary ? primary.name : "No contact on file")}</p>
                 <p class="muted">${esc((primary && primary.role) || "—")}</p>`
          }
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

/**
 * Packages and proposal, in one section.
 *
 * They were two sections and that was wrong: choosing a package and writing
 * the proposal that quotes it are one job, and splitting them meant scrolling
 * between the price you picked and the document that names it.
 *
 * The custom package builder is gone. Every quote is now a listed package,
 * optionally discounted — which also removed the cost breakdown, so nothing on
 * this screen shows what delivery costs us.
 */
function wsPlanBlock(d) {
  const o = d.opportunity;
  const card = (outreach.rateCard && outreach.rateCard.rate_card) || [];
  const group = card.find((g) => g.service === o.service_primary);
  const q = outreach.quote;
  const tier = outreach.pendingTier || o.plan_tier;
  const price = outreach.pendingPrice != null ? outreach.pendingPrice : Number(o.quoted_price || 0);
  const draft = outreach.proposalDraft;

  if (!o.service_primary) {
    return `<section class="ws-section" id="package-section">
              <h3>What we’re selling, and for how much</h3>
              <p class="muted">Choose a service above first.</p>
            </section>`;
  }

  return `
    <section class="ws-section" id="package-section">
      <h3>What we’re selling, and for how much</h3>

      ${
        group
          ? `<div class="plan-grid">
               ${group.plans
                 .map(
                   (p) => `
                 <button class="plan-card ${tier === p.tier ? "is-on" : ""}" data-plan="${esc(p.tier)}">
                   <span class="plan-price">${inrShort(p.price)}</span>
                   <span class="plan-label">${esc(p.label)}</span>
                   <span class="plan-detail">${p.creators ? `${p.creators} creators` : ""}</span>
                   <span class="plan-detail">${esc(p.views || "")}</span>
                   <span class="plan-detail">${esc(p.deliverables || "")}</span>
                 </button>`
                 )
                 .join("")}
             </div>`
          : `<p class="muted">No packages set up for ${esc(o.service_primary)} yet. An admin can add them under Pricing.</p>`
      }

      <div class="grid-3">
        <label class="field"><span>What they can spend ₹</span>
          <input type="number" id="pb-budget" value="${Number(o.client_budget || 0)}" /></label>
        <label class="field"><span>What we're charging ₹</span>
          <input type="number" id="pb-price" value="${price}" /></label>
        <div class="field"><span class="mono-label">&nbsp;</span>
          <button class="btn btn-sm" id="run-quote">Check this price</button></div>
      </div>

      ${discountBox(q, o)}

      <button class="btn btn-primary" id="save-plan">Save package &amp; price</button>

    </section>`;
}

/**
 * The discount check.
 *
 * All the cost working — creator cost, our overheads, margin percentage — has
 * been taken out at the client's request. What remains is the one question a
 * salesperson actually needs answered before sending a price: is this discount
 * something I can sign off myself, or does it go to my manager?
 */
function discountBox(q, o) {
  const source =
    q ||
    (o.approval_status
      ? {
          status: o.approval_status === "pending" ? "blocked" : "ok",
          label:
            o.approval_status === "pending"
              ? "Needs your manager's approval"
              : o.approval_status === "approved"
              ? "Approved by your manager"
              : "Your manager said no",
          reasons: o.approval_reason ? [o.approval_reason] : [],
        }
      : null);

  if (!source) return "";

  const tone = source.status === "ok" ? "gr-good" : "gr-bad";

  return `
    <div class="guardrail ${tone}">
      <div class="gr-verdict">
        <span class="gr-dot"></span>
        <strong>${esc(source.label)}</strong>
        ${
          source.discount_pct > 0
            ? `<span class="gr-margin">${Number(source.discount_pct).toFixed(0)}% off standard</span>`
            : ""
        }
      </div>
      ${
        source.reasons && source.reasons.length
          ? `<ul class="gr-reasons">${source.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
          : ""
      }
    </div>`;
}

/* --- items 8-9: pitch generator + composer --- */

function wsPitchBlock(d) {
  const p = outreach.pitch;

  // What has already gone out, per channel. The old version wiped the draft the
  // moment you pressed Mark as sent, which assumed one message per lead on one
  // platform — but the same pitch normally goes out on email AND LinkedIn AND
  // WhatsApp, and you had to regenerate it each time.
  const sentChannels = new Set(
    (d.messages || []).filter((m) => m.direction === "out").map((m) => m.channel)
  );

  const activeTab = outreach.pitchTab || "email";
  const isEmail = activeTab === "email";
  const channelKey =
    activeTab === "call_script" ? "call" : activeTab === "proposal_intro" ? "note" : activeTab;
  const alreadySent = sentChannels.has(channelKey);

  const bodyFor = (k) => (k === "email" ? (p && p.email.body) || "" : (p && p[k]) || "");

  return `
    <section class="ws-section" id="pitch-section">
      <h3>Message to send</h3>
      <p class="hint">Written from their company, their recent news, your contact's job title and what you're selling — so it doesn't read like a template.</p>
      <button class="btn btn-sm btn-primary" id="gen-pitch">${
        p ? "Rewrite it" : "Write my message"
      }</button>

      ${
        p
          ? `<div class="pitch-box">
               ${
                 p.source === "rules"
                   ? `<p class="tag-warn">Our AI writer is switched off, so this is a standard template. Please edit it before you send.</p>`
                   : ""
               }

               ${pitchReasoning(d, p)}

               <div class="chips" id="pitch-tabs">
                 ${CHANNELS.map(
                   ([k, label]) => {
                     const key =
                       k === "call_script" ? "call" : k === "proposal_intro" ? "note" : k;
                     return `<button class="chip ${k === activeTab ? "is-on" : ""}" data-pitch-tab="${k}">${label}${
                       sentChannels.has(key) ? " ✓" : ""
                     }</button>`;
                   }
                 ).join("")}
               </div>

               <label class="field" id="pitch-subject-wrap" ${isEmail ? "" : "hidden"}>
                 <span>Subject</span>
                 <input id="pitch-subject" value="${esc((p.email && p.email.subject) || "")}" />
               </label>
               <label class="field">
                 <span>Message</span>
                 <textarea id="pitch-body" rows="10">${esc(bodyFor(activeTab))}</textarea>
               </label>

               <div class="ws-actions">
                 <button class="btn btn-sm" id="copy-pitch">Copy</button>
                 ${
                   outreach.deckLink
                     ? `<a class="btn btn-sm" href="${esc(outreach.deckLink)}" target="_blank" rel="noopener">Open the deck</a>`
                     : ""
                 }
                 <button class="btn btn-sm ${alreadySent ? "" : "btn-primary"}" id="log-sent">
                   ${alreadySent ? "Send this again" : "Mark as sent"}
                 </button>
               </div>
               <p class="hint">${
                 alreadySent
                   ? "Already sent on this channel — the draft stays here so you can use it on the others too."
                   : "Copy this, paste it into your email or WhatsApp, send it, then click Mark as sent. That schedules your reminders and adds it to the record below."
               }</p>
             </div>`
          : ""
      }

      ${wsSentBlock(d)}
    </section>`;
}

/**
 * Why the message says what it says.
 *
 * "Don't just write a message" — a salesperson about to send something in their
 * own name needs to see what it was built from, both to trust it and to catch
 * it when one of the inputs is wrong. That second case is real: a news
 * headline attached to the wrong company reads perfectly fluently and is
 * mortifying to send.
 */
function pitchReasoning(d, p) {
  const o = d.opportunity;
  const used = [];

  if (o.company) used.push(["Company", o.company]);
  if (o.focus_name || o.contact_name)
    used.push([
      "Writing to",
      `${o.focus_name || o.contact_name}${
        o.focus_role || o.contact_role ? `, ${o.focus_role || o.contact_role}` : ""
      }`,
    ]);
  if (o.industry) used.push(["Industry", o.industry]);
  if (p.signal_title) used.push(["Their recent news", p.signal_title]);
  if (o.service_primary) used.push(["Selling", o.service_primary]);
  if (o.plan_name) used.push(["Package", o.plan_name]);
  if (o.quoted_price) used.push(["Price quoted", inr(o.quoted_price)]);

  if (!used.length) return "";

  return `
    <details class="pitch-why" ${p.mismatch ? "open" : ""}>
      <summary>What we used to write this</summary>
      ${
        p.mismatch
          ? `<p class="tag-warn">Careful — the news headline on file mentions a different company. Check it before sending.</p>`
          : ""
      }
      <dl class="why-list">
        ${used
          .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
          .join("")}
      </dl>
      ${p.why ? `<p class="why-note">${esc(p.why)}</p>` : ""}
    </details>`;
}

/**
 * What has actually gone out.
 *
 * Only inbound messages were shown before, so once a pitch was logged there was
 * no way to see what you had actually said — which matters most when a reply
 * arrives three days later and you cannot remember what you sent.
 */
function wsSentBlock(d) {
  const sent = (d.messages || []).filter((m) => m.direction === "out");
  if (!sent.length) return "";

  const LABEL = {
    email: "Email", linkedin: "LinkedIn", whatsapp: "WhatsApp",
    call: "Call", note: "Note", meeting: "Meeting",
  };

  return `
    <div class="sent-list">
      <span class="mono-label">What you've sent</span>
      ${sent
        .map(
          (m, i) => `
        <details class="sent-row" ${i === 0 ? "open" : ""}>
          <summary>
            <span class="sent-chan">${esc(LABEL[m.channel] || m.channel)}</span>
            <span class="sent-when">${esc(shortDateTime(m.sent_at || m.created_at))}</span>
            <span class="sent-peek">${esc((m.subject || m.body || "").slice(0, 60))}</span>
          </summary>
          ${m.subject ? `<p class="sent-subject">${esc(m.subject)}</p>` : ""}
          <pre class="sent-body">${esc(m.body)}</pre>
        </details>`
        )
        .join("")}
    </div>`;
}

/* --- items 11 & 17: log a reply, get it classified --- */

/**
 * Logging what came back.
 *
 * The reply itself is shown at the top of the Now tab, where it can't be
 * missed. This is only the box for pasting in a new one — previously the two
 * were the same section, which meant the most important thing on the screen
 * sat underneath a text area.
 */
function wsLogReplyBlock(d) {
  return `
    <section class="ws-section">
      <h3>Did they reply?</h3>
      <label class="field">
        <span>Paste what they wrote back</span>
        <textarea id="reply-body" rows="3" placeholder="e.g. Sounds interesting, send me your deck"></textarea>
      </label>
      <button class="btn btn-sm btn-primary" id="log-reply">Save their reply</button>
      <p class="hint">Saving a reply switches off your pending reminders, so you never send "just following up" after they've already written back.</p>
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

/* --- meetings, Google Meet, and notes --- */

const MEETING_OUTCOME_LABEL = Object.fromEntries(MEETING_OUTCOMES);

function wsMeetingBlock(d) {
  const g = outreach.google || {};

  return `
    <section class="ws-section" id="meeting-section">
      <h3>Meetings</h3>

      ${
        !(g.available || []).length
          ? `<p class="tag-warn">Microsoft isn't set up on this deployment yet, so meetings won't get a Teams link.
               <button class="btn btn-sm" id="check-ms">Check what's missing</button></p>`
          : ""
      }
      <div id="ms-check"></div>
      ${
        (g.available || []).length && !g.connected
          ? `<p class="tag-warn">Connect your account and meetings booked here get a
               ${g.available.includes("microsoft") ? "Teams" : "Meet"} link automatically, plus notes afterwards.
               ${(g.available || [])
                 .map(
                   (p) =>
                     `<button class="btn btn-sm" data-connect="${p}">Connect ${
                       p === "microsoft" ? "Microsoft" : "Google"
                     }</button>`
                 )
                 .join(" ")}</p>`
          : ""
      }
      ${
        g.connected && g.last_error
          ? `<p class="tag-warn">${esc(g.label || "Your account")} refused the last request — you may need to reconnect.
               <button class="btn btn-sm" data-connect="${esc(g.connected)}">Reconnect</button></p>`
          : ""
      }

      ${d.meetings.map(meetingCard).join("")}

      <div class="grid-3">
        <label class="field"><span>When</span><input type="datetime-local" id="mt-when" /></label>
        <label class="field"><span>How long</span>
          <select id="mt-mins">
            <option value="30">30 minutes</option>
            <option value="45">45 minutes</option>
            <option value="60">1 hour</option>
            <option value="15">15 minutes</option>
          </select></label>
        <label class="field"><span>Anyone else (email)</span><input id="mt-who" placeholder="optional, comma separated" /></label>
      </div>
      <button class="btn btn-sm btn-primary" id="add-meeting">
        ${g.connected ? `Book it and send a ${g.connected === "microsoft" ? "Teams" : "Meet"} link` : "Add meeting"}
      </button>
      ${
        g.connected
          ? `<p class="hint">This creates the calendar invite, generates the ${
                 g.connected === "microsoft" ? "Teams" : "Google Meet"
               } link and emails everyone. Your contact is invited automatically.</p>`
          : ""
      }
    </section>`;
}

function meetingCard(m) {
  const state = m.transcript_state;

  return `
    <div class="meet-box">
      <div class="meet-head">
        <strong>${esc(shortDateTime(m.scheduled_at))}</strong>
        ${
          m.meet_link
            ? `<a class="meet-join" href="${esc(m.meet_link)}" target="_blank" rel="noopener">Join ${
                m.provider === "microsoft" ? "Teams" : "Meet"
              }</a>`
            : m.link
            ? `<a href="${esc(m.link)}" target="_blank" rel="noopener">Join</a>`
            : ""
        }
        ${m.outcome ? `<span class="tag-soft">${esc(MEETING_OUTCOME_LABEL[m.outcome] || m.outcome.replace(/_/g, " "))}</span>` : ""}
      </div>

      ${m.attendees ? `<p class="muted">${esc(m.attendees)}</p>` : ""}
      ${m.requirement ? `<p><span class="mono-label">What they need</span>${esc(m.requirement)}</p>` : ""}
      ${
        m.structured && m.structured.next_step
          ? `<p><span class="mono-label">Next step</span>${esc(m.structured.next_step)}</p>`
          : ""
      }

      ${
        m.notes
          ? `<div class="meet-notes-wrap">
               <span class="mono-label">Notes${m.notes_generated_at ? " — written from the call recording" : ""}</span>
               <p class="meet-notes">${esc(m.notes)}</p>
               <div class="ws-actions">
                 <button class="btn btn-sm" data-forward-notes="${m.id}">Email these notes</button>
                 ${
                   m.notes_sent_at
                     ? `<span class="muted">Sent to ${esc(m.notes_sent_to || "")} on ${esc(dateOnly(m.notes_sent_at))}</span>`
                     : ""
                 }
               </div>
             </div>`
          : `<div class="meet-actions">
               ${
                 m.meet_link
                   ? `<button class="btn btn-sm btn-primary" data-fetch-notes="${m.id}">Get notes from the call</button>`
                   : ""
               }
               <button class="btn btn-sm" data-write-notes="${m.id}">Write notes myself</button>
             </div>

             ${
               state && state !== "ready"
                 ? `<p class="hint">${esc(outreach.noteMessages[m.id] || "")}</p>`
                 : outreach.noteMessages[m.id]
                 ? `<p class="hint">${esc(outreach.noteMessages[m.id])}</p>`
                 : ""
             }

             ${
               outreach.writingNotes === m.id
                 ? `<label class="field"><span>What was discussed</span>
                      <textarea rows="4" data-notes-for="${m.id}" placeholder="What they asked for, who was in the room, what happens next"></textarea></label>
                    <label class="field"><span>How did it go?</span>
                      <select data-outcome-for="${m.id}">
                        <option value="">Let the system read the notes</option>
                        ${MEETING_OUTCOMES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
                      </select></label>
                    <button class="btn btn-sm btn-primary" data-save-notes="${m.id}">Save notes</button>`
                 : ""
             }`
      }
    </div>`;
}

/* --- the execution plan --- */

/**
 * What we deliver once it's won: deliverable, when, who owns it.
 *
 * Only appears from proposal stage onward. Before that there is nothing to
 * plan, and an empty planning table on a lead nobody has spoken to yet is
 * noise on the one screen that is supposed to be free of it.
 */
function wsExecutionBlock(d) {
  const o = d.opportunity;
  const items = d.execution || [];
  const relevant = ["proposal", "negotiation", "won"].includes(o.stage) || items.length;
  if (!relevant) return "";

  const STATUS = {
    pending: "Not started",
    in_progress: "In progress",
    done: "Done",
    blocked: "Blocked",
  };

  return `
    <section class="ws-section" id="execution-section">
      <h3>Execution plan</h3>
      <p class="hint">What we've promised to deliver, by when, and who owns it.</p>

      ${
        items.length
          ? `<div class="exec-list">
               <div class="exec-head">
                 <span>Deliverable</span><span>Due</span><span>Owner</span><span>Status</span><span></span>
               </div>
               ${items
                 .map(
                   (it) => `
                 <div class="exec-row exec-${esc(it.status)}">
                   <span class="exec-what">${esc(it.deliverable)}</span>
                   <span class="exec-due ${
                     it.due_date && new Date(it.due_date) < new Date() && it.status !== "done"
                       ? "is-late"
                       : ""
                   }">${it.due_date ? esc(dateOnly(it.due_date)) : "—"}</span>
                   <span>${esc(it.owner_name || "—")}</span>
                   <span>
                     <select class="exec-status" data-exec-status="${it.id}">
                       ${Object.entries(STATUS)
                         .map(
                           ([v, l]) =>
                             `<option value="${v}" ${it.status === v ? "selected" : ""}>${l}</option>`
                         )
                         .join("")}
                     </select>
                   </span>
                   <span><button class="btn btn-sm btn-ghost" data-exec-remove="${it.id}">Remove</button></span>
                 </div>`
                 )
                 .join("")}
             </div>`
          : `<p class="muted">Nothing planned yet.</p>`
      }

      <div class="grid-3">
        <label class="field"><span>Deliverable</span>
          <input id="ex-what" placeholder="e.g. 50 creator reels live" /></label>
        <label class="field"><span>Due</span><input type="date" id="ex-due" /></label>
        <label class="field"><span>Owner</span><input id="ex-owner" placeholder="who's responsible" /></label>
      </div>
      <button class="btn btn-sm" id="add-exec">Add to the plan</button>
    </section>`;
}

/**
 * How the price moved, under History.
 *
 * Package, price and message are one job now, so there is no Proposal section
 * to hang this off — but the record still matters. V1 ₹10L → V2 ₹8.5L → V3
 * ₹7.5L, with who changed it and why, is the only way to see how much gets
 * discounted away and by whom. It just belongs in the record rather than in
 * the middle of the working screen.
 */
function wsPriceHistory(d) {
  const versions = d.proposals || [];
  if (!versions.length) return "";

  return `
    <section class="ws-section">
      <h3>How the price moved</h3>
      <div class="ver-list">
        ${versions
          .map(
            (p, i) => `
          <details class="ver-row-wrap">
            <summary class="ver-row">
              <span class="ver-tag">V${p.version}</span>
              <span class="ver-price">${inrShort(p.price)}</span>
              ${
                i < versions.length - 1
                  ? `<span class="ver-delta">${deltaLabel(p.price, versions[i + 1].price)}</span>`
                  : `<span class="ver-delta">—</span>`
              }
              <span class="muted">${esc(p.user_name || "")} · ${esc(dateOnly(p.created_at))}</span>
              <span class="ver-note">${esc(p.change_note || "")}</span>
            </summary>
            ${p.body ? `<pre class="ver-body">${esc(p.body)}</pre>` : ""}
          </details>`
          )
          .join("")}
      </div>
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

/**
 * What was already tried at this company, on earlier claims.
 *
 * A Fresh window closing hands the account back to the pool, so the next
 * person to pick it up starts from scratch — unless they can see that someone
 * pitched the same service in March and lost it on price. Without this the
 * company gets the identical approach twice and notices.
 */
function wsHistoryBlock(d) {
  const past = d.history || [];
  if (!past.length) return "";

  return `
    <section class="ws-section ws-history">
      <h3>Tried before at this company</h3>
      <p class="hint">Earlier attempts, by you or anyone else. Worth a look before you pitch.</p>
      ${past
        .map(
          (h) => `
        <div class="hist-row hist-${esc(h.stage)}">
          <span class="hist-when">${esc(dateOnly(h.created_at))}</span>
          <span class="hist-who">${esc(h.owner_name || "Someone")}</span>
          <span class="hist-what">
            ${esc(h.service_primary || "No service chosen")}${
            h.quoted_price ? ` · ${inrShort(h.quoted_price)}` : ""
          }
          </span>
          <span class="hist-result">
            ${
              h.stage === "won"
                ? "Won"
                : h.stage === "lost"
                ? `Lost — ${esc((h.lost_reason || "no reason given").replace(/_/g, " "))}`
                : esc(STAGE_LABEL[h.stage] || h.stage)
            }
          </span>
          <span class="hist-effort">${h.sent_count || 0} sent · ${h.meeting_count || 0} met</span>
        </div>`
        )
        .join("")}
    </section>`;
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

        <label class="field"><span>1. What happened? <em class="req">required</em></span>
          <select id="ls-primary">
            <option value="">Pick a reason</option>
            ${reasons.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}
          </select></label>

        <label class="field"><span>Any other reason</span>
          <select id="ls-secondary">
            <option value="">None</option>
            ${reasons.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}
          </select></label>

        <label class="field"><span>2. Who did they go with? <em class="req">required</em></span>
          <select id="ls-chose">
            <option value="">Choose one</option>
            <option value="competitor">A competitor</option>
            <option value="internal">Did it internally</option>
            <option value="nobody">Nobody</option>
          </select></label>

        <label class="field"><span>Their name, if you know it</span><input id="ls-comp" /></label>

        <span class="mono-label">What did they dislike? (optional)</span>
        <div class="chips" id="ls-dislikes">
          ${DISLIKES.map(([v, l]) => `<button class="chip" data-dislike="${v}">${l}</button>`).join("")}
        </div>

        <label class="field"><span>3. What could have changed the outcome? <em class="req">required</em></span>
          <textarea id="ls-changed" rows="2"></textarea></label>

        <label class="field"><span>Your notes</span>
          <textarea id="ls-note" rows="2" placeholder="e.g. Client liked the concept but budget was ₹5L against ₹8L proposed"></textarea></label>

        <div class="grid-2">
          <label class="field"><span>4. Should we try again later? <em class="req">required</em></span>
            <select id="ls-reapproach"><option value="">Choose one</option><option value="no">No</option><option value="yes">Yes</option></select></label>
          <label class="field"><span>5. When? <em class="req">required if yes</em></span>
            <select id="ls-days"><option value="">—</option><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option></select></label>
        </div>

        <button class="btn btn-danger btn-block" id="save-lost">Record the loss</button>
      </div>
    </section>`;
}

/**
 * Review before sending.
 *
 * The brief asked to be able to check the follow-up email before it goes, so
 * this is a dialog rather than a one-click send — the whole point is the pause.
 */
function openForwardDialog(meetingId, draft) {
  const existing = $("#forward-dialog");
  if (existing) existing.remove();

  const box = document.createElement("div");
  box.id = "forward-dialog";
  box.className = "modal-backdrop";
  box.innerHTML = `
    <div class="modal-box">
      <h3>Email these notes</h3>
      <label class="field"><span>To</span>
        <input id="fw-to" value="${esc(draft.to || "")}" placeholder="their email address" /></label>
      <label class="field"><span>Subject</span>
        <input id="fw-subject" value="${esc(draft.subject || "")}" /></label>
      <label class="field"><span>Message</span>
        <textarea id="fw-body" rows="14">${esc(draft.body || "")}</textarea></label>
      <div class="ws-actions">
        <button class="btn btn-primary" id="fw-send">Send it</button>
        <button class="btn" id="fw-copy">Copy instead</button>
        <button class="btn btn-sm" id="fw-cancel">Cancel</button>
      </div>
      <p class="hint">Sent from your own Google account, so replies come back to you.</p>
    </div>`;

  document.body.appendChild(box);

  const close = () => box.remove();
  box.addEventListener("click", (e) => { if (e.target === box) close(); });
  $("#fw-cancel", box).addEventListener("click", close);

  $("#fw-copy", box).addEventListener("click", () => {
    navigator.clipboard.writeText($("#fw-body", box).value).then(
      () => toast("Copied"),
      () => toast("Couldn't copy — select the text and copy manually", true)
    );
  });

  $("#fw-send", box).addEventListener("click", async () => {
    const to = $("#fw-to", box).value.trim();
    if (!to.includes("@")) return toast("Who should this go to?", true);
    try {
      await api(`/api/outreach/meeting/${meetingId}/forward`, {
        method: "POST",
        body: { to, subject: $("#fw-subject", box).value, body: $("#fw-body", box).value },
      });
      close();
      toast(`Sent to ${to}`);
      await reloadWorkspace();
    } catch (err) {
      // Almost always "Google isn't connected". Keep the draft on screen so
      // nothing they typed is lost — they can still copy it out.
      toast(err.message, true);
    }
  });
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

  /* who the pitch goes to, on a company-level claim */
  on("#focus-pick", "change", () =>
    guard(async () => {
      await api(`/api/outreach/${id}/focus`, {
        method: "POST",
        body: { contact_id: $("#focus-pick", panel).value || null },
      });
      // Repaint: the pitch is written for whoever is selected, so a draft on
      // screen is now addressed to the wrong person.
      outreach.pitch = null;
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
        if (quote.recommended_price) outreach.pendingPrice = quote.recommended_price;
        outreach.quote = quote;
        paintWorkspace();
      })
    );
  }

  // A package is either chosen off the card or it is whatever was saved last.
  // The custom builder that used to feed this is gone.
  const currentTier = () => outreach.pendingTier || o.plan_tier || null;

  on("#run-quote", "click", () =>
    guard(async () => {
      const { quote } = await api("/api/outreach/quote", {
        method: "POST",
        body: {
          service: o.service_primary,
          tier: currentTier(),
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
          price: Number($("#pb-price", panel).value),
          budget: Number($("#pb-budget", panel).value),
        },
      });
      outreach.quote = quote;
      toast(
        quote.requires_approval
          ? "Saved — your manager has to approve this discount"
          : "Package and price saved",
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
      paintAndReveal("#pitch-section");
    })
  );

  for (const tab of $$("[data-pitch-tab]", panel)) {
    tab.addEventListener("click", () => {
      // Through state, not the DOM: marking one channel sent repaints the
      // panel, and the channel you were on has to survive that.
      outreach.pitchTab = tab.dataset.pitchTab;
      paintWorkspace();
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
      const channel = outreach.pitchTab || "email";
      await api(`/api/outreach/${id}/sent`, {
        method: "POST",
        body: {
          channel: channel === "call_script" ? "call" : channel === "proposal_intro" ? "note" : channel,
          subject: $("#pitch-subject", panel) ? $("#pitch-subject", panel).value : null,
          body: $("#pitch-body", panel).value,
          generated: true,
        },
      });
      // The draft stays. The same pitch normally goes out on more than one
      // channel, and clearing it forced a regenerate — which produced slightly
      // different wording each time.
      toast(`Logged as sent on ${channel === "call_script" ? "call" : channel}`);
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
  on("#check-ms", "click", () =>
    guard(async () => {
      const box = $("#ms-check", panel);
      box.innerHTML = `<p class="hint">Checking…</p>`;
      const r = await api("/api/microsoft/check");

      // Every step, with the console that fixes it. Showing only the first
      // failure would mean four round trips through an admin who isn't you.
      box.innerHTML = `
        <div class="setup-check">
          ${r.steps
            .map(
              (s) => `
            <div class="setup-step setup-${s.ok === true ? "ok" : s.ok === false ? "bad" : "skip"}">
              <span class="setup-mark">${s.ok === true ? "✓" : s.ok === false ? "✕" : "–"}</span>
              <div>
                <strong>${esc(s.name)}</strong>
                ${s.detail ? `<p class="setup-detail">${esc(s.detail)}</p>` : ""}
                ${s.fix ? `<p class="setup-fix">${esc(s.fix)}</p>` : ""}
              </div>
            </div>`
            )
            .join("")}
        </div>`;
    })
  );

  for (const btn of $$("[data-connect]", panel)) {
    btn.addEventListener("click", () =>
      guard(async () => {
        const { url } = await api(`/api/${btn.dataset.connect}/connect`);
        window.location.href = url;
      })
    );
  }

  on("#add-meeting", "click", () =>
    guard(async () => {
      const when = $("#mt-when", panel).value;
      if (!when) return toast("Pick a date and time", true);

      const res = await api(`/api/outreach/${id}/meeting`, {
        method: "POST",
        body: {
          scheduled_at: new Date(when).toISOString(),
          minutes: Number($("#mt-mins", panel).value) || 30,
          attendees: $("#mt-who", panel).value,
        },
      });

      // Say what actually happened. A meeting saved without a Meet link
      // because Calendar refused is a different situation from one saved
      // without a link because Google was never connected.
      toast(
        res.meet_created
          ? "Booked — invite sent with a Meet link"
          : res.meet_error
          ? `Saved, but Google wouldn't create the invite: ${res.meet_error}`
          : "Meeting saved"
      , Boolean(res.meet_error));

      await reloadWorkspace();
    })
  );

  for (const btn of $$("[data-fetch-notes]", panel)) {
    btn.addEventListener("click", () =>
      guard(async () => {
        const mid = btn.dataset.fetchNotes;
        toast("Asking Google for the recording…");
        const res = await api(`/api/outreach/meeting/${mid}/fetch-notes`, { method: "POST" });

        if (res.state !== "ready") {
          // Keep the reason on screen, not just in a toast that vanishes —
          // "transcription was never switched on" is something they need to
          // act on, and it will still be true tomorrow.
          outreach.noteMessages[mid] = res.message;
          paintWorkspace();
          return toast(res.message, true);
        }

        delete outreach.noteMessages[mid];
        toast("Notes written from the call");
        await reloadWorkspace();
      })
    );
  }

  for (const btn of $$("[data-write-notes]", panel)) {
    btn.addEventListener("click", () => {
      outreach.writingNotes =
        outreach.writingNotes === btn.dataset.writeNotes ? null : btn.dataset.writeNotes;
      paintWorkspace();
    });
  }

  for (const btn of $$("[data-forward-notes]", panel)) {
    btn.addEventListener("click", () =>
      guard(async () => {
        const mid = btn.dataset.forwardNotes;
        const draft = await api(`/api/outreach/meeting/${mid}/forward-draft`);
        openForwardDialog(mid, draft);
      })
    );
  }

  /* the execution plan */
  on("#add-exec", "click", () =>
    guard(async () => {
      const what = $("#ex-what", panel).value.trim();
      if (!what) return toast("What's the deliverable?", true);
      await api(`/api/outreach/${id}/execution`, {
        method: "POST",
        body: {
          deliverable: what,
          due_date: $("#ex-due", panel).value || null,
          owner_name: $("#ex-owner", panel).value || null,
        },
      });
      await reloadWorkspace();
    })
  );

  for (const sel of $$("[data-exec-status]", panel)) {
    sel.addEventListener("change", () =>
      guard(async () => {
        await api(`/api/outreach/execution/${sel.dataset.execStatus}`, {
          method: "PATCH",
          body: { status: sel.value },
        });
        await reloadWorkspace();
      })
    );
  }

  for (const btn of $$("[data-exec-remove]", panel)) {
    btn.addEventListener("click", () =>
      guard(async () => {
        await api(`/api/outreach/execution/${btn.dataset.execRemove}`, { method: "DELETE" });
        await reloadWorkspace();
      })
    );
  }

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
        outreach.writingNotes = null;
        await reloadWorkspace();
      })
    );
  }

  /* items 22-23 */
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
      // Checked here as well as on the server so the person gets told which
      // box, not just that something was missing.
      const primary = $("#ls-primary", panel).value;
      const chose = $("#ls-chose", panel).value;
      const changed = $("#ls-changed", panel).value.trim();
      const again = $("#ls-reapproach", panel).value;
      const days = $("#ls-days", panel).value;

      if (!primary) return toast("Say what happened", true);
      if (!chose) return toast("Say who they went with", true);
      if (!changed) return toast("Say what could have changed the outcome", true);
      if (!again) return toast("Say whether we should try again", true);
      if (again === "yes" && !days) return toast("Say when we should try again", true);

      await api(`/api/outreach/${id}/lost`, {
        method: "POST",
        body: {
          primary_reason: primary,
          secondary_reason: $("#ls-secondary", panel).value || null,
          chose,
          competitor_name: $("#ls-comp", panel).value || null,
          disliked: $$("[data-dislike].is-on", panel).map((c) => c.dataset.dislike),
          could_have_changed: changed,
          note: $("#ls-note", panel).value || null,
          reapproach: again,
          reapproach_days: Number(days) || null,
        },
      });
      toast("Recorded — it'll show up in Intelligence");
      await reloadWorkspace();
      renderOutreach();
    })
  );
}
