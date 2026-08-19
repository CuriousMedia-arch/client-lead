/* =========================================================================
   Curious Media — Lead Intelligence (frontend)
   No build step: plain ES modules-free JS so `npm start` is the only command.
   ========================================================================= */

// ── Helpers ────────────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape anything user- or news-supplied before it goes into innerHTML. */
function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Every request the page makes. Throws with the server's message on failure. */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* an empty body is fine for some responses */
  }

  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data || {};
}

let toastTimer;
function toast(message, isError = false) {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.className = `toast ${isError ? "is-error" : ""}`;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3200);
}

function timeAgo(iso) {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months === 1 ? "last month" : `${months}mo ago`;
}

/** Outreach stages, shown in the dropdown on a claimed lead. */
const STATUSES = [
  ["new", "New"],
  ["working", "Working"],
  ["contacted", "Contacted"],
  ["replied", "Replied"],
  ["qualified", "Qualified"],
  ["won", "Won"],
  ["lost", "Lost"],
];

/** Little markers on the outreach timeline. */
const KIND_ICON = {
  note: "\u270E",
  email: "\u2709",
  call: "\u260E",
  linkedin: "in",
  meeting: "\u2691",
  status: "\u21C4",
  claim: "\u2691",
};

/** Small inline LinkedIn glyph, used wherever a link points at a LinkedIn page. */
const LI_ICON =
  `<svg class="li-icon" width="14" height="14" viewBox="0 0 448 448" aria-hidden="true">` +
  `<path fill="currentColor" d="M100 55a45 45 0 1 1-90 0 45 45 0 0 1 90 0ZM8 149h84v261H8V149Zm146 0h81v36h1c11-21 39-43 81-43 87 0 103 57 103 132v136h-84V291c0-32-1-74-45-74-46 0-53 36-53 72v121h-84V149Z"/>` +
  `</svg>`;

/** Everything the page keeps in memory between renders. */
const state = {
  user: null,
  team: [],
  tab: "all",
  // Which sub-list "My Outreach" is showing — claims from All Leads or from
  // Fresh Leads. They're separate commitments, so they never mix in one list.
  mineView: "all",
  search: "",
  types: new Set(),
  statuses: new Set(),
  hygiene: new Set(),
  freshness: null,
  tier: "",
  sort: "company",
  scanning: false,
  runPoll: null,
  lastRun: null,
  freshWindowDays: 3,
  // Where the Newspaper drill-down currently is. null at a level means that
  // level hasn't been chosen yet, so that's the picker being shown.
  np: { year: null, month: null, day: null },
  npLeads: [],
};

// Mirrors lib/triggers.js — the agency's own playbook.
const SIGNAL_TYPES = [
  ["capital", "Funding & Capital"],
  ["brand_launch", "Launch & Ambassador"],
  ["retail_expansion", "Retail Expansion"],
  ["leadership", "Leadership Move"],
  ["crisis", "Brand Crisis"],
  ["none", "No clear trigger"],
];

// Signals filed before the playbook existed used older names.
const LEGACY_TYPES = {
  funding: "capital", m_and_a: "capital", financials: "capital",
  launch: "brand_launch", partnership: "brand_launch",
  expansion: "retail_expansion", other: "none",
};

const TIER_OF = {
  capital: 1, brand_launch: 1, retail_expansion: 1,
  leadership: 2, crisis: 2, none: 3,
};

const TIER_TEXT = {
  1: ["HOT", "Call today"],
  2: ["WARM", "Reach out this week"],
  3: ["LOW", "Drip email only"],
};

const segId = (t) => (TIER_OF[t] ? t : LEGACY_TYPES[t] || "none");
const tierOf = (t) => TIER_OF[segId(t)];

/** Priority, in words. No numeric score anywhere — the tier IS the answer. */
function tierBadge(tier, note) {
  const t = tier || 3;
  const [label, fallback] = TIER_TEXT[t];
  return `<span class="tier tier-${t}">
      <span class="tier-label">${label}</span>
      <span class="tier-note">${esc(note || fallback)}</span>
    </span>`;
}

/** The claim clock, shown top-right of a claimed lead. */
function countdownChip(cd) {
  if (!cd) return "";
  const cls = cd.overdue ? "clock-over" : cd.urgent ? "clock-soon" : "clock-ok";
  return `<span class="clock ${cls}">${esc(cd.label)}</span>`;
}

const typeLabel = (t) => (SIGNAL_TYPES.find((x) => x[0] === segId(t)) || [t, t])[1];
const statusLabel = (s) => (STATUSES.find((x) => x[0] === s) || [s, s])[1];

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function scoreClass(n) {
  if (n >= 80) return "hot";
  if (n >= 60) return "warm";
  if (n >= 40) return "cool";
  return "";
}

// ── Boot ───────────────────────────────────────────────────────────────────

(async function boot() {
  wireEvents();

  try {
    const { user } = await api("/api/auth/me");
    await enterApp(user);
  } catch {
    $("#login").hidden = false;
  }
})();

async function enterApp(user) {
  state.user = user;
  $("#login").hidden = true;
  $("#app").hidden = false;
  $("#me-name").textContent = user.name;
  $("#me-role").textContent = user.role === "admin" ? "Admin" : "Team";
  $("#tab-admin").hidden = user.role !== "admin";
  $("#stat-admin-unclaimed").hidden = user.role !== "admin";

  // Fire the roster alongside the dashboard rather than before it - on a
  // remote database each sequential request is a fresh round trip of latency.
  const team = api("/api/admin/users")
    .then(({ users }) => { state.team = users.filter((u) => u.active); })
    .catch(() => { state.team = []; });

  await Promise.all([team, refresh()]);
}

// ── Events ─────────────────────────────────────────────────────────────────

function wireEvents() {
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const errBox = $("#login-error");
    errBox.hidden = true;
    try {
      const { user, scan } = await api("/api/auth/login", {
        method: "POST",
        body: { username: form.get("username"), password: form.get("password") },
      });
      await enterApp(user);
      // A stale watchlist triggers a fresh sweep at sign-in; say so, because
      // the numbers on screen will move on their own a few minutes later.
      if (scan && scan.started) toast("Scanning for new signals — this takes a few minutes");
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  });

  $("#signout").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    location.reload();
  });

  $("#tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    // Opening the Newspaper starts at the year list rather than wherever the
    // last visit left off, so the tab always looks the same when you arrive.
    if (btn.dataset.tab !== state.tab) state.np = { year: null, month: null, day: null };
    state.tab = btn.dataset.tab;
    $$(".tab").forEach((t) => t.classList.toggle("is-active", t === btn));
    refresh();
  });

  // The filter bar and action bar are re-rendered with every list, so their
  // handlers are delegated from #content rather than bound to the elements.
  let searchTimer;
  $("#content").addEventListener("input", (e) => {
    if (e.target.id !== "f-search") return;
    clearTimeout(searchTimer);
    const v = e.target.value.trim();
    searchTimer = setTimeout(() => {
      state.search = v;
      renderContent({ keepFocus: "f-search" });
    }, 280);
  });

  $("#content").addEventListener("change", (e) => {
    const el = e.target;
    if (el.id === "f-tier") state.tier = el.value;
    else if (el.id === "f-type") {
      state.types.clear();
      if (el.value) state.types.add(el.value);
    } else if (el.id === "f-sort") state.sort = el.value;
    else if (el.dataset.stageFor) return;      // handled in the click/change below
    else return;
    renderContent();
  });

  // Bound once on the container — the list inside is replaced on every render,
  // so binding per render would stack duplicate handlers.
  $("#content").addEventListener("click", onCardClick);

  $("#drawer-backdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer();
    if (e.key === "Escape" && !$("#unclaimed-modal").hidden) closeUnclaimedModal();
  });

  $("#stat-admin-unclaimed").addEventListener("click", openUnclaimedModal);
  $("#unclaimed-backdrop").addEventListener("click", closeUnclaimedModal);
}

function toggleSet(set, value, chip) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
  chip.classList.toggle("is-on", set.has(value));
}

// ── Refresh ────────────────────────────────────────────────────────────────

async function refresh() {
  await Promise.all([loadStats(), renderContent()]);
}

async function loadStats() {
  try {
    const data = await api("/api/stats");
    for (const [key, value] of Object.entries(data.stats)) {
      const el = $(`[data-stat="${key}"]`);
      if (el) el.textContent = value;
    }
    // One pill per tab. These were still pointing at the old tab names, which
    // is why every count sat at zero.
    for (const [tab, value] of [
      ["all", data.totals.leads],
      ["fresh", data.totals.fresh],
      ["mine", data.totals.mine],
      ["newspaper", data.totals.newspaper],
    ]) {
      const pill = $(`[data-count="${tab}"]`);
      if (pill) pill.textContent = value;
    }
    state.freshWindowDays = (data.schedule && data.schedule.freshWindowDays) || 3;
    state.schedule = data.schedule;
    state.run = data.run;
    state.lastRun = data.run.last;
    if (data.run.running && !state.scanning) { state.scanning = true; pollRun(); }
  } catch (err) {
    if (err.status === 401) location.reload();
  }
}

function currentQuery() {
  const p = new URLSearchParams();
  p.set("tab", state.tab);
  if (state.search) p.set("q", state.search);
  if (state.freshness) p.set("freshness", state.freshness);
  if (state.types.size) p.set("types", [...state.types].join(","));
  if (state.statuses.size) p.set("status", [...state.statuses].join(","));
  if (state.hygiene.size) p.set("hygiene", [...state.hygiene].join(","));
  if (state.tier) p.set("tier", state.tier);
  p.set("sort", state.sort);
  return p.toString();
}

// ── Page furniture ─────────────────────────────────────────────────────────

// The tab name already says what the list is, so All Leads carries no subtitle.
// The other two do, because what they hold isn't obvious from the name alone.
const PAGE_COPY = {
  all: ["All Leads", "Your contact database. Claim one and you have 30 days to close it."],
  fresh: [
    "Fresh Leads",
    "News from the last 3 days only. Claim one and you have 10 days.",
  ],
  mine: [
    "My Outreach",
    "What you're working, and how long is left on each. All Leads and Fresh Leads claims are separate — claiming one never claims the other.",
  ],
  newspaper: [
    "Newspaper",
    "Fresh Leads that ran out of time, filed by the date they were released. Anyone can pick these up.",
  ],
};

function actionBar() {
  const [title, desc] = PAGE_COPY[state.tab] || ["Leads", ""];
  const run = state.lastRun;

  return `
    <div class="action-bar">
      <div class="action-bar-left">
        <h1 class="page-title">${esc(title)}</h1>
        ${desc ? `<p class="page-desc">${esc(desc)}</p>` : ""}
        <p class="scan-status">
          <span class="scan-dot"></span>
          ${
            run && run.finished_at
              ? `Last refresh ${esc(timeAgo(run.finished_at))} · refreshes every ${
                  state.freshWindowDays || 3
                } days`
              : "Not refreshed yet"
          }
        </p>
      </div>
      ${
        state.user.role === "admin"
          ? `<div class="action-bar-right">
               ${
                 state.tab === "all"
                   ? `<input type="file" id="ab-csv" accept=".csv,text/csv" class="upload-input" />
                      <button class="btn" id="ab-upload">Import contacts (CSV)</button>`
                   : ""
               }
               <button class="btn btn-primary" id="ab-scan" ${state.scanning ? "disabled" : ""}>
                 ${state.scanning ? "Refreshing…" : "Refresh now"}
               </button>
             </div>`
          : ""
      }
    </div>`;
}

function filterBar() {
  const typeOptions = SIGNAL_TYPES.filter(([v]) => v !== "none")
    .map(([v, l]) => `<option value="${v}">${esc(l)}</option>`)
    .join("");

  const showTier = state.tab !== "all";

  return `
    <div class="filter-bar">
      <input class="search-input" id="f-search" type="search"
             placeholder="Search company or industry…" value="${esc(state.search)}" />

      ${
        showTier
          ? `<span class="filter-label">Priority</span>
             <select class="filter-select" id="f-tier">
               <option value="">All</option>
               <option value="1">Hot only</option>
               <option value="2">Warm</option>
               <option value="3">Low</option>
             </select>

             <span class="filter-label">Trigger</span>
             <select class="filter-select" id="f-type">
               <option value="">Any</option>
               ${typeOptions}
             </select>`
          : ""
      }

      ${
        // The Newspaper has its own ordering — year, then month, then day — so
        // a second sort control there would only fight with it.
        state.tab === "newspaper"
          ? ""
          : `<span class="filter-label">Sort</span>
             <select class="filter-select" id="f-sort">
               ${state.tab === "mine" ? `<option value="urgent">Deadline soonest</option>` : ""}
               <option value="company">Company name (A–Z)</option>
               <option value="recent">Newest signal first</option>
               <option value="added">Recently added</option>
             </select>`
      }
    </div>`;
}

async function renderContent(opts = {}) {
  const content = $("#content");
  if (state.tab === "admin") return renderAdmin();

  let leads;
  try {
    ({ leads } = await api(`/api/leads?${currentQuery()}`));
  } catch (err) {
    content.innerHTML = `<div class="empty"><h2>Couldn't load leads</h2><p>${esc(err.message)}</p></div>`;
    return;
  }

  const body = !leads.length
    ? emptyState().outerHTML
    : state.tab === "all"
    ? databaseTable(leads)
    : state.tab === "newspaper"
    ? newspaperView(leads)
    : state.tab === "fresh"
    ? `<div class="mylead-grid">${leads.map(freshCard).join("")}</div>`
    : myOutreachView(leads);

  content.innerHTML = actionBar() + filterBar() + body;

  if ($("#f-tier")) $("#f-tier").value = state.tier || "";
  if ($("#f-type")) $("#f-type").value = [...state.types][0] || "";
  if ($("#f-sort")) $("#f-sort").value = state.sort;

  if (opts.keepFocus) {
    const el = $("#" + opts.keepFocus);
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }

  wireListActions();
}

/* ── All Leads: the database ─────────────────────────────────────────────── */

/**
 * A record of the contact sheet, one row per company, expandable into its
 * people. No signals, no pitch — that lives in Fresh Leads and Outreach.
 */
/**
 * The sheet writes the website with a scheme sometimes and without one others,
 * and the domain column never has one. An href without a scheme is read as a
 * relative path, so normalise before it goes into the link.
 */
function companyUrl(lead) {
  const raw = lead.website || lead.domain;
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value.replace(/^\/+/, "")}`;
}

/**
 * "City, State" — or whichever half the sheet actually has. The State column
 * is blank for Delhi and the other union territories, so a lead that only
 * knows its city still reads properly rather than as "Delhi, ".
 *
 * Named companyLocation, not location: a top-level `function location` becomes
 * a property of window and collides with window.location, which breaks the
 * whole file and the two location.reload() calls in it.
 */
function companyLocation(lead) {
  return [lead.city, lead.state].filter(Boolean).join(", ") || null;
}

function databaseTable(leads) {
  return `
    <div class="db-table">
      <div class="db-head">
        <span></span>
        <span>Company</span>
        <span>Contacts</span>
        <span>LinkedIn</span>
        <span>Location</span>
        <span>Size</span>
        <span>Revenue</span>
        <span>Owner</span>
        <span class="db-head-end">Claim</span>
      </div>
      ${leads
        .map((lead) => {
          const url = companyUrl(lead);
          const contacts = Number(lead.contact_count) || 0;

          return `
        <div class="db-row" data-lead="${lead.id}">
          <button class="db-toggle" data-expand="${lead.id}" aria-label="Show contacts">▸</button>

          <div class="db-company">
            ${
              url
                ? `<a class="company-name company-link" href="${esc(url)}"
                      target="_blank" rel="noopener">${esc(lead.company)}</a>`
                : `<span class="company-name">${esc(lead.company)}</span>`
            }
            <span class="company-meta">
              ${lead.founded ? `Founded ${esc(lead.founded)}` : "Founded year not on file"}
            </span>
          </div>

          <div class="db-cell">
            ${
              contacts > 0
                ? `<button class="contact-btn" data-expand="${lead.id}">
                     ${contacts} contact${contacts === 1 ? "" : "s"}
                   </button>`
                : `<span class="muted">None on file</span>`
            }
          </div>

          <div class="db-cell">
            ${
              lead.linkedin
                ? `<a class="db-link li-link" href="${esc(lead.linkedin)}"
                      target="_blank" rel="noopener">${LI_ICON}LinkedIn</a>`
                : `<span class="muted">—</span>`
            }
          </div>

          <div class="db-cell" title="${esc(companyLocation(lead) || "")}">
            ${companyLocation(lead) ? esc(companyLocation(lead)) : `<span class="muted">—</span>`}
          </div>

          <div class="db-cell">${esc(lead.employees || "—")}</div>
          <div class="db-cell">${esc(lead.revenue || "—")}</div>

          <div class="db-cell">
            ${
              lead.owner_id
                ? `<span class="owner"><span class="avatar">${esc(
                    initials(lead.owner_name)
                  )}</span>${esc(lead.owner_name)}</span>`
                : `<span class="muted">Unclaimed</span>`
            }
          </div>

          <div class="row-actions">
            ${
              lead.owner_id === state.user.id
                ? `<button class="btn btn-sm" data-act="release" data-source="all" data-id="${lead.id}">Release</button>`
                : lead.owner_id
                ? `<span class="muted locked-tag" title="Locked to ${esc(
                    lead.owner_name || "its owner"
                  )} until released or closed">🔒 Locked</span>`
                : `<button class="btn btn-sm" data-act="claim" data-source="all" data-id="${lead.id}">Claim</button>`
            }
          </div>
        </div>
        <div class="db-contacts" id="contacts-${lead.id}" hidden></div>`;
        })
        .join("")}
    </div>`;
}

/* ── Fresh Leads ─────────────────────────────────────────────────────────── */

/** News on a company you already have. Claimable, no Inspect. */
function freshCard(lead) {
  return `
    <div class="mylead-card">
      <div class="mylead-top">
        <div class="mylead-heading">
          <div class="company-name">${esc(lead.company)}</div>
          <div class="mylead-meta">
            ${lead.fresh_count} new signal${lead.fresh_count === 1 ? "" : "s"} in the last
            ${state.freshWindowDays || 3} days
          </div>
        </div>
        ${tierBadge(lead.tier, lead.tier_note)}
      </div>

      ${signalsByType(lead.signals, null, true)}

      <div class="mylead-actions">
        ${
          lead.fresh_owner_id === state.user.id
            ? `<span class="muted">Yours — see My Outreach → From Fresh Leads</span>
               <button class="btn btn-sm" data-act="release" data-source="fresh" data-id="${lead.id}">Release</button>`
            : `<span class="muted">10 days to close once claimed</span>
               <button class="btn btn-sm btn-primary" data-act="claim" data-source="fresh" data-id="${lead.id}">
                 Claim
               </button>`
        }
      </div>
    </div>`;
}

/* ── My Outreach ─────────────────────────────────────────────────────────── */

/**
 * "My Outreach" now holds two independent lists — what you claimed from All
 * Leads (the contact-database relationship) and what you claimed from Fresh
 * Leads (a specific news signal). A company can sit in one, the other, or
 * both, and closing/releasing one never touches the other. `source` says
 * which track this particular card is showing.
 */
function myOutreachView(leads) {
  const allClaims = leads.filter((l) => l.owner_id === state.user.id);
  const freshClaims = leads.filter((l) => l.fresh_owner_id === state.user.id);
  const view = state.mineView === "fresh" ? "fresh" : "all";
  const list = view === "fresh" ? freshClaims : allClaims;

  return `
    <div class="mine-subtabs">
      <button class="chip ${view === "all" ? "is-on" : ""}" data-mineview="all">
        From All Leads <span class="pill">${allClaims.length}</span>
      </button>
      <button class="chip ${view === "fresh" ? "is-on" : ""}" data-mineview="fresh">
        From Fresh Leads <span class="pill">${freshClaims.length}</span>
      </button>
    </div>
    ${
      list.length
        ? `<div class="mylead-grid">${list.map((l) => outreachCard(l, view)).join("")}</div>`
        : `<div class="empty"><h2>Nothing here yet</h2>
             <p>You haven't claimed anything from ${
               view === "fresh" ? "Fresh Leads" : "All Leads"
             } right now.</p></div>`
    }`;
}

function outreachCard(lead, source) {
  const fresh = source === "fresh";
  const closed = Boolean(fresh ? lead.fresh_closed_at : lead.closed_at);
  const countdown = fresh ? lead.fresh_countdown : lead.countdown;
  const claimWindow = fresh ? lead.fresh_claim_window : lead.claim_window;
  const closedAt = fresh ? lead.fresh_closed_at : lead.closed_at;

  return `
    <div class="mylead-card ${closed ? "is-closed" : ""}" data-lead="${lead.id}">
      <div class="mylead-top">
        <div class="mylead-heading">
          <div class="company-name">${esc(lead.company)}</div>
          <div class="mylead-meta">
            ${
              closed
                ? `Closed ${esc(shortDate(closedAt))}`
                : `Claimed from ${fresh ? "Fresh Leads" : "All Leads"} · ${claimWindow} day window`
            }
          </div>
        </div>
        <div class="mylead-corner">
          ${closed ? `<span class="clock clock-done">Closed</span>` : countdownChip(countdown)}
          ${tierBadge(lead.tier, lead.tier_note)}
        </div>
      </div>

      ${signalsByType(lead.signals, 3, true)}

      ${
        lead.next_action
          ? `<div class="action-box tier-${lead.tier || 3}-box">
               <b>Do this next</b>${esc(lead.next_action)}
             </div>`
          : ""
      }

      ${
        lead.pitch
          ? `<div class="pitch-box">
               <b>What to pitch</b>
               ${lead.angle ? `<span class="pitch-angle">${esc(lead.angle)}</span>` : ""}
               <span class="pitch-body">${esc(lead.pitch)}</span>
             </div>`
          : ""
      }

      <div class="mylead-bottom">
        <button class="btn btn-sm" data-act="open" data-id="${lead.id}">
          ${lead.contact_name ? esc(lead.contact_name) : "Contacts & log"}
        </button>
        <div class="stage-block">
          <span class="filter-label">Stage</span>
          <select class="filter-select stage-select" data-stage-for="${lead.id}">
            ${STATUSES.map(
              ([v, l]) => `<option value="${v}" ${v === lead.status ? "selected" : ""}>${esc(l)}</option>`
            ).join("")}
          </select>
        </div>
      </div>

      <div class="mylead-actions">
        ${
          closed
            ? `<button class="btn btn-ghost btn-sm" data-act="reopen" data-source="${source}" data-id="${lead.id}">Reopen</button>`
            : `<button class="btn btn-sm btn-primary" data-act="close" data-source="${source}" data-id="${lead.id}">Mark closed</button>`
        }
        <button class="btn btn-ghost btn-sm release-trigger" data-act="release" data-source="${source}" data-id="${lead.id}">Release</button>
      </div>
    </div>`;
}

/* ── Newspaper ───────────────────────────────────────────────────────────── */

/**
 * The Newspaper is an archive rather than a feed, so it's browsed the way an
 * archive is: pick a year, then a month, then a day, and read what was filed
 * that day. Everything below works off the list already in memory — the drill
 * -down never goes back to the server.
 */

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** The day a lead was dropped into the Newspaper, or null if it can't be read. */
function releasedOn(lead) {
  const iso = lead.newspaper_date || lead.last_signal_at;
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d) ? null : d;
}

/**
 * leads -> Map(year -> { count, months: Map(month -> { count, days: Map(day -> leads) }) })
 * Insertion order is the order the server sent, which is newest first.
 */
function newspaperTree(leads) {
  const years = new Map();
  const undated = [];

  for (const lead of leads) {
    const d = releasedOn(lead);
    if (!d) { undated.push(lead); continue; }

    const [y, m, day] = [d.getFullYear(), d.getMonth(), d.getDate()];

    if (!years.has(y)) years.set(y, { count: 0, months: new Map() });
    const year = years.get(y);
    year.count++;

    if (!year.months.has(m)) year.months.set(m, { count: 0, days: new Map() });
    const month = year.months.get(m);
    month.count++;

    if (!month.days.has(day)) month.days.set(day, []);
    month.days.get(day).push(lead);
  }

  return { years, undated };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One clickable square in the year / month / day picker. */
function npTile(level, value, label, sub) {
  return `
    <button class="np-tile" data-np="${level}" data-value="${value}">
      <span class="np-tile-label">${esc(label)}</span>
      <span class="np-tile-sub">${esc(sub)}</span>
    </button>`;
}

/** Where you are, and a way back out of it. */
function npCrumbs() {
  const { year, month, day } = state.np;
  const crumbs = [`<button class="np-crumb" data-np="reset" data-value="">All dates</button>`];

  if (year != null)
    crumbs.push(`<button class="np-crumb" data-np="year" data-value="${year}">${year}</button>`);
  if (month != null)
    crumbs.push(
      `<button class="np-crumb" data-np="month" data-value="${month}">${MONTH_NAMES[month]}</button>`
    );
  if (day != null) crumbs.push(`<span class="np-crumb is-here">${day} ${MONTH_NAMES[month]}</span>`);

  return `<nav class="np-crumbs">${crumbs.join(`<span class="np-crumb-sep">›</span>`)}</nav>`;
}

/** The whole tab: breadcrumbs plus whichever level is currently open. */
function newspaperView(leads) {
  state.npLeads = leads;
  return `<div id="np-root">${newspaperLevel(leads)}</div>`;
}

function newspaperLevel(leads) {
  const { years, undated } = newspaperTree(leads);
  const { year, month, day } = state.np;

  // A year that no longer has anything in it — everything got picked up while
  // the page was open. Fall back to the top rather than showing a dead end.
  if (year != null && !years.has(year)) {
    return npCrumbs() + `<div class="np-empty">Nothing is left under this date. Pick another.</div>`;
  }

  if (year == null) {
    const tiles = [...years.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([y, node]) => npTile("year", y, y, plural(node.count, "lead")))
      .join("");

    return `
      ${npCrumbs()}
      <p class="np-hint">Pick a year, then a month, then a day to read what was released.</p>
      <div class="np-grid">${tiles}</div>
      ${
        undated.length
          ? `<p class="np-hint">${plural(undated.length, "lead")} carry no release date and sit outside this list.</p>`
          : ""
      }`;
  }

  const months = years.get(year).months;

  if (month == null) {
    const tiles = [...months.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([m, node]) => npTile("month", m, MONTH_NAMES[m], plural(node.count, "lead")))
      .join("");

    return `${npCrumbs()}<div class="np-grid">${tiles}</div>`;
  }

  if (!months.has(month)) {
    return npCrumbs() + `<div class="np-empty">Nothing is left in this month. Pick another.</div>`;
  }

  const days = months.get(month).days;

  if (day == null) {
    const tiles = [...days.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([d, items]) =>
        npTile("day", d, `${d} ${MONTH_NAMES[month].slice(0, 3)}`, plural(items.length, "lead"))
      )
      .join("");

    return `${npCrumbs()}<div class="np-grid np-grid-days">${tiles}</div>`;
  }

  const items = days.get(day) || [];

  if (!items.length) {
    return (
      npCrumbs() +
      `<div class="np-empty">Everything released on this date has been picked up.</div>`
    );
  }

  return `
    ${npCrumbs()}
    <p class="np-hint">
      ${plural(items.length, "lead")} released on ${day} ${MONTH_NAMES[month]} ${year}.
    </p>
    <div class="mylead-grid">${items.map(newspaperCard).join("")}</div>`;
}

/** Re-draw just the Newspaper body — the drill-down needs no new data. */
function renderNewspaper() {
  const root = $("#np-root");
  if (!root) return;
  root.innerHTML = newspaperLevel(state.npLeads || []);
}

/** The parking lot: Fresh claims whose 10 days ran out. Anyone can take them. */
function newspaperCard(lead) {
  return `
    <div class="mylead-card">
      <div class="mylead-top">
        <div class="mylead-heading">
          <div class="company-name">${esc(lead.company)}</div>
          <div class="mylead-meta">
            Released${lead.last_signal_at ? ` · last news ${esc(timeAgo(lead.last_signal_at))}` : ""}
          </div>
        </div>
        ${tierBadge(lead.tier, lead.tier_note)}
      </div>

      ${signalsByType(lead.signals, 3)}

      <div class="mylead-actions">
        <span class="muted">Went unworked past its deadline</span>
        <button class="btn btn-sm btn-primary" data-act="claim" data-source="fresh" data-id="${lead.id}">
          Pick this up
        </button>
      </div>
    </div>`;
}

/* ── Signals, grouped by type (Funding, Leadership, …) ───────────────────── */

// Order the groups the same way the playbook orders priority: hottest first.
const TYPE_ORDER = ["capital", "brand_launch", "retail_expansion", "leadership", "crisis", "none"];

function signalsByType(signals, limit, hideSummary) {
  const list = (signals || []).slice(0, limit || 8);
  if (!list.length) {
    return `<div class="mylead-signals"><div class="signal-none">No news in the window.</div></div>`;
  }

  const groups = new Map();
  for (const s of list) {
    const key = segId(s.signal_type);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const ordered = [...groups.entries()].sort(
    (a, b) => TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0])
  );

  return `
    <div class="mylead-signals">
      ${ordered
        .map(
          ([type, items]) => `
        <div class="sig-group">
          <div class="sig-group-label type-${esc(type)}">${esc(typeLabel(type))}
            <span class="sig-group-count">${items.length}</span>
          </div>
          ${items
            .map(
              (s) => `
            <div class="mylead-signal-row">
              <a class="mylead-signal-title" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(
                s.title || "Untitled"
              )}</a>
              <span class="mylead-signal-date">${esc(shortDate(s.published || s.created_at))}</span>
              ${!hideSummary && s.summary ? `<p class="sig-sub">${esc(s.summary)}</p>` : ""}
            </div>`
            )
            .join("")}
        </div>`
        )
        .join("")}
    </div>`;
}

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function wireListActions() {
  const upload = $("#ab-upload");
  if (upload) {
    upload.addEventListener("click", () => $("#ab-csv").click());
    $("#ab-csv").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try {
        const csv = await file.text();
        const r = await api("/api/admin/import", { method: "POST", body: { csv } });

        if (r.warning) {
          toast(r.warning, true);
          console.warn("Columns recognised:", r.matched, "| ignored:", r.unmatched);
        } else {
          toast(
            `${r.companiesAdded} new compan${r.companiesAdded === 1 ? "y" : "ies"}, ` +
              `${r.contactsAdded} new contact${r.contactsAdded === 1 ? "" : "s"}` +
              (r.skipped ? ` · ${r.skipped} row${r.skipped === 1 ? "" : "s"} skipped` : "")
          );
        }
        refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  const scan = $("#ab-scan");
  if (scan) {
    scan.addEventListener("click", async () => {
      state.scanning = true;
      renderContent();
      try {
        await api("/api/admin/run", { method: "POST" });
        toast("Refreshing — this takes a few minutes");
        pollRun();
      } catch (err) {
        state.scanning = false;
        toast(err.message, true);
        renderContent();
      }
    });
  }

  $("#content").querySelectorAll("[data-stage-for]").forEach((sel) => {
    sel.addEventListener("change", async () => {
      try {
        await api(`/api/leads/${sel.dataset.stageFor}`, {
          method: "PATCH",
          body: { status: sel.value },
        });
        toast("Stage updated");
        loadStats();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

/** Watches a running refresh so the button and counts settle on their own. */
function pollRun() {
  clearInterval(state.runPoll);
  state.runPoll = setInterval(async () => {
    try {
      const { run } = await api("/api/stats");
      if (!run.running) {
        clearInterval(state.runPoll);
        state.scanning = false;
        state.lastRun = run.last;
        toast("Refresh finished");
        refresh();
      }
    } catch {
      clearInterval(state.runPoll);
      state.scanning = false;
    }
  }, 4000);
}

function shortDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/** ISO timestamp/date -> "YYYY-MM-DD", the only format <input type="date"> accepts. */
function dateOnly(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toISOString().slice(0, 10);
}

function emptyState() {
  const div = document.createElement("div");
  div.className = "empty";

  const copy = {
    all: [
      "Nothing in your database yet",
      "Import your contact sheet from this tab and every company in it becomes a lead, with its people attached.",
    ],
    fresh: [
      "No news in the last few days",
      "Fresh Leads shows companies from your database that made the news. Refresh, or widen the window in settings.",
    ],
    mine: [
      "You haven't claimed anything yet",
      "Claim from All Leads for a 30-day window, or from Fresh Leads for 10 days. They collect here with their countdown.",
    ],
    newspaper: [
      "Nothing has been released",
      "Fresh Leads that aren't closed within 10 days land here for anyone to pick up. An empty page means the team is keeping up.",
    ],
  }[state.tab] || ["Nothing here yet", ""];

  div.innerHTML = `<h2>${esc(copy[0])}</h2><p>${esc(copy[1])}</p>`;
  return div;
}

// ── Card interactions ──────────────────────────────────────────────────────

async function onCardClick(e) {
  // My Outreach sub-tab toggle (From All Leads / From Fresh Leads).
  const mineToggle = e.target.closest("[data-mineview]");
  if (mineToggle) {
    e.stopPropagation();
    state.mineView = mineToggle.dataset.mineview === "fresh" ? "fresh" : "all";
    renderContent();
    return;
  }

  // Newspaper date navigation. Handled here rather than with its own listener
  // because #content is rebuilt on every render and per-render listeners stack.
  const nav = e.target.closest("[data-np]");
  if (nav) {
    e.stopPropagation();
    const value = Number(nav.dataset.value);

    if (nav.dataset.np === "year") state.np = { year: value, month: null, day: null };
    else if (nav.dataset.np === "month") state.np = { ...state.np, month: value, day: null };
    else if (nav.dataset.np === "day") state.np = { ...state.np, day: value };
    else state.np = { year: null, month: null, day: null };   // "All dates"

    renderNewspaper();
    return;
  }

  // Expanding a company into its people — All Leads only.
  const expander = e.target.closest("[data-expand]");
  if (expander) {
    e.stopPropagation();
    const id = expander.dataset.expand;
    const box = $(`#contacts-${id}`);
    if (!box) return;

    const arrow = $(`[data-expand="${id}"].db-toggle`);
    const chip = $(`[data-expand="${id}"].contact-btn`);

    if (!box.hidden) {
      box.hidden = true;
      if (arrow) arrow.textContent = "\u25B8";
      if (chip) chip.classList.remove("is-open");
      return;
    }

    if (arrow) arrow.textContent = "\u25BE";
    if (chip) chip.classList.add("is-open");
    box.hidden = false;
    box.innerHTML = `<p class="muted" style="padding:10px 16px">Loading contacts…</p>`;

    try {
      const { contacts } = await api(`/api/leads/${id}/contacts`);
      box.innerHTML = contacts.length
        ? `<div class="contact-head">
             <span>Name</span><span>Position</span><span>Email</span>
             <span>Mobile</span><span>Second mobile</span><span>LinkedIn</span>
           </div>` +
          contacts
            .map(
              (c) => `<div class="contact-row">
                <span>${esc(c.name)}${c.is_primary ? ` <span class="poc-flag">Primary</span>` : ""}</span>
                <span>${esc(c.role || "—")}</span>
                <span>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : "—"}</span>
                <span>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : "—"}</span>
                <span>${c.phone2 ? `<a href="tel:${esc(c.phone2)}">${esc(c.phone2)}</a>` : "—"}</span>
                <span>${
                  c.linkedin
                    ? `<a href="${esc(c.linkedin)}" target="_blank" rel="noopener">Profile</a>`
                    : "—"
                }</span>
              </div>`
            )
            .join("")
        : `<p class="muted" style="padding:10px 16px">No contacts on file for this company yet.</p>`;
    } catch (err) {
      box.innerHTML = `<p class="muted" style="padding:10px 16px">${esc(err.message)}</p>`;
    }
    return;
  }

  const actionBtn = e.target.closest("[data-act]");
  if (actionBtn) {
    e.stopPropagation();
    const id = actionBtn.dataset.id;
    const act = actionBtn.dataset.act;

    if (act === "open") return openDrawer(id);

    try {
      if (act === "close" || act === "reopen") {
        await api(`/api/leads/${id}/close`, {
          method: "POST",
          body: { reopen: act === "reopen" },
        });
        toast(act === "reopen" ? "Reopened — clock restarted" : "Marked closed");
      } else {
        // Where it was claimed from decides the deadline: 10 days or 30.
        await api(`/api/leads/${id}/claim`, {
          method: "POST",
          body: {
            release: act === "release",
            source: actionBtn.dataset.source || (state.tab === "fresh" ? "fresh" : "all"),
          },
        });
        toast(
          act === "release"
            ? "Released"
            : `Claimed — ${actionBtn.dataset.source === "fresh" ? 10 : 30} days to close`
        );
      }
      refresh();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  // The stage dropdown updates inline via the delegated change listener
  // below — clicking or picking from it must never also open the drawer
  // sitting underneath it.
  if (e.target.closest(".stage-block")) return;

  // Rows in All Leads expand rather than open a drawer; everywhere else the
  // card opens the detail panel.
  if (state.tab === "all") return;
  const row = e.target.closest("[data-lead]");
  if (row) openDrawer(row.dataset.lead);
}

// ── Drawer ─────────────────────────────────────────────────────────────────

/** The firmographics panel — everything the CSV knew about the company. */
function companyInfoCard(lead) {
  const rows = [
    ["Founded", lead.founded],
    ["Location", companyLocation(lead)],
    ["Industry", lead.industry],
    ["Employees", lead.employees],
    ["Revenue", lead.revenue],
    ["Domain", lead.domain || lead.website],
  ].filter(([, v]) => v);

  if (!rows.length && !lead.linkedin) return "";

  return `
    <div class="company-info-card">
      ${rows
        .map(([k, v]) => `<div class="company-info-line"><span>${esc(k)}</span>${esc(v)}</div>`)
        .join("")}
      ${
        lead.linkedin
          ? `<div class="company-info-line"><span>LinkedIn</span>
               <a href="${esc(lead.linkedin)}" target="_blank" rel="noopener">Company page →</a></div>`
          : ""
      }
    </div>`;
}

function closeDrawer() {
  $("#drawer").hidden = true;
  $("#drawer-backdrop").hidden = true;
  state.openLeadId = null;
}

async function openDrawer(id) {
  state.openLeadId = id;
  const drawer = $("#drawer");
  drawer.hidden = false;
  $("#drawer-backdrop").hidden = false;
  drawer.innerHTML = `<div class="drawer-body"><div class="empty"><p>Loading…</p></div></div>`;

  let lead;
  try {
    ({ lead } = await api(`/api/leads/${id}`));
  } catch (err) {
    drawer.innerHTML = `<div class="drawer-body"><div class="empty"><h2>Couldn't open this lead</h2><p>${esc(err.message)}</p></div></div>`;
    return;
  }

  drawer.innerHTML = drawerHtml(lead);
  wireDrawer(lead);
}

/* ── Unclaimed Fresh Leads modal (admin only) ────────────────────────────── */

function closeUnclaimedModal() {
  $("#unclaimed-modal").hidden = true;
  $("#unclaimed-backdrop").hidden = true;
}

async function openUnclaimedModal() {
  if (!state.user || state.user.role !== "admin") return;

  const modal = $("#unclaimed-modal");
  modal.hidden = false;
  $("#unclaimed-backdrop").hidden = false;
  modal.innerHTML = `
    <div class="drawer-head">
      <h2>Unclaimed Fresh Leads</h2>
      <button class="drawer-close" id="unclaimed-close">&times;</button>
    </div>
    <div class="empty"><p>Loading…</p></div>`;
  $("#unclaimed-close").addEventListener("click", closeUnclaimedModal);

  let leads, windowDays;
  try {
    ({ leads, windowDays } = await api("/api/admin/unclaimed"));
  } catch (err) {
    modal.innerHTML = `
      <div class="drawer-head">
        <h2>Unclaimed Fresh Leads</h2>
        <button class="drawer-close" id="unclaimed-close">&times;</button>
      </div>
      <div class="empty"><h2>Couldn't load this</h2><p>${esc(err.message)}</p></div>`;
    $("#unclaimed-close").addEventListener("click", closeUnclaimedModal);
    return;
  }

  modal.innerHTML = `
    <div class="drawer-head">
      <h2>Unclaimed Fresh Leads</h2>
      <button class="drawer-close" id="unclaimed-close">&times;</button>
    </div>
    ${
      leads.length
        ? leads
            .map(
              (l) => `
        <div class="modal-row" data-open="${l.id}">
          <div class="modal-row-main">
            <strong>${esc(l.company)}</strong>
            <span>
              ${l.fresh_count} signal${l.fresh_count === 1 ? "" : "s"} in the last ${windowDays} days
              ${l.top_title ? ` · ${esc(String(l.top_title).slice(0, 70))}` : ""}
            </span>
          </div>
          <span class="muted">${esc(timeAgo(l.last_signal_at) || "")}</span>
        </div>`
            )
            .join("")
        : `<div class="modal-empty">Nothing sitting unclaimed right now — the team is keeping up.</div>`
    }`;

  $("#unclaimed-close").addEventListener("click", closeUnclaimedModal);
  modal.querySelectorAll("[data-open]").forEach((row) =>
    row.addEventListener("click", () => {
      closeUnclaimedModal();
      openDrawer(row.dataset.open);
    })
  );
}

function drawerHtml(lead) {
  const teamOptions = [`<option value="">Unclaimed</option>`]
    .concat(
      state.team.map(
        (u) =>
          `<option value="${u.id}" ${u.id === lead.owner_id ? "selected" : ""}>${esc(u.display_name)}</option>`
      )
    )
    .join("");

  const statusOptions = STATUSES.map(
    ([v, l]) => `<option value="${v}" ${v === lead.status ? "selected" : ""}>${esc(l)}</option>`
  ).join("");

  return `
  <div class="drawer-head">
    <button class="drawer-close" id="drawer-x" aria-label="Close">×</button>
    <h2>${esc(lead.company)}</h2>
    <p class="lead-meta">
      <span class="tag tag-${esc(lead.status)}">${esc(statusLabel(lead.status))}</span>
      <span class="sep">·</span>${lead.signals.length} signal${lead.signals.length === 1 ? "" : "s"}
      <span class="sep">·</span>last ${esc(timeAgo(lead.last_signal_at))}
      <span class="sep">·</span>score ${lead.score}
    </p>
  </div>

  <div class="drawer-body">

    ${
      // This clock and its buttons are the All Leads claim only — the same
      // company's Fresh Leads claim (if any) has its own owner and clock,
      // shown in My Outreach → From Fresh Leads, and isn't touched here.
      lead.owner_id
        ? `<div class="drawer-clock">
             ${lead.closed_at ? `<span class="clock clock-done">Closed</span>` : countdownChip(lead.countdown)}
             ${
               lead.closed_at
                 ? `<button class="btn btn-sm btn-ghost" data-act="reopen" data-source="all" data-id="${lead.id}">Reopen</button>`
                 : `<button class="btn btn-sm btn-primary" data-act="close" data-source="all" data-id="${lead.id}">Mark closed</button>`
             }
           </div>`
        : ""
    }
    ${
      lead.fresh_owner_id
        ? `<p class="muted" style="margin:-4px 0 12px">
             Also claimed on Fresh Leads by ${
               lead.fresh_owner_id === state.user.id ? "you" : esc(lead.fresh_owner_name || "someone else")
             } — separate claim, separate clock.
           </p>`
        : ""
    }

    ${
      lead.next_action
        ? `<div class="action-box tier-${lead.tier || 3}-box">
             <b>${esc(TIER_TEXT[lead.tier || 3][0])} · ${esc(TIER_TEXT[lead.tier || 3][1])}</b>
             ${esc(lead.next_action)}
           </div>`
        : ""
    }

    ${companyInfoCard(lead)}

    ${
      lead.pitch
        ? `<div class="pitch-box">
             <b>What to pitch</b>
             ${lead.angle ? `<span class="pitch-angle">${esc(lead.angle)}</span>` : ""}
             <span class="pitch-body">${esc(lead.pitch)}</span>

           </div>`
        : ""
    }

    <section class="block">
      <h3>Ownership</h3>
      <div class="grid-2">
        <label class="field"><span>Status</span><select id="d-status">${statusOptions}</select></label>
        <label class="field"><span>Owner</span><select id="d-owner">${teamOptions}</select></label>
        <label class="field"><span>Next follow-up</span>
          <input type="date" id="d-followup" value="${esc(dateOnly(lead.next_followup_at))}" /></label>
        <label class="field"><span>Last contacted</span>
          <input value="${esc(lead.last_contacted_at ? timeAgo(lead.last_contacted_at) : "Never")}" disabled /></label>
      </div>
    </section>

    <section class="block">
      <h3>People at ${esc(lead.company)}</h3>
      <div id="d-poc" class="poc-list"><p class="sig-sub">Loading the directory…</p></div>

      <h4 class="poc-sub">Working this lead through</h4>
      <div class="grid-2">
        <label class="field"><span>Name</span><input id="d-cname" value="${esc(lead.contact_name || "")}" placeholder="Priya Sharma" /></label>
        <label class="field"><span>Role</span><input id="d-crole" value="${esc(lead.contact_role || "")}" placeholder="Head of Marketing" /></label>
        <label class="field"><span>Email</span><input id="d-cemail" type="email" value="${esc(lead.contact_email || "")}" placeholder="priya@company.com" /></label>
        <label class="field"><span>Phone</span><input id="d-cphone" value="${esc(lead.contact_phone || "")}" placeholder="+91…" /></label>
      </div>
      <button class="btn btn-primary" id="d-save">Save changes</button>
      <button class="btn btn-ghost" id="d-add-poc">Add to directory</button>
    </section>

    <section class="block">
      <h3>Log outreach</h3>
      <div class="log-tabs" id="d-kinds">
        <button class="chip is-on" data-kind="note">Note</button>
        <button class="chip" data-kind="email">Email</button>
        <button class="chip" data-kind="call">Call</button>
        <button class="chip" data-kind="linkedin">LinkedIn</button>
        <button class="chip" data-kind="meeting">Meeting</button>
      </div>
      <label class="field">
        <textarea id="d-note" placeholder="What did you send, and what came back?"></textarea>
      </label>
      <div class="grid-2">
        <label class="field"><span>Set next follow-up</span><input type="date" id="d-nextdate" /></label>
        <div style="display:flex;align-items:flex-end">
          <button class="btn btn-primary btn-block" id="d-log">Log it</button>
        </div>
      </div>
    </section>

    <section class="block">
      <h3>Activity</h3>
      <div class="timeline" id="d-timeline">${timelineHtml(lead.activity)}</div>
    </section>

    <section class="block">
      <h3>Raw signals</h3>
      <div class="sig-list">
        ${
          lead.signals.length
            ? lead.signals
                .map(
                  (s) => `
          <div class="sig-card">
            <span class="type-tag type-${esc(segId(s.signal_type))}">${esc(typeLabel(s.signal_type))}</span>
            <p class="sig-title" style="margin-top:8px">
              <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || "Untitled article")}</a>
            </p>
            ${s.summary ? `<p class="sig-sub">${esc(s.summary)}</p>` : ""}
            ${s.why_it_matters ? `<p class="sig-why">${esc(s.why_it_matters)}</p>` : ""}
            <p class="feed-meta">${esc(s.site || "")}${s.author ? ` · ${esc(s.author)}` : ""} · ${esc(timeAgo(s.published || s.created_at))}</p>
          </div>`
                )
                .join("")
            : `<p class="sig-sub">No articles stored for this company yet.</p>`
        }
      </div>
    </section>
  </div>`;
}

function timelineHtml(activity) {
  if (!activity || !activity.length)
    return `<p class="sig-sub">Nothing logged yet. The first note goes here.</p>`;

  return activity
    .map(
      (a) => `
    <div class="tl-item">
      <span class="tl-kind">${esc(KIND_ICON[a.kind] || "•")}</span>
      <div class="tl-body">
        <p>${esc(a.body)}</p>
        <p class="tl-meta">${esc(a.user_name || "Someone")} · ${esc(a.kind)} · ${esc(timeAgo(a.created_at))}</p>
      </div>
    </div>`
    )
    .join("");
}

/** Pull every known POC for this company out of Supabase. */
async function loadContacts(lead) {
  const box = $("#d-poc");
  if (!box) return;

  let data;
  try {
    data = await api(`/api/contacts?company=${encodeURIComponent(lead.company)}`);
  } catch (err) {
    box.innerHTML = `<p class="sig-sub">${esc(err.message)}</p>`;
    return;
  }

  if (!data.contacts.length) {
    box.innerHTML = `<p class="sig-sub">Nobody on file for ${esc(lead.company)} yet. Fill the fields below and hit “Add to directory”.</p>`;
    return;
  }

  box.innerHTML = data.contacts
    .map(
      (c, i) => `
    <div class="poc-card">
      <p class="poc-name">
        ${esc(c.name)}${c.is_primary ? `<span class="poc-flag">Primary</span>` : ""}
      </p>
      ${c.role ? `<p class="poc-role">${esc(c.role)}</p>` : ""}
      <p class="poc-reach">
        ${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ""}
        ${c.email && c.phone ? `<span class="sep">·</span>` : ""}
        ${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ""}
        ${c.phone && c.phone2 ? `<span class="sep">·</span>` : ""}
        ${c.phone2 ? `<a href="tel:${esc(c.phone2)}">${esc(c.phone2)}</a>` : ""}
      </p>
      <button class="chip" data-use="${i}">Use this contact</button>
    </div>`
    )
    .join("");

  box.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-use]");
    if (!btn) return;
    const c = data.contacts[Number(btn.dataset.use)];
    $("#d-cname").value = c.name || "";
    $("#d-crole").value = c.role || "";
    $("#d-cemail").value = c.email || "";
    $("#d-cphone").value = c.phone || "";
    toast(`${c.name} loaded — hit Save changes to lock it in.`);
  });
}

function wireDrawer(lead) {
  $("#drawer-x").addEventListener("click", closeDrawer);
  loadContacts(lead);

  $("#d-add-poc").addEventListener("click", async () => {
    const name = $("#d-cname").value.trim();
    if (!name) return toast("Type a name first.", true);
    try {
      await api("/api/contacts", {
        method: "POST",
        body: {
          company: lead.company,
          name,
          role: $("#d-crole").value,
          email: $("#d-cemail").value,
          phone: $("#d-cphone").value,
        },
      });
      toast("Added to the directory");
      loadContacts(lead);
    } catch (err) { toast(err.message, true); }
  });

  let kind = "note";
  $("#d-kinds").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    kind = chip.dataset.kind;
    $$("#d-kinds .chip").forEach((c) => c.classList.toggle("is-on", c === chip));
  });

  $("#d-save").addEventListener("click", async () => {
    try {
      await api(`/api/leads/${lead.id}`, {
        method: "PATCH",
        body: {
          status: $("#d-status").value,
          owner_id: $("#d-owner").value ? Number($("#d-owner").value) : null,
          next_followup_at: $("#d-followup").value || null,
          contact_name: $("#d-cname").value,
          contact_role: $("#d-crole").value,
          contact_email: $("#d-cemail").value,
          contact_phone: $("#d-cphone").value,
        },
      });
      toast("Saved");
      await openDrawer(lead.id);
      loadStats();
    } catch (err) { toast(err.message, true); }
  });

  $("#d-log").addEventListener("click", async () => {
    const body = $("#d-note").value.trim();
    if (!body) return toast("Write something before logging it.", true);
    try {
      await api(`/api/leads/${lead.id}/activity`, {
        method: "POST",
        body: { kind, body, next_followup_at: $("#d-nextdate").value || undefined },
      });
      toast("Logged");
      await openDrawer(lead.id);
      refresh();
    } catch (err) { toast(err.message, true); }
  });
}

// ── Admin ──────────────────────────────────────────────────────────────────

async function renderAdmin() {
  const content = $("#content");
  content.innerHTML = `<div class="empty"><p>Loading…</p></div>`;

  let companies, sites, users, runs, topics, discovered;
  try {
    [{ companies }, { sites }, { users }, runs, { topics }, discovered] = await Promise.all([
      api("/api/admin/companies"),
      api("/api/admin/sites"),
      api("/api/admin/users"),
      api("/api/admin/runs"),
      api("/api/admin/topics"),
      api("/api/admin/discoveries").catch(() => ({ companies: [] })),
    ]);
  } catch (err) {
    content.innerHTML = `<div class="empty"><h2>Admin unavailable</h2><p>${esc(err.message)}</p></div>`;
    return;
  }

  const activeTopics = topics.filter((t) => t.active).length;

  content.innerHTML = `
    <div id="admin-root">
    ${
      discovered && discovered.companies.length
        ? `<div class="admin-block" style="margin-bottom:16px">
             <h3>Discovered companies <span class="pill">${discovered.companies.length}</span></h3>
             <p class="hint">
               The sweep found these in the news. They're already visible in Fresh Leads and can be
               claimed. Approving one adds it to the watchlist so it gets scanned every cycle.
               Rejecting hides it for good.
             </p>
             <div class="rows" style="margin-top:12px">
               ${discovered.companies
                 .map(
                   (c) => `<div class="row">
                     <div class="row-main">
                       <strong>${esc(c.name)}</strong>
                       <span>${c.signal_count} signal${c.signal_count === 1 ? "" : "s"}${
                         c.top_title ? ` · ${esc(String(c.top_title).slice(0, 80))}` : ""
                       }</span>
                     </div>
                     <div class="row-actions">
                       <span class="score ${scoreClass(c.top_score || 0)}" style="margin-right:8px">${c.top_score || 0}</span>
                       <button class="btn btn-sm btn-primary" data-approve="${c.id}">Approve</button>
                       <button class="btn btn-sm btn-danger" data-reject="${c.id}">Reject</button>
                     </div>
                   </div>`
                 )
                 .join("")}
             </div>
           </div>`
        : ""
    }
    <div class="admin-block" style="margin-bottom:16px">
      <h3>AI enrichment</h3>
      <p class="hint">
        Gemini writes the summary, the company-specific pitch, and finds companies for
        Today's Leads. Without it the portal still works, but pitches stay generic.
      </p>
      <div class="inline-form">
        <button class="btn" id="gemini-check">Test the connection</button>
      </div>
      <div id="gemini-result"></div>
    </div>

    <div class="admin-block" style="margin-bottom:16px">
      <h3>Import your contact sheet</h3>
      <p class="hint">
        Export the sheet as CSV and drop it here. Every <strong>Company name</strong> becomes a
        lead in All Leads, and every person on that row is filed against it as a POC.
        Re-uploading is safe — it adds what's new and tops up what's already there.
      </p>
      <div class="inline-form">
        <input type="file" id="csv-file" accept=".csv,text/csv" />
        <button class="btn btn-primary" id="csv-go">Upload</button>
      </div>
      <div id="csv-result"></div>
    </div>

    <div class="admin-block" style="margin-bottom:16px">
      <div class="runbar">
        <div>
          <h3>Collection cycle</h3>
          <p class="hint" id="run-hint">
            ${runs.queryCount} queries per cycle (${companies.filter((c) => c.active).length} companies ×
            ${sites.filter((s) => s.active).length} sources).
            Scheduled ${esc(state.schedule ? state.schedule.cron : "0 2,14 * * *")} (${esc(state.schedule ? state.schedule.timezone : "")}).
            ${runs.hasNewsKey ? "" : "<strong>NEWSAPI_AI_KEY is missing from .env.</strong>"}
            ${runs.hasGeminiKey ? "" : "Gemini key not set — signals will be classified by keyword only."}
          </p>
        </div>
        <button class="btn btn-primary" id="run-now" ${runs.running ? "disabled" : ""}>
          ${runs.running ? "Running…" : "Run a cycle now"}
        </button>
      </div>
      <div id="run-progress"></div>
      <table class="mini" style="margin-top:14px">
        <thead><tr><th>Started</th><th>Trigger</th><th>Fetched</th><th>New</th><th>Errors</th><th>Status</th></tr></thead>
        <tbody>
          ${
            runs.runs.length
              ? runs.runs
                  .map(
                    (r) => `<tr>
                      <td>${esc(timeAgo(r.started_at))}</td>
                      <td>${esc(r.trigger)}</td>
                      <td>${r.fetched}</td>
                      <td>${r.new_signals}</td>
                      <td>${r.errors}</td>
                      <td>${esc(r.status)}${r.message ? ` — ${esc(r.message)}` : ""}</td>
                    </tr>`
                  )
                  .join("")
              : `<tr><td colspan="6">No cycles have run yet.</td></tr>`
          }
        </tbody>
      </table>
    </div>

    <div class="admin-grid">

      <section class="admin-block">
        <h3>Companies watched</h3>
        <p class="hint">Every company here becomes a lead. Add name variants so nothing is missed.</p>
        <div class="row-list">
          ${companies
            .map(
              (c) => `<div class="row ${c.active ? "" : "is-off"}">
                <div class="row-main">
                  <strong>${esc(c.name)}</strong>
                  <span>${esc(c.keywords.join(", "))} · ${c.signal_count || 0} signals</span>
                </div>
                <div class="row-actions">
                  <button class="btn btn-sm" data-co-toggle="${c.id}" data-active="${c.active ? 0 : 1}">${c.active ? "Pause" : "Resume"}</button>
                  <button class="btn btn-sm btn-danger" data-co-del="${c.id}" data-name="${esc(c.name)}">Remove</button>
                </div>
              </div>`
            )
            .join("")}
        </div>
        <div class="inline-form">
          <input id="co-name" placeholder="Company name" />
          <input id="co-keys" placeholder="Name variants, comma separated" />
          <button class="btn btn-primary" id="co-add">Add</button>
        </div>
      </section>

      <section class="admin-block">
        <h3>News sources</h3>
        <p class="hint">Domains queried for every company on the watchlist.</p>
        <div class="row-list">
          ${sites
            .map(
              (s) => `<div class="row ${s.active ? "" : "is-off"}">
                <div class="row-main"><strong>${esc(s.domain)}</strong><span>${esc(s.name)}</span></div>
                <div class="row-actions">
                  <button class="btn btn-sm" data-site-toggle="${s.id}" data-active="${s.active ? 0 : 1}">${s.active ? "Pause" : "Resume"}</button>
                  <button class="btn btn-sm btn-danger" data-site-del="${s.id}" data-name="${esc(s.domain)}">Remove</button>
                </div>
              </div>`
            )
            .join("")}
        </div>
        <div class="inline-form">
          <input id="site-domain" placeholder="livemint.com" />
          <button class="btn btn-primary" id="site-add">Add</button>
        </div>
      </section>

      <section class="admin-block">
        <h3>Topic narrowing</h3>
        <p class="hint">
          ${activeTopics ? `${activeTopics} of ${topics.length} keywords active — an article must also mention one of them.`
                         : `Off. Every article mentioning a company is kept. Turn on to keep only business events.`}
        </p>
        <div class="row-actions">
          <button class="btn" id="topics-on">Require topic keywords</button>
          <button class="btn" id="topics-off">Keep everything</button>
        </div>
      </section>

      <section class="admin-block">
        <h3>Team</h3>
        <p class="hint">Members can work leads. Admins can also change the watchlist.</p>
        <div class="row-list">
          ${users
            .map(
              (u) => `<div class="row ${u.active ? "" : "is-off"}">
                <div class="row-main"><strong>${esc(u.display_name)}</strong><span>@${esc(u.username)} · ${esc(u.role)}</span></div>
                <div class="row-actions">
                  ${
                    u.id === state.user.id
                      ? `<span class="sig-sub">you</span>`
                      : `<button class="btn btn-sm" data-user-toggle="${u.id}" data-active="${u.active ? 0 : 1}">${u.active ? "Deactivate" : "Reactivate"}</button>`
                  }
                </div>
              </div>`
            )
            .join("")}
        </div>
        <div class="inline-form">
          <input id="u-name" placeholder="Display name" />
          <input id="u-user" placeholder="username" />
          <input id="u-pass" type="password" placeholder="password" />
          <select id="u-role"><option value="member">Member</option><option value="admin">Admin</option></select>
          <button class="btn btn-primary" id="u-add">Add teammate</button>
        </div>
      </section>
    </div>
    </div>`;

  wireAdmin();
  if (runs.running) pollRun();
}

function wireAdmin() {
  const root = $("#admin-root");

  const reload = () => { renderAdmin(); loadStats(); };
  const guard = async (fn) => {
    try { await fn(); reload(); }
    catch (err) { toast(err.message, true); }
  };

  $("#run-now").addEventListener("click", async () => {
    try {
      await api("/api/admin/run", { method: "POST" });
      toast("Cycle started");
      $("#run-now").disabled = true;
      $("#run-now").textContent = "Running…";
      pollRun();
    } catch (err) { toast(err.message, true); }
  });

  $("#co-add").addEventListener("click", () =>
    guard(async () => {
      const name = $("#co-name").value.trim();
      if (!name) throw new Error("Give the company a name.");
      const keywords = $("#co-keys").value.trim();
      await api("/api/admin/companies", {
        method: "POST",
        body: { name, keywords: keywords || name },
      });
      toast(`${name} added to the watchlist`);
    })
  );

  $("#site-add").addEventListener("click", () =>
    guard(async () => {
      const domain = $("#site-domain").value.trim();
      if (!domain) throw new Error("Enter a domain, like livemint.com.");
      await api("/api/admin/sites", { method: "POST", body: { domain } });
      toast(`${domain} added`);
    })
  );

  $("#u-add").addEventListener("click", () =>
    guard(async () => {
      await api("/api/admin/users", {
        method: "POST",
        body: {
          display_name: $("#u-name").value.trim(),
          username: $("#u-user").value.trim(),
          password: $("#u-pass").value,
          role: $("#u-role").value,
        },
      });
      toast("Teammate added");
    })
  );

  $("#topics-on").addEventListener("click", () =>
    guard(() => api("/api/admin/topics/toggle-all", { method: "POST", body: { active: true } }))
  );
  $("#topics-off").addEventListener("click", () =>
    guard(() => api("/api/admin/topics/toggle-all", { method: "POST", body: { active: false } }))
  );

  root.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;

    if (btn.id === "gemini-check") {
      const out = $("#gemini-result");
      out.innerHTML = `<p class="hint" style="margin-top:10px">Sending a test prompt…</p>`;
      try {
        const r = await api("/api/admin/gemini-check");
        out.innerHTML = r.ok
          ? `<p class="hint" style="margin-top:10px"><strong style="color:var(--teal)">Working.</strong>
               ${esc(r.model)} answered. Pitches will be written for each company.<br>
               <span style="font-family:var(--mono);font-size:11px">Key in use: ${esc(r.key || "—")}</span></p>`
          : `<p class="hint" style="margin-top:10px"><strong>Not working.</strong> ${esc(r.reason)}<br>
               <span style="font-family:var(--mono);font-size:11px">Model: ${esc(r.model || "—")} · Key in use: ${esc(r.key || "not set")}</span></p>`;
      } catch (err) {
        out.innerHTML = `<p class="hint" style="margin-top:10px"><strong>${esc(err.message)}</strong></p>`;
      }
      return;
    }

    if (btn.id === "csv-go") {
      const input = $("#csv-file");
      const file = input.files && input.files[0];
      const out = $("#csv-result");
      if (!file) return toast("Pick a CSV file first.", true);

      out.innerHTML = `<p class="hint" style="margin-top:12px">Reading ${esc(file.name)}…</p>`;
      try {
        const csv = await file.text();
        const r = await api("/api/admin/import", { method: "POST", body: { csv } });
        out.innerHTML = `<p class="hint" style="margin-top:12px">
          <strong style="color:var(--teal)">Done.</strong>
          ${r.companies} compan${r.companies === 1 ? "y" : "ies"} (${r.companiesAdded} new),
          ${r.contacts} contact${r.contacts === 1 ? "" : "s"} (${r.contactsAdded} new)${
            r.skipped ? `, ${r.skipped} row${r.skipped === 1 ? "" : "s"} skipped with no company name` : ""
          }.
        </p>`;
        toast("Contact sheet imported");
        input.value = "";
        loadStats();
      } catch (err) {
        out.innerHTML = `<p class="hint" style="margin-top:12px"><strong>${esc(err.message)}</strong></p>`;
      }
      return;
    }

    if (btn.dataset.approve)
      return guard(() =>
        api(`/api/admin/discoveries/${btn.dataset.approve}/approve`, { method: "POST" })
      );

    if (btn.dataset.reject)
      return guard(() =>
        api(`/api/admin/discoveries/${btn.dataset.reject}/reject`, { method: "POST" })
      );

    if (btn.dataset.coToggle)
      return guard(() =>
        api(`/api/admin/companies/${btn.dataset.coToggle}`, {
          method: "PATCH",
          body: { active: btn.dataset.active === "1" },
        })
      );

    if (btn.dataset.coDel) {
      if (!confirm(`Remove ${btn.dataset.name}? Its signals and outreach history go too.`)) return;
      return guard(() => api(`/api/admin/companies/${btn.dataset.coDel}`, { method: "DELETE" }));
    }

    if (btn.dataset.siteToggle)
      return guard(() =>
        api(`/api/admin/sites/${btn.dataset.siteToggle}`, {
          method: "PATCH",
          body: { active: btn.dataset.active === "1" },
        })
      );

    if (btn.dataset.siteDel) {
      if (!confirm(`Stop watching ${btn.dataset.name}?`)) return;
      return guard(() => api(`/api/admin/sites/${btn.dataset.siteDel}`, { method: "DELETE" }));
    }

    if (btn.dataset.userToggle) {
      const activating = btn.dataset.active === "1";
      return guard(async () => {
        const r = await api(`/api/admin/users/${btn.dataset.userToggle}`, {
          method: "PATCH",
          body: { active: activating },
        });
        if (!activating && r.released) {
          toast(`Deactivated — ${r.released} lead${r.released === 1 ? "" : "s"} released back to the pool`);
        } else {
          toast(activating ? "Reactivated" : "Deactivated");
        }
      });
    }
  });
}

function pollRun() {
  clearInterval(state.runPoll);
  state.runPoll = setInterval(async () => {
    let data;
    try { data = await api("/api/admin/runs"); }
    catch { return clearInterval(state.runPoll); }

    const box = $("#run-progress");
    if (!box) return clearInterval(state.runPoll);

    if (data.running && data.current) {
      const c = data.current;
      const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
      box.innerHTML = `
        <p class="hint" style="margin:12px 0 0">
          ${c.done} of ${c.total} queries · ${c.fetched} articles fetched · ${c.errors} errors
        </p>
        <div class="progress"><div style="width:${pct}%"></div></div>`;
    } else {
      clearInterval(state.runPoll);
      toast("Cycle finished");
      renderAdmin();
      loadStats();
    }
  }, 2000);
}