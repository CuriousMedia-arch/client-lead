const gemini = require("../lib/gemini");
require("dotenv").config();

const playbook = require("../lib/triggers");

const MODEL = gemini.MODEL;
const BATCH_SIZE = 6;

const SIGNAL_TYPES = playbook.SEGMENT_IDS;

// Kept for anything still importing it; the playbook owns the real weights now.
const TYPE_WEIGHT = Object.fromEntries(playbook.SEGMENTS.map((x) => [x.id, x.score]));

/**
 * Cheap, offline classification. Used when Gemini is unavailable, out of quota,
 * or returns something unusable - the platform must keep working either way.
 */
function classifyOffline(article) {
  const { id, score } = playbook.classify(
    `${article.title || ""} ${(article.body || "").slice(0, 1200)}`
  );

  const summary = (article.body || article.title || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);

  return {
    signal_type: id,
    score,
    summary: summary || null,
    why_it_matters: null,
  };
}

/**
 * Parse whatever the model returned as JSON.
 *
 * Models wrap JSON in ```json fences, add a sentence of preamble, or trail a
 * closing remark — even when told not to. Rather than fail the whole batch on
 * a stray character, strip the usual wrappers and, failing that, take the
 * outermost array or object in the text.
 */
function safeJson(text) {
  if (!text) return null;

  let body = String(text).trim();

  // ```json … ``` or ``` … ```
  body = body.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  try {
    return JSON.parse(body);
  } catch {
    // Fall back to the widest bracketed span in the response.
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf("]"), body.lastIndexOf("}"));
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function buildPrompt(articles) {
  const block = articles
    .map((a, i) =>
      [
        `--- Article ${i + 1} ---`,
        `Company: ${a.company}`,
        `Title: ${a.title || "N/A"}`,
        `Published: ${a.published || "N/A"}`,
        `Source: ${a.site || "N/A"}`,
        "",
        (a.body || "").replace(/\s+/g, " ").slice(0, 2500),
      ].join("\n")
    )
    .join("\n\n");

  return `You work on the new-business team at a marketing agency. You read business news and decide which stories are worth a sales conversation.

For each article below, return one object with these fields:
- "index": the article number (1-based integer)
- "about_company": true only if the article is genuinely ABOUT this company. False if the company is only mentioned in passing, quoted, listed in a roundup, or named as an investor in someone else's story.
- "signal_type": exactly one of these, using the agency's own playbook:
${playbook.promptRules()}
- "summary": 2 sentences, plain English, concrete. Include numbers, names and dates where the article gives them.
- "why_it_matters": 1 sentence on the marketing opening this creates for an agency pitching this company (new budget, new launch to promote, new decision-maker, new market to enter). If there is no real opening, say so.
- "pitch": 2 sentences the salesperson could open the call with. Take the agency angle listed above for the signal_type you chose and apply it to THIS company and THIS specific news — name the amount, product, city, person, campaign or store count the article actually mentions, and say concretely what you would do for them. Never write it generically: if the same sentence would work for any other company, rewrite it.
- "score": integer 0-100 within the tier — Tier 1 signals belong in 80-100, Tier 2 in 50-79, Tier 3 below 40 for how urgently a salesperson should act on this. 80+ means call them this week. Under 40 means background noise.

Return ONLY a JSON array. No prose, no markdown fences.

${block}`;
}

async function enrichBatch(articles) {
  const raw = await gemini.generate(buildPrompt(articles));
  const parsed = safeJson(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Gemini returned unparseable JSON: ${String(raw).slice(0, 120)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("Gemini returned unparseable JSON");

  const byIndex = new Map();
  for (const row of parsed) {
    const idx = Number(row.index);
    if (Number.isFinite(idx)) byIndex.set(idx, row);
  }

  return articles.map((article, i) => {
    const row = byIndex.get(i + 1);
    if (!row) return { ...classifyOffline(article), enriched: 0 };

    // The news API matches any article mentioning the company, so roundups and
    // investor name-drops come back too. Gemini tells us which are actually
    // about them; the rest are demoted rather than dropped, so they stay
    // visible under Raw signals without polluting the tier.
    const relevant = row.about_company !== false;

    const type = relevant
      ? SIGNAL_TYPES.includes(row.signal_type) ? row.signal_type : "none"
      : "none";

    const score = !relevant
      ? 15
      : Number.isFinite(Number(row.score))
      ? Math.max(0, Math.min(100, Math.round(Number(row.score))))
      : TYPE_WEIGHT[type];

    return {
      pitch: relevant && row.pitch ? String(row.pitch).trim() : null,
      signal_type: type,
      score,
      summary: row.summary ? String(row.summary).trim() : null,
      why_it_matters: row.why_it_matters ? String(row.why_it_matters).trim() : null,
      enriched: 1,
    };
  });
}

/**
 * Enrich a list of articles. Always resolves with one result per input article,
 * in the same order. Never throws.
 */
async function enrichArticles(articles, log = console.log) {
  if (!articles || articles.length === 0) return [];

  if (!process.env.GEMINI_API_KEY) {
    log("[enrich] No GEMINI_API_KEY set - using keyword classification.");
    return articles.map((a) => ({ ...classifyOffline(a), enriched: 0 }));
  }

  const out = [];
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    try {
      log(`[enrich] ${MODEL}: batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} articles)`);
      out.push(...(await enrichBatch(batch)));
    } catch (err) {
      log(`[enrich] Batch failed (${err.message}) - falling back to keywords.`);
      out.push(...batch.map((a) => ({ ...classifyOffline(a), enriched: 0 })));
    }
  }
  return out;
}

// ── Discovery enrichment ────────────────────────────────────────────────────

/**
 * Discovery articles arrive with no company attached - the sweep didn't filter
 * by one. So this prompt asks Gemini to name the subject company as well as do
 * the usual classification.
 *
 * "Which company is this about?" is genuinely ambiguous in business news: a
 * funding story names the startup, the lead investor, and three other
 * portfolio companies. We want the one the story is ABOUT, and we want it
 * dropped entirely when the answer is a person, a government body, or a
 * market-wide piece - those aren't leads.
 */
function buildDiscoveryPrompt(articles) {
  const block = articles
    .map((a, i) =>
      [
        `--- Article ${i + 1} ---`,
        `Title: ${a.title || "N/A"}`,
        `Published: ${a.published || "N/A"}`,
        `Source: ${a.site || "N/A"}`,
        "",
        (a.body || "").replace(/\s+/g, " ").slice(0, 2500),
      ].join("\n")
    )
    .join("\n\n");

  return `You work on the new-business team at a marketing agency. You read business news to find companies worth pitching.

For each article below, return one object with these fields:
- "index": the article number (1-based integer)
- "company": the ONE company the story is primarily about, as a clean brand name ("Zomato", not "Zomato Ltd." or "Zomato's"). This is the company a salesperson would call. NOT the investor, NOT the acquirer's target if the story is about the acquirer, NOT a company merely mentioned in passing. If the story is about a person, a government body, a whole sector, a sports match, or is not about a specific company at all, use null.
- "signal_type": exactly one of these, using the agency's own playbook:
${playbook.promptRules()}
- "summary": 2 sentences, plain English, concrete. Include numbers, names and dates where the article gives them.
- "why_it_matters": 1 sentence on the marketing opening this creates for an agency pitching this company. If there is no real opening, say so.
- "pitch": 2 sentences the salesperson could open the call with. Take the agency angle listed above for the signal_type you chose and apply it to THIS company and THIS specific news — name the amount, product, city, person or campaign the article actually mentions, and say what you'd do for them. Never write it generically; if the same sentence would work for any company, rewrite it.
- "score": integer 0-100 within the tier — Tier 1 signals belong in 80-100, Tier 2 in 50-79, Tier 3 below 40 for how urgently a salesperson should act. 80+ means call them this week. Under 40 means background noise.

Be strict with "company". A wrong name creates a junk lead someone has to clean up. When in doubt, use null.

Return ONLY a JSON array. No prose, no markdown fences.

${block}`;
}

/** Strip the noise that turns one company into three near-duplicate rows. */
function cleanCompanyName(raw) {
  if (!raw) return null;
  let name = String(raw).trim().replace(/\s+/g, " ");
  if (!name || /^(null|none|n\/a|unknown|various)$/i.test(name)) return null;

  name = name
    .replace(/[''`]s\b/gi, "")
    .replace(/[.,;:]+$/, "")
    .replace(/\s+(pvt\.?|private)\s+(ltd\.?|limited)$/i, "")
    .replace(/\s+(ltd\.?|limited|inc\.?|llc|plc|corp\.?|corporation|co\.)$/i, "")
    .trim();

  // A "company" that's one letter or a whole sentence is a bad extraction.
  if (name.length < 2 || name.length > 60) return null;
  if (name.split(" ").length > 6) return null;
  return name;
}

async function enrichDiscoveryBatch(articles) {
  const raw = await gemini.generate(buildDiscoveryPrompt(articles));
  const parsed = safeJson(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Gemini returned unparseable JSON: ${String(raw).slice(0, 120)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("Gemini returned unparseable JSON");

  const byIndex = new Map();
  for (const row of parsed) {
    const idx = Number(row.index);
    if (Number.isFinite(idx)) byIndex.set(idx, row);
  }

  return articles.map((article, i) => {
    const row = byIndex.get(i + 1);
    if (!row) return { company: null, ...classifyOffline(article), enriched: 0 };

    const type = SIGNAL_TYPES.includes(row.signal_type) ? row.signal_type : "none";
    const score = Number.isFinite(Number(row.score))
      ? Math.max(0, Math.min(100, Math.round(Number(row.score))))
      : TYPE_WEIGHT[type];

    return {
      company: cleanCompanyName(row.company),
      pitch: row.pitch ? String(row.pitch).trim() : null,
      signal_type: type,
      score,
      summary: row.summary ? String(row.summary).trim() : null,
      why_it_matters: row.why_it_matters ? String(row.why_it_matters).trim() : null,
      enriched: 1,
    };
  });
}

/**
 * Same contract as enrichArticles, plus a `company` field on each result.
 * Results with company === null should be discarded by the caller.
 *
 * Unlike the watchlist path there is no offline fallback: keyword matching
 * can classify an article but it cannot reliably tell you whose story it is,
 * and a wrong guess creates junk leads. Without Gemini, discovery is skipped.
 */
async function enrichDiscoveries(articles, log = console.log) {
  if (!articles || articles.length === 0) return [];

  if (!process.env.GEMINI_API_KEY) {
    log("[discover] No GEMINI_API_KEY - discovery needs it to identify companies. Skipping.");
    return articles.map(() => ({ company: null, enriched: 0 }));
  }

  const out = [];
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    try {
      log(`[discover] ${MODEL}: batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} articles)`);
      out.push(...(await enrichDiscoveryBatch(batch)));
    } catch (err) {
      log(`[discover] Batch failed (${err.message}) - those articles are dropped.`);
      out.push(...batch.map(() => ({ company: null, enriched: 0 })));
    }
  }
  return out;
}

module.exports = {
  enrichArticles,
  enrichDiscoveries,
  classifyOffline,
  cleanCompanyName,
  SIGNAL_TYPES,
  TYPE_WEIGHT,
};

