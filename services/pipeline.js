require("dotenv").config();

const db = require("../db");
const genericScraper = require("../scrapers/genericScraper");
const discoveryScraper = require("../scrapers/discoveryScraper");
const { enrichArticles, enrichDiscoveries } = require("./enrich");
const playbook = require("../lib/triggers");

const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 500);
// One query now spans every source, so it should return more than a single
// source's worth of articles.
const RESULTS_PER_QUERY = Number(process.env.RESULTS_PER_QUERY || 40);

// Only one run at a time - the API has rate limits and Gemini costs money.
let currentRun = null;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function isRunning() {
  return currentRun !== null;
}

function runState() {
  return currentRun ? { ...currentRun } : null;
}

/** Cross-multiplies active sites x active companies, exactly like build.js did. */
async function buildQueries() {
  const [companies, sites, topicRows] = await Promise.all([
    db.all("SELECT * FROM companies WHERE active ORDER BY name"),
    db.all("SELECT * FROM sites WHERE active ORDER BY name"),
    db.all("SELECT keyword FROM topics WHERE active"),
  ]);

  const topics = topicRows.map((t) => t.keyword);
  const sourceUris = sites.map((s) => s.domain);
  const configs = [];

  // One query per company across every source, rather than the cross-product.
  // 16 companies x 23 sources was 368 API calls a scan; this is 16.
  for (const company of companies) {
    let keywords = company.keywords;              // jsonb comes back parsed
    if (typeof keywords === "string") {
      try {
        keywords = JSON.parse(keywords);
      } catch {
        keywords = [company.name];
      }
    }
    if (!Array.isArray(keywords) || keywords.length === 0) keywords = [company.name];

    configs.push({
      name: company.name,
      company: company.name,
      companyId: company.id,
      sourceUris,
      companyKeyword: keywords,
      topics,
      size: RESULTS_PER_QUERY,
      lang: "eng",
    });
  }

  return configs;
}

/** Every company on the watchlist gets a lead row, created on first sight. */
async function ensureLead(companyId) {
  const row = await db.one(
    `INSERT INTO leads (company_id) VALUES ($1)
     ON CONFLICT (company_id) DO UPDATE SET company_id = EXCLUDED.company_id
     RETURNING id`,
    [companyId]
  );
  return row.id;
}

async function backfillLeads() {
  await db.run(
    `INSERT INTO leads (company_id)
     SELECT id FROM companies ON CONFLICT (company_id) DO NOTHING`
  );
}


// ── Discovery ───────────────────────────────────────────────────────────────

/**
 * The Fresh Leads sweep.
 *
 * The watchlist cycle can only ever find companies you already named. This one
 * queries the same sources by business-event keyword with no company filter,
 * has Gemini name the company behind each story, and files anything new as a
 * pending company an admin can approve onto the watchlist.
 *
 * Discovery uses EVERY keyword in the topics table, not just the active ones -
 * the active flag narrows the watchlist sweep, but here the keywords are the
 * only thing defining what counts as a business event worth surfacing.
 */
async function runDiscovery(runId, log = console.log, counters = null) {
  const [sites, topicRows] = await Promise.all([
    db.all("SELECT * FROM sites WHERE active ORDER BY name"),
    db.all("SELECT keyword FROM topics"),
  ]);

  // The playbook's phrases are what actually define a buying signal; anything
  // in the topics table is treated as an extra the user added by hand.
  // NewsAPI counts every WORD in the query against the plan's limit, so the
  // full playbook (185 words) is rejected outright. Discovery uses compact
  // single-word terms and splits them into queries that fit the budget.
  const budget = Number(process.env.DISCOVERY_TERM_BUDGET || 15);
  const extra = topicRows.map((t) => t.keyword).filter((k) => !/\s/.test(k));
  const terms = [...new Set([...playbook.discoveryTerms(), ...extra])];
  const groups = playbook.chunkTerms(terms, budget);

  if (!sites.length || !groups.length) {
    log("[discover] Needs at least one active source and one keyword. Skipping.");
    return 0;
  }
  if (!process.env.GEMINI_API_KEY) {
    log("[discover] GEMINI_API_KEY not set - discovery can't identify companies. Skipping.");
    return 0;
  }

  // Everything we already know about, so we don't re-file it as a discovery.
  const known = new Map();
  for (const c of await db.all("SELECT id, name, approval FROM companies")) {
    known.set(c.name.toLowerCase(), c);
  }

  const articles = [];
  const seen = new Set();

  // One query per term group. Each is a legal query on its own; together they
  // cover the whole playbook without ever exceeding the word budget.
  log(`[discover] ${terms.length} terms across ${groups.length} quer${groups.length === 1 ? "y" : "ies"} (budget ${budget} words each)`);

  for (const group of groups) {
    try {
      const found = await discoveryScraper({
        site: "all",
        sourceUris: sites.map((s) => s.domain),
        topics: group,
        size: Number(process.env.DISCOVERY_PER_SITE || 60),
        sinceHours: Number(process.env.DISCOVERY_WINDOW_HOURS || 48),
      });

      let added = 0;
      for (const a of found) {
        if (!a.url || seen.has(a.url)) continue;
        seen.add(a.url);
        articles.push(a);
        added++;
      }
      log(`[discover] "${group.slice(0, 4).join(", ")}…" returned ${found.length}, ${added} new`);
    } catch (err) {
      if (counters) counters.errors += 1;
      log(`[discover] sweep failed: ${err.message}`);
    }
    await delay(REQUEST_DELAY_MS);
  }

  if (!articles.length) {
    log("[discover] Nothing came back.");
    return 0;
  }

  // Drop anything already stored before spending Gemini calls on it.
  const existing = await db.all("SELECT url FROM signals WHERE url = ANY($1)", [
    articles.map((a) => a.url),
  ]);
  const storedUrls = new Set(existing.map((r) => r.url));
  const fresh = articles.filter((a) => !storedUrls.has(a.url));

  log(`[discover] ${articles.length} articles, ${fresh.length} new. Identifying companies...`);
  if (!fresh.length) return 0;

  const results = await enrichDiscoveries(fresh, log);

  let stored = 0;
  let newCompanies = 0;

  for (let i = 0; i < fresh.length; i++) {
    const article = fresh[i];
    const e = results[i] || {};
    if (!e.company) continue;
    // Same rule as the watchlist sweep: no trigger, no signal.
    if (!e.signal_type || e.signal_type === "none") continue;                       // couldn't name it - drop it

    const key = e.company.toLowerCase();
    let company = known.get(key);

    if (company && company.approval === "rejected") continue;   // told once, don't ask again

    if (!company) {
      // New name. File it as pending and inactive: it shows in Fresh Leads
      // straight away but isn't scanned daily until someone approves it.
      const row = await db.one(
        `INSERT INTO companies (name, keywords, active, origin, approval)
         VALUES ($1, $2::jsonb, false, 'discovered', 'pending')
         ON CONFLICT (lower(name)) DO UPDATE SET name = companies.name
         RETURNING id, name, approval`,
        [e.company, JSON.stringify([e.company])]
      );
      company = row;
      known.set(key, row);
      newCompanies += 1;
    }

    const leadId = await ensureLead(company.id);

    const res = await db.run(
      `INSERT INTO signals
         (lead_id, company, title, url, author, published, site, section_title,
          body, summary, why_it_matters, pitch, signal_type, score, enriched, run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (url) DO NOTHING`,
      [
        leadId,
        company.name,
        article.title || null,
        article.url,
        article.author || null,
        article.published || null,
        article.site || null,
        article.section_title || null,
        (article.body || "").slice(0, 8000) || null,
        e.summary || null,
        e.why_it_matters || null,
        e.pitch || null,
        e.signal_type || "none",
        Number.isFinite(e.score) ? e.score : 40,
        Boolean(e.enriched),
        runId,
      ]
    );
    stored += res;
  }

  log(`[discover] ${stored} signals stored, ${newCompanies} new companies pending approval.`);
  return stored;
}

/**
 * Run the full cycle.
 * @param {string} trigger  'manual' | 'schedule' | 'startup'
 * @param {function} log
 */
async function runPipeline(trigger = "manual", log = console.log) {
  if (isRunning()) {
    throw new Error("A scrape is already running. Wait for it to finish.");
  }

  const runRow = await db.one("INSERT INTO runs (trigger) VALUES ($1) RETURNING id", [trigger]);
  const runId = runRow.id;

  const queries = await buildQueries();
  currentRun = {
    id: runId,
    trigger,
    startedAt: new Date().toISOString(),
    total: queries.length,
    done: 0,
    fetched: 0,
    newSignals: 0,
    errors: 0,
  };

  await backfillLeads();

  if (queries.length === 0) {
    await finishRun(runId, currentRun, "done", "Nothing to run - add a company and a source first.");
    const snapshot = runState();
    currentRun = null;
    return snapshot;
  }

  log(`[run ${runId}] ${queries.length} queries (${trigger})`);

  const candidates = [];
  const seenThisRun = new Set();

  try {
    for (const config of queries) {
      try {
        const articles = await genericScraper(config);
        currentRun.fetched += articles.length;

        for (const article of articles) {
          if (!article.url) continue;
          if (seenThisRun.has(article.url)) continue;
          seenThisRun.add(article.url);
          candidates.push(article);
        }
      } catch (err) {
        currentRun.errors += 1;
        log(`[run ${runId}] ${config.name} failed: ${err.message}`);
      }

      currentRun.done += 1;
      await delay(REQUEST_DELAY_MS);
    }

    // One round trip to find everything we already have, rather than a query
    // per article - matters a lot over a pooled remote connection.
    let fresh = [];
    if (candidates.length) {
      const known = await db.all("SELECT url FROM signals WHERE url = ANY($1)", [
        candidates.map((a) => a.url),
      ]);
      const knownUrls = new Set(known.map((r) => r.url));
      fresh = candidates.filter((a) => !knownUrls.has(a.url));
    }

    log(`[run ${runId}] ${currentRun.fetched} fetched, ${fresh.length} new after dedupe.`);

    if (fresh.length > 0) {
      const enrichment = await enrichArticles(fresh, log);
      currentRun.newSignals = await saveSignals(fresh, enrichment, runId);
    }

    // Fresh Leads is news about companies already in the database, so the
    // portal no longer hunts for unknown companies. The sweep is kept behind a
    // flag rather than deleted, in case that changes back.
    if (process.env.DISCOVERY_ENABLED === "true") {
      currentRun.phase = "discovery";
      try {
        currentRun.newSignals += await runDiscovery(runId, log, currentRun);
      } catch (err) {
        currentRun.errors += 1;
        log(`[discover] Sweep failed: ${err.message}`);
      }
    }

    await recomputeLeadRollups();
    await finishRun(runId, currentRun, "done", null);
    log(`[run ${runId}] Done. ${currentRun.newSignals} new signals stored.`);
  } catch (err) {
    await finishRun(runId, currentRun, "failed", err.message);
    log(`[run ${runId}] Failed: ${err.message}`);
    currentRun = null;
    throw err;
  }

  const snapshot = runState();
  currentRun = null;
  return snapshot;
}

async function saveSignals(articles, enrichment, runId) {
  // Map company -> lead once, instead of per article.
  const leadIds = new Map();
  for (const article of articles) {
    if (!leadIds.has(article.companyId)) {
      leadIds.set(article.companyId, await ensureLead(article.companyId));
    }
  }

  let inserted = 0;

  await db.tx(async (q) => {
    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      const e = enrichment[i] || {};

      // An article with no buying trigger is noise: it inflates the counts,
      // dilutes the tier and gives a salesperson nothing to act on. Drop it
      // rather than storing it to be filtered out later.
      if (!e.signal_type || e.signal_type === "none") continue;

      const result = await q(
        `INSERT INTO signals
           (lead_id, company, title, url, author, published, site, section_title,
            body, summary, why_it_matters, pitch, signal_type, score, enriched, run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (url) DO NOTHING`,
        [
          leadIds.get(article.companyId),
          article.company,
          article.title || null,
          article.url,
          article.author || null,
          article.published || null,
          article.site || null,
          article.section_title || null,
          (article.body || "").slice(0, 8000) || null,
          e.summary || null,
          e.why_it_matters || null,
          e.pitch || null,
          e.signal_type || "none",
          Number.isFinite(e.score) ? e.score : 40,
          Boolean(e.enriched),
          runId,
        ]
      );
      inserted += result.rowCount;
    }
  });

  return inserted;
}

/**
 * Keeps leads.last_signal_at and leads.score in sync with their signals.
 *
 * The score is the sum of the distinct triggers a company has shown in the
 * last 30 days (see scoreBreakdown), not the maximum article score — a company
 * that raised money AND launched a product is a better lead than one that only
 * did one of those, and the number should say so.
 */
async function recomputeLeadRollups() {
  await db.run(
    `UPDATE leads l
        SET last_signal_at = agg.last_at
       FROM (
         SELECT le.id, MAX(COALESCE(s.published, s.created_at)) AS last_at
           FROM leads le LEFT JOIN signals s ON s.lead_id = le.id
          GROUP BY le.id
       ) agg
      WHERE agg.id = l.id`
  );

  // Distinct trigger per lead inside the window; the weights live in the
  // playbook so the number on screen always matches the breakdown beside it.
  const rows = await db.all(
    `SELECT lead_id, signal_type, MAX(score) AS score
       FROM signals
      WHERE COALESCE(published, created_at) >= now() - interval '30 days'
      GROUP BY lead_id, signal_type`
  );

  const byLead = new Map();
  for (const r of rows) {
    if (!byLead.has(r.lead_id)) byLead.set(r.lead_id, []);
    byLead.get(r.lead_id).push({ signal_type: r.signal_type, score: r.score });
  }

  await db.run("UPDATE leads SET score = 0 WHERE score <> 0 AND id <> ALL($1)", [
    [...byLead.keys()],
  ]);

  for (const [leadId, types] of byLead) {
    const { total } = playbook.scoreBreakdown(types);
    await db.run("UPDATE leads SET score = $1 WHERE id = $2 AND score IS DISTINCT FROM $1", [
      total,
      leadId,
    ]);
  }
}

function finishRun(runId, state, status, message) {
  return db.run(
    `UPDATE runs
        SET status = $1, queries = $2, fetched = $3, new_signals = $4, errors = $5,
            message = $6, finished_at = now()
      WHERE id = $7`,
    [status, state.total, state.fetched, state.newSignals, state.errors, message, runId]
  );
}

module.exports = {
  runPipeline,
  runDiscovery,
  buildQueries,
  isRunning,
  runState,
  recomputeLeadRollups,
  ensureLead,
};
