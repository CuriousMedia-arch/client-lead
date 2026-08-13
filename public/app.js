/* =========================================================================
   Curious Media — Lead Intelligence (frontend)
   No build step: plain ES modules-free JS so `npm start` is the only command.
   ========================================================================= */

const SIGNAL_TYPES = [
  ["funding", "Funding"],
  ["launch", "Launch"],
  ["expansion", "Expansion"],
  ["leadership", "Leadership"],
  ["m_and_a", "M&A"],
  ["partnership", "Partnership"],
  ["financials", "Financials"],
  ["other", "Other"],
];

const STATUSES = [
  ["new", "New"],
  ["working", "Working"],
  ["contacted", "Contacted"],
  ["replied", "Replied"],
  ["qualified", "Qualified"],
  ["won", "Won"],
  ["lost", "Lost"],
];

const KIND_ICON = {
  note: "✎", email: "✉", call: "☎", linkedin: "in",
  meeting: "◷", status: "→", claim: "★",
};

const state = {
  user: null,
  tab: "all",
  search: "",
  hygiene: new Set(),
  freshness: null,
  types: new Set(),
  statuses: new Set(),
  minScore: 0,
  sort: "score",
  scanning: false,
  team: [],
  openLeadId: null,
  runPoll: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ── API ────────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }

  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("is-error", isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

// ── Formatting ─────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function timeAgo(iso) {
  if (!iso) return "—";
  const then = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (isNaN(then)) return "—";
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function dateOnly(iso) {
  if (!iso) return "";
  return String(iso).slice(0, 10);
}

const typeLabel = (t) => (SIGNAL_TYPES.find((x) => x[0] === t) || [t, t])[1];
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
    state.tab = btn.dataset.tab;
    $$(".tab").forEach((t) => t.classList.toggle("is-active", t === btn));
    $("#layout").classList.toggle("is-wide", state.tab === "admin");
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
    if (el.id === "f-min") state.minScore = Number(el.value);
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
    for (const [key, value] of Object.entries(data.stats)) {
      const el = $(`[data-stat="${key}"]`);
      if (el) el.textContent = value;
    }
    $('[data-count="today"]').textContent = data.stats.newIn24h;
    $('[data-count="all"]').textContent = data.totals.leads;
    $('[data-count="mine"]').textContent = data.totals.mine;
    $('[data-count="today"]').textContent = data.totals.today;
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
  if (state.minScore) p.set("minScore", String(state.minScore));
  p.set("sort", state.sort);
  return p.toString();
}

// ── Page furniture ─────────────────────────────────────────────────────────

const PAGE_COPY = {
  all: ["All Leads", "Your database, scored by how likely they are to buy right now."],
  today: ["Today's Leads", "Companies found in the news that aren't in your database yet."],
  mine: ["My Outreach", "Leads you've claimed. Everyone can see them; only you own them."],
};

function actionBar() {
  const [title, desc] = PAGE_COPY[state.tab] || ["Leads", ""];
  const run = state.lastRun;

  return `
    <div class="action-bar">
      <div class="action-bar-left">
        <h1 class="page-title">${esc(title)}</h1>
        <p class="page-desc">${esc(desc)}</p>
        <p class="scan-status">
          <span class="scan-dot"></span>
          ${
            run && run.finished_at
              ? `Last scan ${esc(timeAgo(run.finished_at))} · ${run.new_signals} new signal${
                  run.new_signals === 1 ? "" : "s"
                }`
              : "No scan yet — one starts when you sign in"
          }
        </p>
      </div>
      ${
        state.tab === "all" && state.user.role === "admin"
          ? `<div class="action-bar-right">
               <input type="file" id="ab-csv" accept=".csv,text/csv" class="upload-input" />
               <button class="btn" id="ab-upload">${uploadIcon()} Add more companies (CSV)</button>
               <button class="btn btn-primary" id="ab-scan" ${state.scanning ? "disabled" : ""}>
                 ${scanIcon()} ${state.scanning ? "Scanning…" : "Scan for signals"}
               </button>
             </div>`
          : ""
      }
    </div>`;
}

function filterBar() {
  const typeOptions = SIGNAL_TYPES.map(
    ([v, l]) => `<option value="${v}">${esc(l)}</option>`
  ).join("");

  return `
    <div class="filter-bar">
      <input class="search-input" id="f-search" type="search"
             placeholder="Search company name…" value="${esc(state.search)}" />

      <span class="filter-label">Min score</span>
      <select class="filter-select" id="f-min">
        <option value="0">Any</option>
        <option value="40">40+</option>
        <option value="60">60+ (Warm)</option>
        <option value="80">80+ (Hot)</option>
      </select>

      <span class="filter-label">Signal</span>
      <select class="filter-select" id="f-type">
        <option value="">Any</option>
        ${typeOptions}
      </select>

      <span class="filter-label">Sort</span>
      <select class="filter-select" id="f-sort">
        <option value="score">Highest score</option>
        <option value="score_asc">Lowest score</option>
        <option value="recent">Newest signal</option>
        <option value="added">Recently added</option>
        <option value="company">Company name (A–Z)</option>
      </select>
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
    : state.tab === "mine"
    ? `<div class="mylead-grid">${leads.map(myLeadCard).join("")}</div>`
    : leadTable(leads);

  content.innerHTML = actionBar() + filterBar() + body;

  // Restore the control values — innerHTML wipes them every render.
  $("#f-min").value = String(state.minScore);
  $("#f-type").value = [...state.types][0] || "";
  $("#f-sort").value = state.sort;

  if (opts.keepFocus) {
    const el = $("#" + opts.keepFocus);
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }

  content.querySelectorAll("[data-lead]").forEach(() => {});   // no-op, kept for clarity
  wireListActions();
}

/** All Leads and Today's Leads: a scannable table, signals hidden behind Inspect. */
function leadTable(leads) {
  return `
    <div class="lead-table-wrap">
      <div class="lead-row-head">
        <span>Company</span><span>Score</span><span>Top signal</span><span></span>
      </div>
      ${leads
        .map(
          (lead) => `
        <div class="lead-row" data-lead="${lead.id}">
          <div class="company-cell">
            <span class="company-name">${esc(lead.company)}</span>
            <span class="company-meta">
              Added ${esc(shortDate(lead.added_at))}${
            lead.last_signal_at ? ` · Scanned ${esc(shortDate(lead.last_signal_at))}` : ""
          }
            </span>
          </div>

          <div>${scoreBadge(lead.score)}</div>

          <div class="signal-cell">
            ${
              lead.top_signal
                ? `<span class="type-tag type-${esc(lead.top_signal.signal_type)}">${esc(
                    typeLabel(lead.top_signal.signal_type)
                  )}</span>
                   <span class="signal-title">${esc(lead.top_signal.title || "Untitled")}</span>`
                : `<span class="signal-none">Scan to find signals</span>`
            }
          </div>

          <div class="row-actions">
            <button class="btn btn-ghost btn-sm" data-act="open" data-id="${lead.id}">Inspect</button>
            ${
              lead.owner_id === state.user.id
                ? `<button class="btn btn-sm" data-act="release" data-id="${lead.id}">Release</button>`
                : `<button class="btn btn-sm" data-act="claim" data-id="${lead.id}">${
                    lead.owner_id ? "Take over" : "Add to My Leads"
                  }</button>`
            }
          </div>
        </div>`
        )
        .join("")}
    </div>`;
}

/** My Outreach: the working view — signals, what to pitch, stage, contacts. */
function myLeadCard(lead) {
  const signals = lead.signals || [];

  return `
    <div class="mylead-card" data-lead="${lead.id}">
      <div class="mylead-top">
        <div class="mylead-heading">
          <div class="company-name">
            ${esc(lead.company)}
            ${lead.new_count > 0 ? `<span class="new-pill">${lead.new_count} new</span>` : ""}
          </div>
          <div class="mylead-meta">
            ${lead.signal_count} signal${lead.signal_count === 1 ? "" : "s"}${
    lead.last_signal_at ? ` · Last scanned ${esc(shortDate(lead.last_signal_at))}` : " · Not scanned yet"
  }
          </div>
        </div>
        ${scoreBadge(lead.score)}
      </div>

      <div class="mylead-signals">
        <div class="signal-list-label">Signals</div>
        ${
          signals.length
            ? signals
                .map(
                  (sig) => `
          <div class="mylead-signal-row">
            <div class="mylead-signal-row-top">
              <span class="type-tag type-${esc(sig.signal_type)}">${esc(typeLabel(sig.signal_type))}</span>
              <span class="mylead-signal-date">${esc(timeAgo(sig.published || sig.created_at))}</span>
            </div>
            <a class="mylead-signal-title" href="${esc(sig.url)}" target="_blank" rel="noopener">${esc(
                    sig.title || "Untitled"
                  )}</a>
          </div>`
                )
                .join("")
            : `<div class="signal-none">Nothing yet — the next scan will fill this in.</div>`
        }
        ${
          lead.signal_count > signals.length
            ? `<button class="btn btn-ghost btn-sm mylead-more" data-act="open" data-id="${lead.id}">Show all ${lead.signal_count}</button>`
            : ""
        }
      </div>

      ${lead.pitch ? `<div class="pitch-box"><b>What to pitch</b>${esc(lead.pitch)}</div>` : ""}

      <div class="mylead-bottom">
        <button class="btn btn-sm" data-act="open" data-id="${lead.id}">
          ${lead.contact_name ? esc(lead.contact_name) : "+ Add contact"}
        </button>
        <div class="stage-block">
          <span class="filter-label">Execution stage</span>
          <select class="filter-select stage-select" data-stage-for="${lead.id}">
            ${STATUSES.map(
              ([v, l]) => `<option value="${v}" ${v === lead.status ? "selected" : ""}>${esc(l)}</option>`
            ).join("")}
          </select>
        </div>
      </div>

      <div class="mylead-actions">
        <button class="btn btn-ghost btn-sm" data-act="open" data-id="${lead.id}">View raw signals</button>
        <button class="btn btn-ghost btn-sm release-trigger" data-act="release" data-id="${lead.id}">Release lead</button>
      </div>
    </div>`;
}

function wireListActions() {
  const content = $("#content");

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
        toast(`${r.companiesAdded} new compan${r.companiesAdded === 1 ? "y" : "ies"}, ${r.contactsAdded} new contacts`);
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
        toast("Scanning — this takes a few minutes");
        pollRun();
      } catch (err) {
        state.scanning = false;
        toast(err.message, true);
        renderContent();
      }
    });
  }

  content.querySelectorAll("[data-stage-for]").forEach((sel) => {
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

/** Watches a running cycle so the button and counts settle on their own. */
function pollRun() {
  clearInterval(state.runPoll);
  state.runPoll = setInterval(async () => {
    try {
      const { run } = await api("/api/stats");
      if (!run.running) {
        clearInterval(state.runPoll);
        state.scanning = false;
        state.lastRun = run.last;
        toast("Scan finished");
        refresh();
      }
    } catch {
      clearInterval(state.runPoll);
      state.scanning = false;
    }
  }, 4000);
}

function scoreBadge(n) {
  return `<span class="score ${scoreClass(n)}">${n}<small>score</small></span>`;
}

function shortDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function uploadIcon() {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 16V4M12 4l-4 4M12 4l4 4M5 18v1a2 2 0 002 2h10a2 2 0 002-2v-1"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function scanIcon() {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="2"/>
    <path d="M4 8V6a2 2 0 012-2h2M20 8V6a2 2 0 00-2-2h-2M4 16v2a2 2 0 002 2h2M20 16v2a2 2 0 01-2 2h-2"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
}

function emptyState() {
  const div = document.createElement("div");
  div.className = "empty";

  const copy = {
    today: [
      "No new companies found yet",
      "A scan runs when you sign in. Companies found in the news that aren't in your database will land here for you to approve.",
    ],
    all: [
      "Nothing in your database yet",
      "Upload your contact sheet from the Admin tab and every company in it becomes a lead, with its people attached.",
    ],
    mine: [
      "You haven't claimed anything yet",
      "Open All Leads and claim the ones you want to own. They'll collect here.",
    ],
  }[state.tab] || ["Nothing here yet", ""];

  div.innerHTML = `<h2>${esc(copy[0])}</h2><p>${esc(copy[1])}</p>`;

  if (state.tab !== "today") {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = "Clear filters";
    btn.addEventListener("click", () => $("#clear-filters").click());
    div.appendChild(btn);
  }
  return div;
}

// ── Lead card ──────────────────────────────────────────────────────────────

async function onCardClick(e) {
  const actionBtn = e.target.closest("[data-act]");
  if (actionBtn) {
    e.stopPropagation();
    const id = actionBtn.dataset.id;
    if (actionBtn.dataset.act === "open") return openDrawer(id);
    try {
      await api(`/api/leads/${id}/claim`, {
        method: "POST",
        body: { release: actionBtn.dataset.act === "release" },
      });
      toast(actionBtn.dataset.act === "release" ? "Released" : "Claimed");
      refresh();
    } catch (err) { toast(err.message, true); }
    return;
  }

  const row = e.target.closest("[data-lead]");
  if (row) openDrawer(row.dataset.lead);
}

// ── Drawer ─────────────────────────────────────────────────────────────────

/** The firmographics panel — everything the CSV knew about the company. */
function companyInfoCard(lead) {
  const rows = [
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

    ${companyInfoCard(lead)}

    ${lead.pitch ? `<div class="pitch-box"><b>What to pitch</b>${esc(lead.pitch)}</div>` : ""}

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
            <span class="type-tag type-${esc(s.signal_type)}">${esc(typeLabel(s.signal_type))}</span>
            <span class="score ${scoreClass(s.score)}" style="float:right">${s.score}<small>score</small></span>
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

    if (btn.dataset.userToggle)
      return guard(() =>
        api(`/api/admin/users/${btn.dataset.userToggle}`, {
          method: "PATCH",
          body: { active: btn.dataset.active === "1" },
        })
      );
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
