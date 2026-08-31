/* =========================================================================
   Curious Media — Lead Intelligence (frontend)
   No build step: plain ES modules-free JS so `npm start` is the only command.
   ========================================================================= */

// ── Helpers ────────────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape anything user- or news-supplied before it goes into innerHTML. */
/**
 * The Owner column is narrow, so a release reason shows its first few words
 * and opens in full on click. Cutting at a word boundary rather than mid-word
 * keeps it readable, and "more" says there IS more — an ellipsis alone doesn't
 * tell you whether one word was dropped or twenty.
 */
function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function firstWords(text, n) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, n).join(" ");
}

function showNotePopover(anchor, text) {
  document.querySelectorAll(".note-pop").forEach((p) => p.remove());

  const pop = document.createElement("div");
  pop.className = "note-pop";
  pop.innerHTML = `
    <span class="mono-label">Why it was released</span>
    <p>${esc(text)}</p>`;
  document.body.appendChild(pop);

  const box = anchor.getBoundingClientRect();
  const top = box.bottom + window.scrollY + 6;
  const left = Math.max(
    12,
    Math.min(box.left + window.scrollX, window.innerWidth - pop.offsetWidth - 12)
  );
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;

  setTimeout(() => {
    document.addEventListener(
      "click",
      function close(e) {
        if (pop.contains(e.target)) return;
        pop.remove();
        document.removeEventListener("click", close);
      },
      { once: false }
    );
  }, 0);
}

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Every request the page makes. Throws with the server's message on failure. */
/**
 * Replace the page without losing what someone is typing.
 *
 * Every search keystroke re-renders all of #content, which destroys the search
 * box and builds a new one. Three things went wrong with that:
 *
 *  - The new box was filled from state.search — the value as it was when the
 *    debounce fired. Anything typed while the request was in flight was wiped,
 *    so typing at a normal speed dropped characters.
 *  - The caret was forced to the end, so correcting a typo in the middle of a
 *    word was impossible — one keystroke and you were back at the end.
 *  - Nothing stopped an older, slower response from landing after a newer one
 *    and painting stale results.
 *
 * This carries the live value and caret across the swap, and the sequence
 * guard below deals with the third.
 */
function swapContent(el, html, keepFocus) {
  const live = keepFocus ? document.getElementById(keepFocus) : null;
  const value = live ? live.value : null;
  const start = live ? live.selectionStart : null;
  const end = live ? live.selectionEnd : null;

  el.innerHTML = html;

  if (!keepFocus) return;
  const fresh = document.getElementById(keepFocus);
  if (!fresh) return;

  // What is on screen wins over what the last render knew about.
  if (value != null && fresh.value !== value) fresh.value = value;
  fresh.focus();
  if (start != null) {
    try { fresh.setSelectionRange(start, end); } catch { /* not a text input */ }
  }
}

/**
 * Which list request is the current one.
 *
 * Bumped before every fetch; a response whose number no longer matches has
 * been overtaken and is dropped. Without this, typing "zepto" quickly could
 * end up showing the results for "zep" because that request happened to
 * finish last.
 */
let listSeq = 0;

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

  if (!res.ok) {
    // A 413 from the hosting platform never carries a JSON body, so without
    // this it surfaces as a bare "Request failed (413)" with no clue what to
    // do. Say what it means in words.
    if (res.status === 413 && !(data && data.error)) {
      throw new Error(
        "That file is too big to send in one go. If this was an import, refresh " +
          "the page and try again — large sheets are meant to upload in parts."
      );
    }
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
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
  // Which half of Fresh Leads is showing: "company" (already in All Leads,
  // synced every 3 days) or "new" (discovered, synced daily, not in All Leads
  // until an admin approves it).
  freshView: "company",
  freshCounts: { company: 0, new: 0 },
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
  alertPoll: null,
  alerts: { expiring: [], myPendingRequests: 0, pendingReview: 0 },
  outreachAlerts: [],
  outreachUnseen: 0,
  reviewQueue: [],
  // Last completed sync per cadence — the two lists move on different clocks,
  // so one "last synced" line would be wrong for one of them.
  lastRunCompany: null,
  lastRunNew: null,
  freshWindowDays: 3,
  pageSize: 50,
  hasMore: false,
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

  // Fire the roster alongside the dashboard rather than before it - on a
  // remote database each sequential request is a fresh round trip of latency.
  const team = api("/api/admin/users")
    .then(({ users }) => { state.team = users.filter((u) => u.active); })
    .catch(() => { state.team = []; });

  await Promise.all([team, refresh()]);

  loadAlerts();
  clearInterval(state.alertPoll);
  state.alertPoll = setInterval(loadAlerts, 60000);
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

    // One character matches most of the database and the result is useless, so
    // wait for a second one. Clearing the box still resets immediately.
    if (v.length === 1) return;

    searchTimer = setTimeout(() => {
      if (v === state.search) return;   // nothing actually changed
      state.search = v;
      state.pageSize = 50;
      renderContent({ keepFocus: "f-search" });
    }, 300);
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
  $("#contact-editor-backdrop").addEventListener("click", closeContactEditor);
  $("#modal-backdrop").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer();
    if (e.key === "Escape" && !$("#contact-editor").hidden) closeContactEditor();
    if (e.key === "Escape" && !$("#modal-box").hidden) closeModal();
  });

  $("#bell-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const panel = $("#bell-panel");
    if (!panel.hidden) { panel.hidden = true; return; }

    renderBellPanel();
    panel.hidden = false;

    // Opening the bell IS reading it. Marking read here rather than behind a
    // separate "mark all read" button means one less thing to explain, and
    // there is nothing in the panel they could have missed by opening it.
    $("#bell-dot").hidden = true;
    state.outreachUnseen = 0;
    try {
      await api("/api/outreach/alerts/seen", { method: "POST" });
    } catch {
      // If the stamp fails the dot simply comes back on the next poll.
    }
  });
  document.addEventListener("click", (e) => {
    const panel = $("#bell-panel");
    if (!panel || panel.hidden) return;
    if (!panel.contains(e.target) && e.target.id !== "bell-btn") panel.hidden = true;
  });
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
    // The stat strip is gone — the numbers that mattered are on the tabs and
    // inside Admin now, so nothing here writes to a card any more.
    //
    // One pill per tab.
    for (const [tab, value] of [
      ["all", data.totals.leads],
      ["fresh", data.totals.fresh],
      ["mine", data.totals.mine],
      ["newspaper", data.totals.newspaper],
    ]) {
      const pill = $(`[data-count="${tab}"]`);
      if (pill) pill.textContent = value;
    }
    state.freshCounts = {
      company: (data.totals && data.totals.freshCompany) || 0,
      new: (data.totals && data.totals.freshNew) || 0,
    };
    state.freshWindowDays = (data.schedule && data.schedule.freshWindowDays) || 3;
    state.schedule = data.schedule;
    state.run = data.run;
    state.lastRun = data.run.last;
    state.lastRunCompany = data.run.lastCompany || null;
    state.lastRunNew = data.run.lastNew || null;
    if (data.run.running && !state.scanning) { state.scanning = true; pollRun(); }
  } catch (err) {
    if (err.status === 401) location.reload();
  }
}

function currentQuery() {
  const p = new URLSearchParams();
  p.set("tab", state.tab);
  if (state.tab === "fresh") p.set("freshKind", state.freshView === "new" ? "new" : "company");
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
    "News from the last 3 days only. Claim one and you have 10 days — and the company's contacts come with it.",
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

/**
 * Which sync cadence the page in front of you is fed by.
 *
 * Company Leads comes off the watchlist sweep, every 3 days. New Leads comes
 * off the discovery sweep, daily. Everywhere else reads whichever ran last,
 * because those views aren't tied to one sweep.
 */
function syncInfo() {
  if (state.tab === "fresh" && state.freshView === "new") {
    return { run: state.lastRunNew, everyDays: 1, label: "New Leads", mode: "new" };
  }
  if (state.tab === "fresh") {
    return { run: state.lastRunCompany, everyDays: 3, label: "Company Leads", mode: "company" };
  }
  return { run: state.lastRun, everyDays: 3, label: null, mode: "company" };
}

function actionBar() {
  const [title, desc] = PAGE_COPY[state.tab] || ["Leads", ""];
  const { run, everyDays, label, mode } = syncInfo();
  const cadence = everyDays === 1 ? "daily" : `every ${everyDays} days`;

  return `
    <div class="action-bar">
      <div class="action-bar-left">
        <h1 class="page-title">${esc(title)}</h1>
        ${desc ? `<p class="page-desc">${esc(desc)}</p>` : ""}
        <p class="scan-status">
          <span class="scan-dot"></span>
          ${
            run && run.finished_at
              ? `${label ? esc(label) + " l" : "L"}ast synced ${esc(
                  timeAgo(run.finished_at)
                )} · syncs ${cadence}`
              : `${label ? esc(label) + " n" : "N"}ot synced yet · syncs ${cadence}`
          }
        </p>
      </div>
      ${
        state.user.role === "admin"
          ? `<div class="action-bar-right">
               ${
                 state.tab === "all"
                   ? `<input type="file" id="ab-csv" accept=".csv,text/csv" class="upload-input" />
                      <button class="btn btn-primary" id="ab-new-lead">+ New Lead</button>`
                   : ""
               }
               <div class="action-bar-stack">
                 ${
                   state.tab === "all"
                     ? `<button class="btn" id="ab-upload">Import contacts (CSV)</button>`
                     : ""
                 }
                 <button class="btn btn-primary" id="ab-scan" data-mode="${mode}" ${
                   state.scanning ? "disabled" : ""
                 }>
                   ${
                     state.scanning
                       ? "Syncing…"
                       : label
                       ? `Sync ${esc(label)}`
                       : "Sync"
                   }
                 </button>
               </div>
             </div>`
          : ""
      }
    </div>`;
}

/**
 * The two halves of Fresh Leads.
 *
 * Company Leads is news about companies already in All Leads. New Leads is
 * everything else the discovery sweep turned up — claimable here, but not in
 * the contact database and not going there without an admin approving it.
 */
function freshSubtabs() {
  const view = state.freshView === "new" ? "new" : "company";
  return `
    <div class="mine-subtabs">
      <button class="chip ${view === "company" ? "is-on" : ""}" data-freshview="company">
        Company Leads <span class="pill">${state.freshCounts.company || 0}</span>
      </button>
      <button class="chip ${view === "new" ? "is-on" : ""}" data-freshview="new">
        New Leads <span class="pill">${state.freshCounts.new || 0}</span>
      </button>
      <span class="subtab-note">
        ${
          view === "new"
            ? "Companies the sweep found that aren't in All Leads. Synced daily. Claim freely — nothing here joins All Leads until an admin approves it."
            : "News about companies already in All Leads. Synced every 3 days."
        }
      </span>
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
             placeholder="Search company, person, email or industry…" value="${esc(state.search)}" />

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
  // All Leads is the people table now — one row per contact, not per company.
  if (state.tab === "all") return renderPeople(opts);
  // My Outreach is its own module now — see outreach.js. It is no longer a
  // list of claims; it is a Today screen backed by opportunities, and it was
  // large enough to be worth keeping out of this file.
  //
  // renderMyPeople is kept below rather than deleted: All Leads still renders
  // contact rows through the same helpers, and the card is a useful reference
  // for the claim/release wiring the workspace reuses.
  if (state.tab === "mine") return renderOutreach();

  let leads;
  try {
    const seq = ++listSeq;
    ({ leads } = await api(`/api/leads?${currentQuery()}`));
    // A newer search went out while this one was in flight — its results are
    // the ones that match what's on screen, so drop these.
    if (seq !== listSeq) return;
  } catch (err) {
    content.innerHTML = `<div class="empty"><h2>Couldn't load leads</h2><p>${esc(err.message)}</p></div>`;
    return;
  }

  const body =
    state.tab === "fresh"
      ? freshSubtabs() +
        (leads.length
          ? `<div class="mylead-grid">${leads.map(freshCard).join("")}</div>`
          : emptyState().outerHTML)
      : !leads.length
      ? emptyState().outerHTML
      : state.tab === "newspaper"
      ? newspaperView(leads)
      : myOutreachView(leads);

  swapContent(content, actionBar() + filterBar() + body, opts.keepFocus);

  // Fresh Leads cards used to carry the company's contact list — who held
  // whom, and their last two log entries. That has moved to My Outreach, which
  // is where a person is actually worked; Fresh Leads is now purely the
  // company-and-signal view it reads as. The batch fetch is gone with it,
  // which also removes a request per render of this tab.

  if ($("#f-tier")) $("#f-tier").value = state.tier || "";
  if ($("#f-type")) $("#f-type").value = [...state.types][0] || "";
  if ($("#f-sort")) $("#f-sort").value = state.sort;

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

/**
 * All Leads: every column from the source sheet, in the sheet's own order, one
 * row per person. It scrolls sideways rather than hiding columns — this view
 * IS the database, and someone looking here wants the whole record.
 *
 * Two columns are folded into others rather than shown twice: the person's
 * LinkedIn (their name links to it) and the company website (the company name
 * links to it, founding year underneath).
 */
// A second email or phone stacks under the first rather than earning its own
// column, and the company domain is gone because the company name already
// links to the site. Claim is pinned to the right edge so it never scrolls
// out of reach.
/**
 * All Leads is the company database again: one row per company, expanding into
 * its people. A COMPANY isn't claimed — a person is, and only one person per
 * company per user, so nobody can sit on a whole account.
 */
async function renderPeople(opts = {}) {
  const content = $("#content");

  let leads;
  try {
    const p = new URLSearchParams();
    p.set("tab", "all");
    if (state.search) p.set("q", state.search);
    p.set("sort", state.sort === "added" ? "added" : "company");
    p.set("limit", String(state.pageSize));
    const res = await api(`/api/leads?${p}`);
    leads = res.leads;
    state.hasMore = Boolean(res.hasMore);
  } catch (err) {
    content.innerHTML = `<div class="empty"><h2>Couldn't load leads</h2><p>${esc(err.message)}</p></div>`;
    return;
  }

  const body = leads.length
    ? `<div class="db-table">
         <div class="db-head">
           <span></span><span>Company</span><span>Contacts</span><span>Industry</span>
           <span>Size</span><span>Revenue</span><span>LinkedIn</span>
         </div>
         ${leads.map(companyRow).join("")}
       </div>
       ${
         state.hasMore
           ? `<button class="btn btn-block" id="load-more">Show more companies</button>`
           : ""
       }`
    : emptyState().outerHTML;

  swapContent(content, actionBar() + filterBar() + body, opts.keepFocus);
  if ($("#f-sort")) $("#f-sort").value = state.sort;

  wireListActions();
}

function companyRow(lead) {
  const site = lead.website || (lead.domain ? `https://${lead.domain}` : null);

  return `
    <div class="db-row" data-lead="${lead.id}">
      <button class="db-toggle" data-expand="${lead.id}" aria-label="Show contacts">▸</button>

      <div class="db-company">
        ${
          site
            ? `<a class="company-name" href="${esc(site)}" target="_blank" rel="noopener">${esc(lead.company)}</a>`
            : `<span class="company-name">${esc(lead.company)}</span>`
        }
        ${lead.founded ? `<span class="company-meta">Founded ${esc(lead.founded)}</span>` : ""}
        ${
          !lead.owner_id && lead.release_note
            ? `<div class="release-note">Handed back: ${esc(lead.release_note)}</div>`
            : ""
        }
      </div>

      <div class="db-cell">
        ${
          Number(lead.contact_count) > 0
            ? `<button class="contact-btn" data-expand="${lead.id}">
                 ${lead.contact_count} contact${Number(lead.contact_count) === 1 ? "" : "s"}
               </button>`
            : `<span class="muted">None on file</span>`
        }
      </div>

      <div class="db-cell">${esc(lead.industry || "—")}</div>
      <div class="db-cell">${esc(lead.employees || "—")}</div>
      <div class="db-cell">${esc(lead.revenue || "—")}</div>

      <div class="db-cell">
        ${
          lead.linkedin
            ? `<a class="li-link" href="${esc(lead.linkedin)}" target="_blank" rel="noopener">${linkedinMark()}${esc(lead.company)}</a>`
            : `<span class="muted">—</span>`
        }
      </div>
    </div>
    <div class="db-contacts" id="contacts-${lead.id}" hidden></div>`;
}

/**
 * Column headings for the expanded contact table.
 *
 * The first column isn't data — it's the two things you do to a row (correct
 * it, vouch for it), pinned to the left edge. The last is Claim, pinned to the
 * right edge. Everything in between scrolls between them.
 *
 * City and State are one Location column now. They were two columns that were
 * each half a fact, and the sheet leaves State blank for Delhi and the union
 * territories, so one of them was empty on a good share of rows anyway.
 */
const CONTACT_COLUMNS = [
  "", "Name", "Position", "Work email", "Phone 1", "Phone 2",
  "Seniority", "Department", "Location", "Country", "Owner", "",
];

function contactHead() {
  // The last heading sits over the pinned Claim column, so it has to be
  // pinned too — otherwise the header's grey stops where that column starts
  // and the row underneath shows through as a seam.
  return `<div class="ct-head">${CONTACT_COLUMNS.map(
    (h, i) =>
      `<span class="${i === CONTACT_COLUMNS.length - 1 ? "ct-actions ct-actions-head" : ""}">${esc(h)}</span>`
  ).join("")}</div>`;
}

/** "City, State" — or whichever half the row actually has. */
function contactLocation(c) {
  return [c.city, c.state].filter(Boolean).join(", ");
}

/**
 * The verified badge — one flag for the whole team.
 *
 * Anyone can set it, because anyone can be the person who rang the number and
 * found it works. The point is that the next person doesn't repeat the call,
 * so it can't be a private note: it's stamped on the row and everybody sees
 * the same badge, with who vouched for it in the tooltip.
 */
function verifyChip(c) {
  const on = Boolean(c.verified);
  const who = c.verified_by_name ? `Verified by ${c.verified_by_name}` : "Verified";
  const when = c.verified_at ? ` · ${timeAgo(c.verified_at)}` : "";

  return `<span class="verify-wrap">
    <button class="verify-chip ${on ? "is-verified" : ""}"
                  data-verify="${c.id}" data-to="${on ? 0 : 1}"
                  title="${esc(on ? who + when + " — click to unverify" : "Not verified yet — click if you've checked these details")}">
      ${on ? tickMark() : circleMark()}
      <span>${on ? "Verified" : "Unverified"}</span>
    </button>
    ${on && c.verified_at ? `<span class="verify-date">${esc(shortDate(c.verified_at))}</span>` : ""}
  </span>`;
}

function tickMark() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" class="vmark">
      <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm-1.2 14.4L6.4 12l1.4-1.4 3 3 6-6L18.2 9l-7.4 7.4z"/>
    </svg>`;
}

function circleMark() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" class="vmark">
      <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 2a8 8 0 110 16 8 8 0 010-16z"/>
    </svg>`;
}

/**
 * One person inside an expanded company — this is what gets claimed.
 *
 * A row under proper headings, not labelled fragments. How the outreach is
 * GOING isn't here: that belongs to whoever holds the Fresh Lead.
 *
 * A contact swept up by a Fresh Leads company claim says so, because "why do I
 * suddenly own eleven people at Zepto" deserves an answer on the row itself.
 */
function contactRow(c) {
  const isAdmin = state.user.role === "admin";
  const isOwner = c.owner_id === state.user.id;
  const locked = Boolean(c.owner_id) && !isOwner && !isAdmin;
  const viaFresh = c.claim_source === "fresh";

  const cell = (v) => `<span>${v == null || v === "" ? "—" : v}</span>`;

  return `
    <div class="ct-row ${locked ? "is-locked" : ""} ${c.verified ? "is-verified" : ""}">
      <span class="ct-tools">
        <button class="icon-btn" data-edit-contact="${c.id}" title="Edit this contact">${pencil()}</button>
        ${verifyChip(c)}
      </span>

      <span class="ct-name">
        ${c.linkedin
          ? `<a href="${esc(c.linkedin)}" target="_blank" rel="noopener">${esc(c.name)}</a>`
          : esc(c.name)}
      </span>
      ${cell(esc(c.role))}
      ${cell(c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : "")}
      ${cell(c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : "")}
      ${cell(c.phone2 ? `<a href="tel:${esc(c.phone2)}">${esc(c.phone2)}</a>` : "")}
      ${cell(esc(c.seniority))}
      ${cell(esc(c.department))}
      ${cell(esc(contactLocation(c)))}
      ${cell(esc(c.country))}

      <span class="ct-owner ${!c.owner_id && c.release_note ? "cr-owner" : ""}">
        ${
          c.owner_id
            ? `<span class="owner"><span class="avatar">${esc(initials(c.owner_name))}</span>${esc(c.owner_name)}</span>
               ${viaFresh ? `<span class="via-fresh" title="Came with the Fresh Leads claim on this company">via Fresh</span>` : ""}`
            : `<span class="muted">Unclaimed</span>
               ${
                 c.release_note
                   ? `<button class="release-note-btn" data-note="${esc(c.release_note)}">
                        Released: ${esc(firstWords(c.release_note, 6))}${
                          wordCount(c.release_note) > 6 ? ` <span class="more">more</span>` : ""
                        }
                      </button>`
                   : ""
               }`
        }
      </span>

      <span class="ct-actions">
        <span class="ct-actions-col">
          ${
            isOwner
              ? `<button class="btn btn-sm" data-release-contact="${c.id}">Release</button>`
              : locked
              ? `<span class="lock-note">Locked</span>`
              : `<button class="btn btn-sm btn-primary" data-contact-act="claim" data-id="${c.id}">Claim</button>`
          }
          <!-- The Claim column is pinned and overflows visibly, so anything
               too wide for it paints on top of Owner instead of clipping.
               "Claimed 3 times before" was ~123px in a ~100px cell; the long
               form moves to the tooltip. -->
          <span class="claim-count" title="${
            Number(c.claim_count) > 0
              ? `Claimed ${c.claim_count} time${Number(c.claim_count) === 1 ? "" : "s"} before`
              : "Never claimed"
          }">${Number(c.claim_count) > 0 ? `Claimed ${c.claim_count}\u00D7` : "Never claimed"}</span>
        </span>
      </span>
    </div>`;
}

function linkedinMark() {
  return `<svg class="li-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.98 3.5a2.5 2.5 0 11-.02 5 2.5 2.5 0 01.02-5zM3 9h4v12H3zM10 9h3.8v1.7h.05c.53-.95 1.83-1.95 3.77-1.95 4.03 0 4.78 2.5 4.78 5.76V21h-4v-5.6c0-1.34-.03-3.06-1.9-3.06-1.9 0-2.2 1.45-2.2 2.96V21h-4z"/>
    </svg>`;
}

function pencil() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" class="pencil">
      <path d="M4 16.5V20h3.5l9.9-9.9-3.5-3.5L4 16.5zM19.7 6.3a1 1 0 000-1.4l-2.6-2.6a1 1 0 00-1.4 0l-1.8 1.8 3.5 3.5 2.3-1.3z"/>
    </svg>`;
}

/* ── Admin row editor ────────────────────────────────────────────────────── */

const EDIT_FIELDS = [
  ["name", "Name"],
  ["role", "Position"],
  ["email", "Work email"],
  ["phone", "Phone 1"],
  ["phone2", "Phone 2"],
  ["linkedin", "LinkedIn URL"],
  ["seniority", "Seniority"],
  ["department", "Department"],
  ["city", "City"],
  ["state", "State"],
  ["country", "Country"],
];

/**
 * Company fields, edited from the same dialog. These belong to the company, so
 * a correction here reaches every contact there — renaming the company moves
 * its people with it rather than orphaning them.
 */
const COMPANY_EDIT_FIELDS = [
  ["company", "Company name"],
  ["company_website", "Website"],
  ["company_linkedin", "Company LinkedIn"],
  ["company_domain", "Domain"],
  ["company_industry", "Industry"],
  ["company_employees", "Employees"],
  ["company_revenue", "Revenue"],
  ["company_founded", "Year founded"],
];

const FIELD_LABEL = Object.fromEntries(EDIT_FIELDS);

/**
 * What the sheet originally said, and every change since.
 *
 * Shown here rather than on its own screen because this is where someone is
 * about to change something — seeing that a colleague already corrected the
 * phone number last week is the thing that stops it being changed back.
 */
function historyPanel(history) {
  const { original, changes } = history || {};
  if (!original && (!changes || !changes.length)) return "";

  const shown = (changes || []).slice(0, 12);

  return `
    <div class="history-panel">
      <h3>Record history</h3>

      ${
        shown.length
          ? `<div class="history-list">
               ${shown
                 .map(
                   (c) => `
                 <div class="history-item">
                   <div class="history-meta">
                     ${esc(FIELD_LABEL[c.field] || c.field)} ·
                     ${esc(c.user_name || "Someone")} · ${esc(timeAgo(c.changed_at))}
                   </div>
                   <div class="history-diff">
                     <span class="was">${esc(c.old_value || "(empty)")}</span>
                     <span class="arrow">→</span>
                     <span class="now">${esc(c.new_value || "(empty)")}</span>
                   </div>
                 </div>`
                 )
                 .join("")}
               ${
                 changes.length > shown.length
                   ? `<p class="hint">${changes.length - shown.length} older change${
                       changes.length - shown.length === 1 ? "" : "s"
                     } not shown.</p>`
                   : ""
               }
             </div>`
          : `<p class="hint">Nothing has been changed since it was imported.</p>`
      }

      ${
        original
          ? `<details class="history-original">
               <summary>As originally imported${
                 original.imported_at ? ` · ${esc(shortDate(original.imported_at))}` : ""
               }</summary>
               <div class="history-original-body">
                 ${EDIT_FIELDS.map(([key, label]) =>
                   original[key]
                     ? `<div><span>${esc(label)}</span>${esc(original[key])}</div>`
                     : ""
                 ).join("")}
               </div>
             </details>`
          : ""
      }
    </div>`;
}

function closeContactEditor() {
  $("#contact-editor").hidden = true;
  $("#contact-editor-backdrop").hidden = true;
}

/**
 * Everyone reads the database; only an admin corrects it. A typo fixed here
 * stays fixed for the whole team, rather than each person keeping their own
 * private copy of the truth.
 */
async function openContactEditor(id) {
  let contact, history = { original: null, changes: [] };
  try {
    const [{ contacts }, hist] = await Promise.all([
      api("/api/contacts/people"),
      api(`/api/contacts/people/${id}/history`).catch(() => ({ original: null, changes: [] })),
    ]);
    contact = contacts.find((c) => String(c.id) === String(id));
    history = hist;
  } catch (err) {
    return toast(err.message, true);
  }
  if (!contact) return toast("That contact no longer exists.", true);

  const panel = $("#contact-editor");
  $("#contact-editor-backdrop").hidden = false;
  panel.hidden = false;

  panel.innerHTML = `
    <div class="drawer-head">
      <h2>Edit contact</h2>
      <button class="drawer-close" id="editor-close">&times;</button>
    </div>
    <div class="drawer-body">
      <div class="grid-2">
        ${EDIT_FIELDS.map(
          ([key, label]) => `
          <label class="field">
            <span>${esc(label)}</span>
            <input id="edit-${key}" value="${esc(contact[key] || "")}" />
          </label>`
        ).join("")}
      </div>

      <h3 class="editor-section">Company</h3>
      <div class="grid-2">
        ${COMPANY_EDIT_FIELDS.map(
          ([key, label]) => `
          <label class="field">
            <span>${esc(label)}</span>
            <input id="edit-${key}" value="${esc(
              key === "company" ? contact.company || "" : contact[key] || ""
            )}" />
          </label>`
        ).join("")}
      </div>

      <button class="btn btn-primary btn-block" id="editor-save">Save changes</button>

      ${historyPanel(history)}

      ${
        state.user.role === "admin"
          ? `<div class="editor-danger">
               <p class="hint">
                 Deleting removes this person from the database. The company and its
                 other contacts stay. This can't be undone.
               </p>
               <button class="btn btn-danger btn-sm" id="editor-delete">Delete contact</button>
             </div>`
          : ""
      }
    </div>`;

  $("#editor-close").addEventListener("click", closeContactEditor);

  $("#editor-save").addEventListener("click", async () => {
    const body = {};
    for (const [key] of [...EDIT_FIELDS, ...COMPANY_EDIT_FIELDS]) {
      const input = $(`#edit-${key}`);
      if (input) body[key] = input.value;
    }

    try {
      await api(`/api/contacts/people/${id}`, { method: "PATCH", body });
      toast("Contact updated");
      closeContactEditor();
      renderContent();
    } catch (err) {
      toast(err.message, true);
    }
  });

  const deleteBtn = $("#editor-delete");
  if (deleteBtn) deleteBtn.addEventListener("click", async () => {
    if (!window.confirm(`Delete ${contact.name}? This can't be undone.`)) return;
    try {
      await api(`/api/contacts/people/${id}`, { method: "DELETE" });
      toast("Contact deleted");
      closeContactEditor();
      renderContent();
      loadStats();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function pencil() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" class="pencil">
      <path d="M4 16.5V20h3.5l9.9-9.9-3.5-3.5L4 16.5zM19.7 6.3a1 1 0 000-1.4l-2.6-2.6a1 1 0 00-1.4 0l-1.8 1.8 3.5 3.5 2.3-1.3z"/>
    </svg>`;
}



/* ── My Outreach ────────────────────────────────────────────────────────── */

const stageLabel = (v) => (STATUSES.find((x) => x[0] === (v || "new")) || ["new", "New"])[1];

const KIND_LABEL = { call: "Call", email: "Email", linkedin: "LinkedIn", meeting: "Meeting", note: "Note" };

/**
 * Both halves stacked: people claimed in All Leads, companies claimed in Fresh
 * Leads. They were sub-tabs once, which let a count of 2 sit over an empty
 * page because the claims were in the tab nobody clicked. Nothing hides now.
 */
/**
 * The four numbers, shown only above My Outreach.
 *
 * They're all about your own workload — what's yours, what's nearly out of
 * time, what you've closed — so they belong on your page and nowhere else.
 */
function outreachSlabs(contacts, leads) {
  const soon = [...contacts, ...leads].filter(
    (x) => x.countdown && !x.countdown.overdue && x.countdown.days <= 3
  ).length;
  const overdue = [...contacts, ...leads].filter((x) => x.countdown && x.countdown.overdue).length;
  const closed = [...contacts, ...leads].filter((x) => x.closed_at || x.fresh_closed_at).length;

  const slab = (label, value, note, tone) => `
    <div class="stat ${tone && value > 0 ? tone : ""}">
      <p class="stat-label">${esc(label)}</p>
      <p class="stat-value">${value}</p>
      <p class="stat-note">${esc(note)}</p>
    </div>`;

  return `
    <div class="stats">
      ${slab("Open right now", contacts.length + leads.length - closed, "claimed and not closed")}
      ${slab("Due within 3 days", soon, "act on these first", "is-urgent")}
      ${slab("Overdue", overdue, overdue ? "past the deadline" : "nothing late", "is-late")}
      ${slab("Closed by me", closed, "done and dusted")}
    </div>`;
}

async function renderMyPeople(opts = {}) {
  const content = $("#content");

  let contacts = [];
  let leads = [];
  try {
    const [people, leadRes] = await Promise.all([
      api("/api/contacts/people?mine=1&sort=urgent"),
      api("/api/leads?tab=mine&limit=200").catch(() => ({ leads: [] })),
    ]);
    contacts = people.contacts || [];
    leads = (leadRes.leads || []).filter((l) => l.fresh_owner_id === state.user.id);
  } catch (err) {
    content.innerHTML = `<div class="empty"><h2>Couldn't load your outreach</h2><p>${esc(err.message)}</p></div>`;
    return;
  }

  // Three separate commitments, three separate lists. A Newspaper pickup has
  // no deadline — it already ran out of time once, and a second countdown
  // would only send it round the same loop.
  const groups = {
    all: contacts,
    fresh: leads.filter((l) => !l.fresh_from_newspaper),
    newspaper: leads.filter((l) => l.fresh_from_newspaper),
  };

  const TABS = [
    ["all", "From All Leads"],
    ["fresh", "From Fresh Leads"],
    ["newspaper", "From Newspaper"],
  ];

  // Open on a tab that has something, unless the user has picked one.
  if (!state.mineViewChosen) {
    const firstFull = TABS.find(([k]) => groups[k].length);
    if (firstFull) state.mineView = firstFull[0];
  }
  if (!groups[state.mineView]) state.mineView = "all";

  const view = state.mineView;
  const list = groups[view];

  const subtabs = `
    <div class="mine-subtabs">
      ${TABS.map(
        ([key, label]) => `
        <button class="chip ${view === key ? "is-on" : ""}" data-mineview="${key}">
          ${esc(label)} <span class="pill">${groups[key].length}</span>
        </button>`
      ).join("")}
    </div>`;

  const empty = {
    all: ["Nothing claimed from All Leads", "Claim a person there and you have 30 days to close it."],
    fresh: ["Nothing claimed from Fresh Leads", "Claim a company there and you have 10 days."],
    newspaper: ["Nothing picked up from the Newspaper", "Leads released for missing their deadline land there for anyone to take. These carry no clock."],
  }[view];

  const body = list.length
    ? view === "all"
      ? `<div class="mylead-grid">${list.map(myPersonCard).join("")}</div>`
      : `<div class="mylead-grid">${list.map((l) => outreachCard(l, "fresh")).join("")}</div>`
    : `<div class="empty"><h2>${esc(empty[0])}</h2><p>${esc(empty[1])}</p></div>`;

  content.innerHTML = actionBar() + outreachSlabs(contacts, leads) + subtabs + body;

  wireListActions();
  if (view === "all") for (const c of list) loadContactLog(c.id);
}

/** Paint one contact's history into its card. */
async function loadContactLog(id) {
  const box = $(`#log-${id}`);
  if (!box) return;

  let activity = [];
  try {
    ({ activity } = await api(`/api/contacts/people/${id}/activity`));
  } catch {
    box.innerHTML = "";
    return;
  }

  box.innerHTML = activity.length
    ? activity
        .slice(0, 6)
        .map(
          (a) => `
        <div class="log-item">
          <div class="log-meta">
            <span class="log-kind">${esc(KIND_LABEL[a.kind] || a.kind)}</span>
            <span>${esc(timeAgo(a.created_at))} · ${esc(a.user_name || "Someone")}</span>
          </div>
          <p>${esc(a.body)}</p>
          ${a.stage ? `<span class="log-stage">Moved to ${esc(stageLabel(a.stage))}</span>` : ""}
        </div>`
        )
        .join("")
    : `<p class="muted">Nothing logged yet. Add the first update below.</p>`;
}

function myPersonCard(c) {
  const closed = Boolean(c.closed_at);

  return `
    <div class="mylead-card ${closed ? "is-closed" : ""}">
      <div class="mylead-top">
        <div class="mylead-heading">
          <div class="company-name">
            ${c.linkedin
              ? `<a href="${esc(c.linkedin)}" target="_blank" rel="noopener">${esc(c.name)}</a>`
              : esc(c.name)}
          </div>
          <div class="mylead-meta">${esc(c.role || "—")} · ${esc(c.company)}</div>
        </div>
        <div class="mylead-corner">
          ${closed ? `<span class="clock clock-done">Closed</span>` : countdownChip(c.countdown)}
        </div>
      </div>

      <div class="mylead-signals">
        ${c.email ? `<div><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ""}
        ${c.phone ? `<div><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></div>` : ""}
        ${c.phone2 ? `<div><a href="tel:${esc(c.phone2)}">${esc(c.phone2)}</a></div>` : ""}
        ${!c.email && !c.phone ? `<div class="signal-none">No email or mobile on file.</div>` : ""}
      </div>

      <div class="progress-block">
        <div class="progress-head">
          <span class="filter-label">Progress</span>
          <span class="stage-chip stage-${esc(c.status || "new")}">${esc(stageLabel(c.status))}</span>
        </div>

        <div class="progress-log" id="log-${c.id}"></div>

        <div class="progress-form">
          <textarea id="note-${c.id}" rows="2"
            placeholder="What did you discuss? e.g. Called — asked for the deck, wants pricing by Friday"></textarea>
          <div class="progress-controls">
            <select class="filter-select" id="kind-${c.id}">
              <option value="call">Call</option>
              <option value="email">Email</option>
              <option value="linkedin">LinkedIn</option>
              <option value="meeting">Meeting</option>
              <option value="note">Note</option>
            </select>
            <select class="filter-select" id="stage-${c.id}">
              <option value="">Stage unchanged</option>
              ${STATUSES.map(([v, l]) => `<option value="${v}">Move to ${esc(l)}</option>`).join("")}
            </select>
            <button class="btn btn-sm btn-primary" data-log-for="${c.id}">Log it</button>
          </div>
        </div>
      </div>

      <div class="mylead-actions">
        ${
          closed
            ? `<button class="btn btn-ghost btn-sm" data-contact-act="reopen" data-id="${c.id}">Reopen</button>`
            : `<button class="btn btn-sm btn-primary" data-contact-act="close" data-id="${c.id}">Mark closed</button>`
        }
        <button class="btn btn-ghost btn-sm release-trigger" data-release-contact="${c.id}">Release</button>
      </div>
    </div>`;
}

/* ── Fresh Leads ─────────────────────────────────────────────────────────── */

/** News on a company you already have. Claimable, no Inspect. */
function freshCard(lead) {
  return `
    <div class="mylead-card is-static">
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

      ${
        !lead.fresh_owner_id && lead.fresh_release_note
          ? `<div class="release-note">
               <span class="mono-label">Handed back</span>
               ${esc(lead.fresh_release_note)}
             </div>`
          : ""
      }

      ${signalsByType(lead.signals, null, true)}

      <div class="mylead-actions">
        ${
          lead.fresh_owner_id === state.user.id
            ? `<span class="muted">Yours — work it in My Outreach</span>
               <button class="btn btn-sm" data-act="release" data-source="fresh" data-id="${lead.id}">Release</button>`
            : `<span class="muted">24h to show progress, then 15 days to close</span>
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
        <span class="muted">Went unworked past its deadline · no clock on this one</span>
        <div class="np-buttons">
          ${
            state.user.role === "admin"
              ? `<button class="btn btn-sm btn-ghost np-remove" data-remove-lead="${lead.id}"
                         data-company="${esc(lead.company)}">Remove</button>`
              : ""
          }
          <button class="btn btn-sm btn-primary" data-act="claim" data-source="newspaper" data-id="${lead.id}">
            Pick this up
          </button>
        </div>
      </div>
    </div>`;
}

/**
 * Admin-only: take a lead out of the Newspaper.
 *
 * Two choices, because they are genuinely different decisions. "Just remove"
 * handles a junk story — if the company turns up in real news later, it comes
 * back, which is usually right. "Remove and block" handles a company that is
 * never going to be a customer, and is the only option that stops the scraper
 * re-finding the same name every week.
 */
function confirmRemoveLead(id, company) {
  const existing = $("#np-remove-dialog");
  if (existing) existing.remove();

  const box = document.createElement("div");
  box.id = "np-remove-dialog";
  box.className = "modal-backdrop";
  box.innerHTML = `
    <div class="modal-box">
      <h3>Remove ${esc(company)}?</h3>
      <p class="hint">This takes it off the Newspaper for everyone. Nothing is
        permanently erased — you can see what was removed in the admin area.</p>

      <label class="field">
        <span>Why? (optional, so others know)</span>
        <input id="np-reason" placeholder="e.g. not our kind of client" />
      </label>

      <div class="np-choices">
        <button class="btn btn-block" data-np-choice="hide">
          <strong>Just remove this one</strong>
          <span class="hint">If real news about ${esc(company)} shows up later, it comes back.</span>
        </button>
        <button class="btn btn-block btn-danger" data-np-choice="block">
          <strong>Remove and block this company</strong>
          <span class="hint">${esc(company)} never appears again, in any tab.</span>
        </button>
      </div>

      <button class="btn btn-sm" data-np-choice="cancel">Cancel</button>
    </div>`;

  document.body.appendChild(box);

  box.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-np-choice]");
    if (!btn) {
      if (e.target === box) box.remove();
      return;
    }

    const choice = btn.dataset.npChoice;
    if (choice === "cancel") return box.remove();

    try {
      const res = await api(`/api/leads/${id}`, {
        method: "DELETE",
        body: { blocklist: choice === "block", reason: $("#np-reason", box).value || null },
      });
      box.remove();
      toast(res.message);
      refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ── Signals, grouped by type (Funding, Leadership, …) ───────────────────── */

// Order the groups the same way the playbook orders priority: hottest first.
const TYPE_ORDER = ["capital", "brand_launch", "retail_expansion", "leadership", "crisis", "none"];

/**
 * Send a contact sheet to the server in slices.
 *
 * Not an optimisation — a requirement on serverless hosting. Vercel caps a
 * function's request body at 4.5 MB and that is infrastructure, not a setting:
 * you can change execution time and memory in vercel.json, you cannot change
 * this. A real export is well past it. The function timeout bites too — ten
 * seconds on Hobby, and twenty thousand rows takes far longer than that.
 *
 * So the browser cuts the sheet into parts and sends them one after another,
 * each with the header row attached so every part parses on its own. Safe
 * because the importer is idempotent: it upserts, so a part that gets sent
 * twice tops the same people up rather than duplicating them.
 *
 * It also fixes a plain usability problem on any host — instead of the page
 * sitting frozen for a minute, you watch it count through the parts.
 */
async function importInSlices(csv, onProgress) {
  // Comfortably inside Vercel's 4.5 MB body cap, and small enough that one
  // part finishes well within a short function timeout.
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_ROWS = 2000;

  const lines = csv.split(/\r?\n/);
  const header = lines[0];
  const body = lines.slice(1).filter((l) => l.trim());

  const parts = [];
  let current = [];
  let bytes = header.length;

  for (const line of body) {
    // A quoted field can legitimately contain a newline, which would split a
    // record across two parts and corrupt both. Only break where the quotes so
    // far are balanced, which is the same rule the parser uses.
    const balanced = (current.join("\n").match(/"/g) || []).length % 2 === 0;

    if (current.length && balanced && (current.length >= MAX_ROWS || bytes >= MAX_BYTES)) {
      parts.push([header, ...current].join("\n"));
      current = [];
      bytes = header.length;
    }
    current.push(line);
    bytes += line.length + 1;
  }
  if (current.length) parts.push([header, ...current].join("\n"));

  const total = {
    rows: 0, companies: 0, contacts: 0,
    companiesAdded: 0, contactsAdded: 0, contactsUpdated: 0,
    duplicatesSkipped: 0, skipped: 0,
    unmatched: [], parts: parts.length,
  };

  let sent = 0;
  for (let i = 0; i < parts.length; i++) {
    if (onProgress) onProgress(i + 1, parts.length, sent);

    const r = await api("/api/admin/import", {
      method: "POST",
      body: { csv: parts[i], part: i + 1, parts: parts.length },
    });

    for (const key of ["rows", "companies", "contacts", "companiesAdded",
                       "contactsAdded", "contactsUpdated", "duplicatesSkipped", "skipped"]) {
      total[key] += Number(r[key]) || 0;
    }
    // Same columns every part; keep one copy rather than a growing list.
    if (r.unmatched && r.unmatched.length) total.unmatched = r.unmatched;
    if (r.warning) total.warning = r.warning;
    sent += Number(r.rows) || 0;
  }

  // Companies repeat across parts, so the summed figure overcounts them.
  // Reporting how many were CREATED is both accurate and the more useful
  // number; the total is quietly dropped to the created count's floor.
  total.companies = Math.max(total.companiesAdded, 0) || total.companies;

  return total;
}

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
        // Sliced, exactly like the Admin tab's importer. This is the upload
        // button on the leads list — it sent the whole file in one request and
        // was missed when the other one was fixed, so a large sheet failed
        // here with a bare 413 from the platform while the same file imported
        // fine from Admin.
        toast("Importing…");
        const r = await importInSlices(csv, (done, total) => {
          if (total > 1) toast(`Importing part ${done} of ${total}…`);
        });

        if (r.warning) {
          toast(r.warning, true);
          console.warn("Columns recognised:", r.matched, "| ignored:", r.unmatched);
        } else {
          // Say what happened to every row, not just the new ones. "0 new
          // contacts" on a sheet of 200 people reads as a broken import when
          // it usually means they were already on file — and the difference
          // between "already there" and "updated with new details" is exactly
          // what someone re-uploading an enriched sheet wants to know.
          toast(
            [
              `${r.companiesAdded} new compan${r.companiesAdded === 1 ? "y" : "ies"}`,
              `${r.contactsAdded} new contact${r.contactsAdded === 1 ? "" : "s"}`,
              r.contactsUpdated ? `${r.contactsUpdated} updated` : null,
              r.duplicatesSkipped ? `${r.duplicatesSkipped} already up to date` : null,
              r.skipped ? `${r.skipped} row${r.skipped === 1 ? "" : "s"} with no company name` : null,
            ]
              .filter(Boolean)
              .join(" · ")
          );
        }
        refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  const newLead = $("#ab-new-lead");
  if (newLead) newLead.addEventListener("click", openNewLeadModal);

  // Ask for a bigger page rather than paging blindly — the list keeps its
  // place and nobody loses their scroll position.
  const more = $("#load-more");
  if (more) {
    more.addEventListener("click", () => {
      state.pageSize += 50;
      renderContent();
    });
  }

  const scan = $("#ab-scan");
  if (scan) {
    scan.addEventListener("click", async () => {
      // Which list you're looking at decides which sweep runs. The two are on
      // different clocks and cost very different amounts, so "Sync" on New
      // Leads must not drag the whole watchlist along with it.
      const mode = scan.dataset.mode === "new" ? "new" : "company";
      state.scanning = true;
      renderContent();
      try {
        const r = await api("/api/admin/run", { method: "POST", body: { mode } });
        toast(r.message || "Syncing — this takes a few minutes");
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
        toast("Sync finished");
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
    fresh:
      state.freshView === "new"
        ? [
            "No new companies right now",
            "New Leads shows companies the daily sweep found in the news that aren't in All Leads yet. Nothing turned up in the last few days.",
          ]
        : [
            "No news in the last few days",
            "Company Leads shows companies from your database that made the news. It syncs every 3 days — or widen the window in settings.",
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
  // Logging what was discussed with a claimed contact.
  const logBtn = e.target.closest("[data-log-for]");
  if (logBtn) {
    e.stopPropagation();
    const id = logBtn.dataset.logFor;
    const body = $(`#note-${id}`).value.trim();
    if (!body) return toast("Write what was discussed first.", true);

    try {
      await api(`/api/contacts/people/${id}/activity`, {
        method: "POST",
        body: {
          body,
          kind: $(`#kind-${id}`).value,
          stage: $(`#stage-${id}`).value || undefined,
        },
      });
      $(`#note-${id}`).value = "";
      toast("Progress logged");
      renderContent();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  // Verified / Unverified. Anyone can set it and it shows for everyone, so
  // the row is repainted from the server's answer rather than toggled
  // optimistically — the badge has to be the truth, not this tab's guess.
  const verifyBtn = e.target.closest("[data-verify]");
  if (verifyBtn) {
    e.stopPropagation();
    const id = verifyBtn.dataset.verify;
    const to = verifyBtn.dataset.to === "1";
    const wrap = verifyBtn.closest(".verify-wrap");

    verifyBtn.disabled = true;
    try {
      const { contact, verified_by_name } = await api(`/api/contacts/people/${id}/verify`, {
        method: "POST",
        body: { verified: to },
      });

      // Swap the WHOLE wrap (button + date span), not just the button.
      // Replacing only the button left the old date span behind as an
      // orphaned sibling — that's why unverifying could leave a stale date
      // on screen until the page was refreshed.
      const fresh = { ...contact, verified_by_name };
      if (wrap) wrap.outerHTML = verifyChip(fresh);
      const row = $(`[data-verify="${id}"]`).closest(".ct-row");
      if (row) row.classList.toggle("is-verified", Boolean(contact.verified));

      toast(to ? "Marked verified — the whole team sees this" : "Marked unverified");
    } catch (err) {
      verifyBtn.disabled = false;
      toast(err.message, true);
    }
    return;
  }

  // Fresh Leads sub-tab toggle (Company Leads / New Leads).
  const freshToggle = e.target.closest("[data-freshview]");
  if (freshToggle) {
    e.stopPropagation();
    state.freshView = freshToggle.dataset.freshview === "new" ? "new" : "company";
    state.pageSize = 50;
    renderContent();
    return;
  }

  // The full release reason, on click.
  const noteBtn = e.target.closest("[data-note]");
  if (noteBtn) {
    e.stopPropagation();
    showNotePopover(noteBtn, noteBtn.dataset.note);
    return;
  }

  // Admin-only row editor.
  const editBtn = e.target.closest("[data-edit-contact]");
  if (editBtn) {
    e.stopPropagation();
    return openContactEditor(editBtn.dataset.editContact);
  }

  // Releasing needs a reason before it will go through.
  const releaseBtn = e.target.closest("[data-release-contact]");
  if (releaseBtn) {
    e.stopPropagation();
    const note = window.prompt(
      "Why are you releasing this contact?\n\nWhoever picks it up next will see this."
    );
    if (note === null) return;
    if (note.trim().length < 3) return toast("Give a reason before releasing.", true);

    try {
      await api(`/api/contacts/${releaseBtn.dataset.releaseContact}/claim`, {
        method: "POST",
        body: { release: true, note: note.trim() },
      });
      toast("Released");
      renderContent();
      loadStats();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  // Claiming a PERSON — All Leads rows and the people half of My Outreach.
  const personBtn = e.target.closest("[data-contact-act]");
  if (personBtn) {
    e.stopPropagation();
    const act = personBtn.dataset.contactAct;
    try {
      if (act === "close" || act === "reopen") {
        await api(`/api/contacts/${personBtn.dataset.id}/close`, {
          method: "POST",
          body: { reopen: act === "reopen" },
        });
        toast(act === "reopen" ? "Reopened — clock restarted" : "Marked closed");
      } else {
        await api(`/api/contacts/${personBtn.dataset.id}/claim`, {
          method: "POST",
          body: { release: act === "release" },
        });
        toast(act === "release" ? "Released" : "Claimed — 30 days to close");
      }
      renderContent();
      loadStats();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  // My Outreach sub-tab toggle (From All Leads / From Fresh Leads).
  const mineToggle = e.target.closest("[data-mineview]");
  if (mineToggle) {
    e.stopPropagation();
    // Any of the three, not just fresh-or-everything-else — "newspaper" used to
    // fall through to "all", so that tab could never be opened.
    const picked = mineToggle.dataset.mineview;
    state.mineView = ["all", "fresh", "newspaper"].includes(picked) ? picked : "all";
    state.mineViewChosen = true;   // respect an explicit choice over the smart default
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
      const { contacts } = await api(`/api/leads/${id}/people`);
      box.innerHTML = contacts.length
        ? `<div class="ct-table">${contactHead()}${contacts.map(contactRow).join("")}</div>`
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
        let note;
        if (act === "release") {
          note = window.prompt(
            "Why are you releasing this lead?\n\nWhoever picks it up next will see this."
          );
          if (note === null) return;
          if (note.trim().length < 3) return toast("Give a reason before releasing.", true);
        }

        // Where it was claimed from decides the deadline: 10 days or 30.
        const { lead } = await api(`/api/leads/${id}/claim`, {
          method: "POST",
          body: {
            release: act === "release",
            note: note ? note.trim() : undefined,
            source: actionBtn.dataset.source || (state.tab === "fresh" ? "fresh" : "all"),
          },
        });

        // A fresh claim takes the company's people with it. Say how many, and
        // say plainly if any were reassigned — someone else just lost a row
        // and the person who took it should know that happened.
        const swept = lead && lead.cascade;
        const sweptNote =
          swept && swept.claimed && swept.claimed.length
            ? ` · ${swept.claimed.length} contact${swept.claimed.length === 1 ? "" : "s"} came with it` +
              (swept.takenOver && swept.takenOver.length
                ? ` (${swept.takenOver.length} reassigned)`
                : "")
            : "";

        toast(
          act === "release"
            ? "Released"
            : actionBtn.dataset.source === "newspaper"
            ? `Picked up — no deadline on this one${sweptNote}`
            : `Claimed — ${actionBtn.dataset.source === "fresh" ? 10 : 30} days to close${sweptNote}`
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
  // The side panel is a My Outreach thing: it's for working a lead you hold,
  // not for browsing Fresh Leads.
  if (state.tab !== "mine") return;
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

/* ── Unclaimed Fresh Leads (admin only) ──────────────────────────────────── */

/**
 * Unclaimed Fresh Leads — an Admin block now, not a stat card with a modal.
 *
 * It was a number in the top strip that opened a panel, which meant the one
 * person who could act on it saw it constantly and everybody else saw it
 * never. It belongs where the rest of the oversight lives.
 *
 * Split the same way Fresh Leads is, because the two lists mean different
 * things: an unclaimed Company Lead is news about an account the team already
 * owns and walked past. An unclaimed New Lead is a company nobody has decided
 * about yet, and it may want approving rather than claiming.
 */
function unclaimedBlock(data) {
  const rows = (list, emptyCopy) =>
    list.length
      ? `<div class="rows" style="margin-top:12px">
           ${list
             .map(
               (l) => `<div class="row" data-open-lead="${l.id}">
                 <div class="row-main">
                   <strong>${esc(l.company)}</strong>
                   <span>
                     ${l.fresh_count} signal${l.fresh_count === 1 ? "" : "s"} in the last ${
                 data.windowDays
               } days${l.top_title ? ` · ${esc(String(l.top_title).slice(0, 70))}` : ""}
                   </span>
                 </div>
                 <span class="muted">${esc(timeAgo(l.last_signal_at) || "")}</span>
               </div>`
             )
             .join("")}
         </div>`
      : `<p class="hint" style="margin-top:10px">${esc(emptyCopy)}</p>`;

  const company = data.company || [];
  const fresh = data.fresh || [];

  return `
    <div class="admin-block" style="margin-bottom:16px">
      <h3>Unclaimed Fresh Leads <span class="pill">${company.length + fresh.length}</span></h3>
      <p class="hint">
        News from the last ${data.windowDays} days that nobody has picked up. Click one to open it.
      </p>

      <h4 class="admin-sub">Company Leads <span class="pill">${company.length}</span></h4>
      ${rows(company, "Nothing sitting unclaimed — the team is keeping up.")}

      <h4 class="admin-sub">New Leads <span class="pill">${fresh.length}</span></h4>
      ${rows(
        fresh,
        "No unclaimed discoveries. Anything the daily sweep finds shows up here first."
      )}
    </div>`;
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

/**
 * The people at this company, inside the lead drawer.
 *
 * When you hold the Fresh Lead you're working the whole account, so this has
 * to show who already has each contact, how far they've got, and what they've
 * said — otherwise two people ring the same person in the same week. It also
 * shows why anyone handed a contact back.
 */
async function loadContacts(lead) {
  const box = $("#d-poc");
  if (!box) return;

  let contacts = [];
  try {
    ({ contacts } = await api(`/api/leads/${lead.id}/people`));
  } catch (err) {
    box.innerHTML = `<p class="sig-sub">${esc(err.message)}</p>`;
    return;
  }

  if (!contacts.length) {
    box.innerHTML = `<p class="sig-sub">Nobody on file for ${esc(lead.company)} yet.</p>`;
    return;
  }

  box.innerHTML = contacts
    .map(
      (c, i) => `
    <div class="poc-card ${c.owner_id && c.owner_id !== state.user.id ? "is-taken" : ""}">
      <div class="poc-head">
        <p class="poc-name">${esc(c.name)}</p>
        ${
          c.owner_id
            ? `<span class="poc-owner">
                 ${esc(c.owner_name)}${c.owner_id === state.user.id ? " (you)" : ""}
               </span>
               <span class="stage-chip stage-${esc(c.status || "new")}">${esc(stageLabel(c.status))}</span>`
            : `<span class="poc-free">Unclaimed</span>`
        }
      </div>

      ${c.role ? `<p class="poc-role">${esc(c.role)}</p>` : ""}
      ${
        c.taken_from_name
          ? `<p class="poc-taken">Was with ${esc(c.taken_from_name)}${
              c.taken_from_status ? ` · ${esc(stageLabel(c.taken_from_status))}` : ""
            }</p>`
          : ""
      }

      <p class="poc-reach">
        ${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ""}
        ${c.email && c.phone ? `<span class="sep">·</span>` : ""}
        ${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ""}
        ${c.phone && c.phone2 ? `<span class="sep">·</span>` : ""}
        ${c.phone2 ? `<a href="tel:${esc(c.phone2)}">${esc(c.phone2)}</a>` : ""}
      </p>

      ${
        !c.owner_id && c.release_note
          ? `<div class="release-note">Handed back: ${esc(c.release_note)}</div>`
          : ""
      }

      ${
        c.activity && c.activity.length
          ? `<div class="poc-log">
               ${c.activity
                 .slice(0, 3)
                 .map(
                   (a) => `<div class="poc-log-item">
                     <span>${esc(KIND_LABEL[a.kind] || a.kind)} · ${esc(timeAgo(a.created_at))} · ${esc(
                     a.user_name || "Someone"
                   )}</span>
                     <p>${esc(a.body)}</p>
                   </div>`
                 )
                 .join("")}
             </div>`
          : ""
      }

      <div class="poc-actions">
        <button class="chip" data-use="${i}">Use this contact</button>
        ${
          !c.owner_id
            ? `<button class="chip" data-contact-act="claim" data-id="${c.id}">Claim</button>`
            : ""
        }
      </div>
    </div>`
    )
    .join("");

  const data = { contacts };

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
      const added = await api("/api/contacts", {
        method: "POST",
        body: {
          company: lead.company,
          name,
          role: $("#d-crole").value,
          email: $("#d-cemail").value,
          phone: $("#d-cphone").value,
        },
      });
      toast(
        added.companyCreated
          ? `Added — ${added.company} is now in All Leads too`
          : "Added to the directory"
      );
      loadContacts(lead);
      loadStats();
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

  let companies, sites, users, runs, topics, discovered, unclaimed;
  try {
    [{ companies }, { sites }, { users }, runs, { topics }, discovered, unclaimed] =
      await Promise.all([
        api("/api/admin/companies"),
        api("/api/admin/sites"),
        api("/api/admin/users"),
        api("/api/admin/runs"),
        api("/api/admin/topics"),
        api("/api/admin/discoveries").catch(() => ({ companies: [] })),
        api("/api/admin/unclaimed").catch(() => ({ company: [], fresh: [], windowDays: 3 })),
      ]);
  } catch (err) {
    content.innerHTML = `<div class="empty"><h2>Admin unavailable</h2><p>${esc(err.message)}</p></div>`;
    return;
  }

  const activeTopics = topics.filter((t) => t.active).length;

  content.innerHTML = `
    <div id="admin-root">
    ${unclaimedBlock(unclaimed)}
    ${
      discovered && discovered.companies.length
        ? `<div class="admin-block" style="margin-bottom:16px">
             <h3>Discovered companies <span class="pill">${discovered.companies.length}</span></h3>
             <p class="hint">
               The daily discovery sweep found these in the news. They already show in
               <strong>Fresh Leads &rsaquo; New Leads</strong> and can be claimed from there.
               They are <strong>not</strong> in All Leads and won't be until you approve one —
               approving adds it to the watchlist, so it joins All Leads and gets swept with the
               other companies every 3 days. Rejecting hides it for good.
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
      <h3>Deleted contacts</h3>
      <p class="hint">
        Deleting hides a contact rather than destroying it — its import snapshot,
        edit history and outreach log are kept. Anything here can be put back.
      </p>
      <div class="inline-form">
        <button class="btn" id="deleted-load">Show deleted contacts</button>
      </div>
      <div id="deleted-result"></div>
    </div>

    <div class="admin-block" style="margin-bottom:16px">
      <h3>Newspaper samples</h3>
      <p class="hint">
        The Newspaper only fills once a Fresh Lead misses its 10-day deadline, so it
        starts empty. Add clearly-marked samples across 2025 and 2026 to try the
        year → month → day view, then remove them when you're done.
      </p>
      <div class="inline-form">
        <button class="btn" id="demo-add">Add sample releases</button>
        <button class="btn btn-danger" id="demo-clear">Remove samples</button>
      </div>
      <div id="demo-result"></div>
    </div>

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
          <h3>Collection cycles</h3>
          <p class="hint" id="run-hint">
            <strong>Company Leads</strong> — the watchlist sweep. ${runs.queryCount} queries per cycle
            (${companies.filter((c) => c.active).length} companies × ${sites.filter((s) => s.active).length} sources),
            scheduled ${esc(state.schedule ? state.schedule.cronCompany || state.schedule.cron : "0 2 */3 * *")}
            (${esc(state.schedule ? state.schedule.timezone : "")}) — every 3 days.
            <br />
            <strong>New Leads</strong> — the discovery sweep. Reads the same sources with no company
            filter and lets Gemini name the company, scheduled
            ${esc(state.schedule ? state.schedule.cronNew || "0 3 * * *" : "0 3 * * *")} — daily.
            Nothing it finds enters All Leads until you approve it above.
            ${runs.hasNewsKey ? "" : "<strong>NEWSAPI_AI_KEY is missing from .env.</strong>"}
            ${runs.hasGeminiKey ? "" : "<strong>Gemini key not set — New Leads can't run without it.</strong>"}
          </p>
        </div>
        <div class="run-buttons">
          <button class="btn btn-primary" id="run-now" data-mode="company" ${runs.running ? "disabled" : ""}>
            ${runs.running ? "Running…" : "Sync Company Leads"}
          </button>
          <button class="btn" id="run-now-new" data-mode="new" ${runs.running ? "disabled" : ""}>
            ${runs.running ? "Running…" : "Sync New Leads"}
          </button>
        </div>
      </div>
      <div id="run-progress"></div>
      <table class="mini" style="margin-top:14px">
        <thead><tr><th>Started</th><th>List</th><th>Trigger</th><th>Fetched</th><th>New</th><th>Errors</th><th>Status</th></tr></thead>
        <tbody>
          ${
            runs.runs.length
              ? runs.runs
                  .map(
                    (r) => `<tr>
                      <td>${esc(timeAgo(r.started_at))}</td>
                      <td>${esc(r.mode === "new" ? "New Leads" : "Company Leads")}</td>
                      <td>${esc(r.trigger)}</td>
                      <td>${r.fetched}</td>
                      <td>${r.new_signals}</td>
                      <td>${r.errors}</td>
                      <td>${esc(r.status)}${r.message ? ` — ${esc(r.message)}` : ""}</td>
                    </tr>`
                  )
                  .join("")
              : `<tr><td colspan="7">No cycles have run yet.</td></tr>`
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

  // Two buttons, two sweeps. Only one run may be in flight, so both are
  // disabled the moment either starts.
  for (const id of ["#run-now", "#run-now-new"]) {
    const btn = $(id);
    if (!btn) continue;

    btn.addEventListener("click", async () => {
      const mode = btn.dataset.mode === "new" ? "new" : "company";
      try {
        const r = await api("/api/admin/run", { method: "POST", body: { mode } });
        toast(r.message || `${mode === "new" ? "New Leads" : "Company Leads"} cycle started`);
        for (const other of ["#run-now", "#run-now-new"]) {
          const el = $(other);
          if (el) { el.disabled = true; el.textContent = "Running…"; }
        }
        pollRun();
      } catch (err) { toast(err.message, true); }
    });
  }

  // Rows in the unclaimed block open the lead, same as the old modal did.
  root.querySelectorAll("[data-open-lead]").forEach((row) =>
    row.addEventListener("click", () => openDrawer(row.dataset.openLead))
  );

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

    if (btn.id === "deleted-load") {
      const out = $("#deleted-result");
      out.innerHTML = `<p class="hint" style="margin-top:10px">Loading…</p>`;
      try {
        const { contacts } = await api("/api/contacts/deleted");
        out.innerHTML = contacts.length
          ? `<div class="rows" style="margin-top:12px">
               ${contacts
                 .map(
                   (c) => `<div class="row">
                     <div class="row-main">
                       <strong>${esc(c.name)}</strong>
                       <span>${esc(c.company)}${c.role ? ` · ${esc(c.role)}` : ""} · deleted ${esc(
                     timeAgo(c.deleted_at)
                   )} by ${esc(c.deleted_by_name || "someone")}</span>
                     </div>
                     <div class="row-actions">
                       <button class="btn btn-sm" data-restore="${c.id}">Restore</button>
                     </div>
                   </div>`
                 )
                 .join("")}
             </div>`
          : `<p class="hint" style="margin-top:10px">Nothing has been deleted.</p>`;
      } catch (err) {
        out.innerHTML = `<p class="hint" style="margin-top:10px"><strong>${esc(err.message)}</strong></p>`;
      }
      return;
    }

    if (btn.dataset.restore) {
      try {
        await api(`/api/contacts/people/${btn.dataset.restore}/restore`, { method: "POST" });
        toast("Contact restored");
        $("#deleted-load").click();
        loadStats();
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }

    if (btn.id === "demo-add" || btn.id === "demo-clear") {
      const clearing = btn.id === "demo-clear";
      const out = $("#demo-result");
      out.innerHTML = `<p class="hint" style="margin-top:10px">Working…</p>`;
      try {
        const r = await api("/api/admin/demo-newspaper", {
          method: "POST",
          body: { clear: clearing },
        });
        out.innerHTML = `<p class="hint" style="margin-top:10px">
          <strong style="color:var(--teal)">Done.</strong>
          ${clearing ? `${r.cleared} sample compan${r.cleared === 1 ? "y" : "ies"} removed.`
                     : `${r.added} sample releases added — open the Newspaper tab.`}</p>`;
        loadStats();
      } catch (err) {
        out.innerHTML = `<p class="hint" style="margin-top:10px"><strong>${esc(err.message)}</strong></p>`;
      }
      return;
    }

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
        const r = await importInSlices(csv, (done, total, sent) => {
          out.innerHTML = `<p class="hint" style="margin-top:12px">
            Uploading part ${done} of ${total}… ${sent.toLocaleString()} rows sent so far.
          </p>`;
        });

        // Full breakdown here, where there's room for it. If people are
        // missing after an import, this is the first thing to read — and if
        // the column names weren't recognised, `unmatched` says which ones
        // were ignored instead of leaving it a mystery.
        out.innerHTML = `<p class="hint" style="margin-top:12px">
          <strong style="color:var(--teal)">Done.</strong>
          Read ${r.rows} row${r.rows === 1 ? "" : "s"}${r.parts > 1 ? ` in ${r.parts} parts` : ""}:
          ${r.companies} compan${r.companies === 1 ? "y" : "ies"} (${r.companiesAdded} new),
          ${r.contacts} contact${r.contacts === 1 ? "" : "s"}
          (${r.contactsAdded} new${r.contactsUpdated ? `, ${r.contactsUpdated} updated` : ""}${
            r.duplicatesSkipped ? `, ${r.duplicatesSkipped} already up to date` : ""
          })${
            r.skipped ? `, ${r.skipped} row${r.skipped === 1 ? "" : "s"} skipped with no company name` : ""
          }.
          ${
            r.unmatched && r.unmatched.length
              ? `<br /><span style="color:var(--amber-ink)">Columns ignored: ${esc(
                  r.unmatched.join(", ")
                )}</span>`
              : ""
          }
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
/* ── Generic modal ────────────────────────────────────────────────────────
 * One dialog box reused for "+ New Lead" and "Request extension" so the two
 * new flows don't each need their own drawer plumbing. */
function openModal(title, bodyHtml) {
  $("#modal-backdrop").hidden = false;
  const box = $("#modal-box");
  box.hidden = false;
  box.innerHTML = `
    <div class="drawer-head">
      <h2>${esc(title)}</h2>
      <button class="drawer-close" id="modal-close">&times;</button>
    </div>
    <div class="drawer-body">${bodyHtml}</div>`;
  $("#modal-close").addEventListener("click", closeModal);
}

function closeModal() {
  $("#modal-backdrop").hidden = true;
  $("#modal-box").hidden = true;
  $("#modal-box").innerHTML = "";
}

/* ── Notification bell ────────────────────────────────────────────────────
 * Everything here is in-app only — there's no email/SMS service wired up,
 * so the 5-day warning and the extension-request inbox both live behind
 * this one icon. */
async function loadAlerts() {
  try {
    const data = await api("/api/contacts/my-alerts");
    state.alerts = data;

    if (state.user && state.user.role === "admin" && data.pendingReview > 0) {
      try {
        const { requests } = await api("/api/contacts/extension-requests");
        state.reviewQueue = requests;
      } catch { state.reviewQueue = []; }
    } else {
      state.reviewQueue = [];
    }

    // Outreach work rides the same 60-second poll rather than a second timer.
    // The follow-up table has always known a step was due; until this call
    // existed nothing told you, which made "automated follow-ups" a schedule
    // you had to remember to go and read.
    try {
      const out = await api("/api/outreach/alerts");
      state.outreachAlerts = out.items || [];
      state.outreachUnseen = out.unseen || 0;
    } catch {
      state.outreachAlerts = [];
      state.outreachUnseen = 0;
    }

    // The dot means "something you haven't looked at", not "you have work".
    // A dot that is permanently red because there are always five follow-ups
    // outstanding is a dot nobody reads — so once they open the bell, it goes
    // out and stays out until something genuinely new turns up.
    const unseen =
      (data.expiring ? data.expiring.length : 0) +
      (data.pendingReview || 0) +
      state.outreachUnseen;
    $("#bell-dot").hidden = unseen === 0;

    if (!$("#bell-panel").hidden) renderBellPanel();
  } catch {
    // Alerts are a nice-to-have — a failed fetch shouldn't interrupt anything.
  }
}

function renderBellPanel() {
  const panel = $("#bell-panel");
  const { expiring } = state.alerts;

  // Outreach first: these are things that go stale today. An expiring claim
  // five days out can wait until you have read them.
  const outreach = state.outreachAlerts || [];
  const outreachHtml = outreach.length
    ? `<h4 class="bell-section">Needs you now</h4>
       ${outreach
         .map(
           (a) => `
        <div class="bell-item bell-${esc(a.kind)}${a.unseen ? " is-new" : ""}">
          <div class="bell-item-main">
            <b>${esc(a.company)}</b>${a.contact_name ? ` · ${esc(a.contact_name)}` : ""}
            <span class="bell-item-sub">${esc(a.text)} — ${esc(a.action)}</span>
          </div>
          <button class="btn btn-sm btn-primary" data-bell-opp="${a.id}">Open</button>
        </div>`
         )
         .join("")}`
    : "";

  const expiringHtml = expiring && expiring.length
    ? expiring.map((c) => `
        <div class="bell-item">
          <div class="bell-item-main">
            <b>${esc(c.name)}</b> at ${esc(c.company)}
            <span class="bell-item-sub">${c.countdown ? esc(c.countdown.label) : "Due soon"} on your All Leads claim</span>
          </div>
          <button class="btn btn-sm" data-request-ext="${c.id}">Request extension</button>
        </div>`).join("")
    : `<p class="bell-empty">Nothing expiring in the next 5 days.</p>`;

  const reviewHtml = state.user.role === "admin"
    ? `<h4 class="bell-section">Extension requests</h4>
       ${
         state.reviewQueue.length
           ? state.reviewQueue.map((r) => `
               <div class="bell-item bell-review" data-review-id="${r.id}">
                 <div class="bell-item-main">
                   <b>${esc(r.requested_by)}</b> on ${esc(r.contact_name)} at ${esc(r.company)}
                   <span class="bell-item-sub">"${esc(r.reason)}"</span>
                 </div>
                 <div class="bell-review-actions">
                   <input type="number" min="1" class="bell-days" placeholder="days" id="days-${r.id}" />
                   <button class="btn btn-sm btn-primary" data-approve-ext="${r.id}">Approve</button>
                   <button class="btn btn-sm btn-ghost" data-deny-ext="${r.id}">Deny</button>
                 </div>
               </div>`).join("")
           : `<p class="bell-empty">No pending requests.</p>`
       }`
    : "";

  panel.innerHTML = `
    ${outreachHtml}
    <h4 class="bell-section">Expiring soon</h4>
    ${expiringHtml}
    ${reviewHtml}`;
}

document.addEventListener("click", async (e) => {
  // Jumping to the opportunity from the bell has to switch tabs too, or the
  // workspace opens over whatever list you happened to be looking at and
  // closing it drops you somewhere unrelated.
  const rmBtn = e.target.closest("[data-remove-lead]");
  if (rmBtn) {
    e.stopPropagation();
    confirmRemoveLead(rmBtn.dataset.removeLead, rmBtn.dataset.company);
    return;
  }

  const oppBtn = e.target.closest("[data-bell-opp]");
  if (oppBtn) {
    e.stopPropagation();
    $("#bell-panel").hidden = true;
    if (state.tab !== "mine") {
      state.tab = "mine";
      $$(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === "mine"));
      await renderContent();
    }
    openWorkspace(oppBtn.dataset.bellOpp);
    return;
  }

  const reqBtn = e.target.closest("[data-request-ext]");
  if (reqBtn) {
    e.stopPropagation();
    openExtensionModal(reqBtn.dataset.requestExt);
    return;
  }

  const approveBtn = e.target.closest("[data-approve-ext]");
  if (approveBtn) {
    e.stopPropagation();
    const id = approveBtn.dataset.approveExt;
    const days = Number($(`#days-${id}`).value);
    if (!days || days < 1) return toast("Enter how many days to grant.", true);
    try {
      await api(`/api/contacts/extension-requests/${id}/resolve`, {
        method: "POST",
        body: { approve: true, days },
      });
      toast(`Approved — ${days} more day${days === 1 ? "" : "s"}`);
      loadAlerts();
      refresh();
    } catch (err) { toast(err.message, true); }
    return;
  }

  const denyBtn = e.target.closest("[data-deny-ext]");
  if (denyBtn) {
    e.stopPropagation();
    const id = denyBtn.dataset.denyExt;
    try {
      await api(`/api/contacts/extension-requests/${id}/resolve`, { method: "POST", body: { approve: false } });
      toast("Denied");
      loadAlerts();
    } catch (err) { toast(err.message, true); }
  }
});

function openExtensionModal(contactId) {
  openModal("Request an extension", `
    <label class="field">
      <span>Why do you need more time?</span>
      <textarea id="ext-reason" rows="4" placeholder="What's blocking you from closing this in time?"></textarea>
    </label>
    <button class="btn btn-primary btn-block" id="ext-submit">Send to admin</button>`);

  $("#ext-submit").addEventListener("click", async () => {
    const reason = $("#ext-reason").value.trim();
    if (reason.length < 3) return toast("Say why you're asking, so the admin has something to go on.", true);
    try {
      await api(`/api/contacts/${contactId}/request-extension`, { method: "POST", body: { reason } });
      toast("Sent — the admin will review it");
      closeModal();
      loadAlerts();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ── "+ New Lead" dialog ──────────────────────────────────────────────────
 * Same field set the CSV importer reads. Typing a company that already
 * exists in All Leads pulls its firmographics in automatically, the same
 * way a second row for that company behaves in the sheet. */
const NEW_LEAD_CONTACT_FIELDS = [
  ["name", "Name", true],
  ["role", "Position", false],
  ["email", "Work email", false],
  ["phone", "Phone 1", false],
  ["phone2", "Phone 2", false],
  ["linkedin", "LinkedIn URL", false],
  ["seniority", "Seniority", false],
  ["department", "Department", false],
  ["city", "City", false],
  ["state", "State", false],
  ["country", "Country", false],
];

const NEW_LEAD_COMPANY_FIELDS = [
  ["company", "Company name", true],
  ["company_website", "Website", false],
  ["company_linkedin", "Company LinkedIn", false],
  ["company_domain", "Domain", false],
  ["company_industry", "Industry", false],
  ["company_employees", "Employees", false],
  ["company_revenue", "Revenue", false],
  ["company_founded", "Year founded", false],
];

function openNewLeadModal() {
  openModal("New lead", `
    <h3 class="editor-section">Person</h3>
    <div class="grid-2">
      ${NEW_LEAD_CONTACT_FIELDS.map(([key, label, required]) => `
        <label class="field">
          <span>${esc(label)}${required ? " *" : ""}</span>
          <input id="nl-${key}" ${required ? "required" : ""} />
        </label>`).join("")}
    </div>
    <h3 class="editor-section">Company</h3>
    <p class="hint" id="nl-autofill-hint" hidden>Matched an existing company — filled in what we already have.</p>
    <div class="grid-2">
      ${NEW_LEAD_COMPANY_FIELDS.map(([key, label, required]) => `
        <label class="field">
          <span>${esc(label)}${required ? " *" : ""}</span>
          <input id="nl-${key}" ${required ? "required" : ""} />
        </label>`).join("")}
    </div>
    <button class="btn btn-primary btn-block" id="nl-submit">Add lead</button>`);

  let lookupTimer;
  $("#nl-company").addEventListener("input", (e) => {
    clearTimeout(lookupTimer);
    const name = e.target.value.trim();
    if (!name) return;
    lookupTimer = setTimeout(async () => {
      try {
        const { company } = await api(`/api/contacts/company-lookup?name=${encodeURIComponent(name)}`);
        if (!company) { $("#nl-autofill-hint").hidden = true; return; }
        $("#nl-autofill-hint").hidden = false;
        const map = {
          company_website: company.website, company_linkedin: company.linkedin,
          company_domain: company.domain, company_industry: company.industry,
          company_employees: company.employees, company_revenue: company.revenue,
          company_founded: company.founded, city: company.city, state: company.state,
        };
        for (const [key, val] of Object.entries(map)) {
          const input = $(`#nl-${key}`);
          if (input && !input.value && val) input.value = val;
        }
      } catch { /* autofill is best-effort */ }
    }, 350);
  });

  $("#nl-submit").addEventListener("click", async () => {
    const body = {};
    for (const [key] of [...NEW_LEAD_CONTACT_FIELDS, ...NEW_LEAD_COMPANY_FIELDS]) {
      const input = $(`#nl-${key}`);
      if (input) body[key] = input.value.trim();
    }
    if (!body.company || !body.name) return toast("Company and name are required.", true);

    try {
      await api("/api/contacts/new-lead", { method: "POST", body });
      toast("Lead added");
      closeModal();
      refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });
}
