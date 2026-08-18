const axios = require("axios");
require("dotenv").config();

const NEWSAPI_URL = "https://eventregistry.org/api/v1/article/getArticles";

/**
 * Discovery sweep: everything newsworthy from one source, with no company
 * filter at all.
 *
 * The watchlist scraper asks "what is being said about Meesho?". This one asks
 * "what business events happened on livemint today?" and lets Gemini work out
 * which company each story is about. That's how Fresh Leads finds companies
 * nobody thought to add.
 *
 * config = {
 *   site:       "livemint",
 *   sourceUri:  "livemint.com",
 *   topics:     ["funding", "raises", "appoints", ...],   // required
 *   size:       20,
 *   sinceHours: 48,
 * }
 */
async function discoveryScraper(config) {
  const apiKey = process.env.NEWSAPI_AI_KEY;
  if (!apiKey) throw new Error("NEWSAPI_AI_KEY is missing - check your .env file");

  const topics = (config.topics || []).filter(Boolean);
  if (!topics.length) {
    throw new Error("Discovery needs at least one keyword to sweep for.");
  }

  const sources = config.sourceUris && config.sourceUris.length
    ? config.sourceUris
    : [config.sourceUri].filter(Boolean);

  const andConditions = [{ $or: topics.map((t) => ({ keyword: t })) }];

  if (sources.length === 1) andConditions.push({ sourceUri: sources[0] });
  else if (sources.length > 1) andConditions.push({ $or: sources.map((u) => ({ sourceUri: u })) });

  // Only look at the recent window - discovery is about what's happening now,
  // and an unbounded query burns API credits on old news.
  const since = new Date(Date.now() - (config.sinceHours || 48) * 3600e3);
  const dateStart = since.toISOString().slice(0, 10);

  let data;
  try {
    ({ data } = await axios.post(
    NEWSAPI_URL,
    {
      query: {
        $query: { $and: andConditions },
        $filter: { lang: config.lang || "eng", dateStart },
      },
      resultType: "articles",
      articlesSortBy: "date",
      articlesCount: config.size || 20,
      includeArticleImage: false,
      apiKey,
    },
      { headers: { "Content-Type": "application/json" }, timeout: 30000 }
    ));
  } catch (err) {
    // axios reports "Request failed with status code 403" and hides the body,
    // which is where Event Registry actually explains itself. Surface it.
    const res = err.response;
    if (res) {
      const body =
        typeof res.data === "string"
          ? res.data.slice(0, 300)
          : JSON.stringify(res.data || {}).slice(0, 300);
      const hint =
        res.status === 403
          ? " (403 usually means the NewsAPI.ai account is out of tokens, or the key is not authorised for this endpoint)"
          : res.status === 401
          ? " (401 means the key was rejected)"
          : "";
      throw new Error(`NewsAPI ${res.status}${hint}: ${body}`);
    }
    throw err;
  }

  if (data && data.error) {
    throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
  }

  const results = (data && data.articles && data.articles.results) || [];

  return results.map((post) => ({
    title: post.title ?? null,
    body: post.body ?? null,
    url: post.url ?? null,
    author: post.authors?.[0]?.name ?? null,
    published: post.dateTime ?? post.date ?? null,
    site: post.source?.title ?? post.source?.uri ?? null,
    section_title: post.categories?.[0]?.label ?? null,
    company: null,       // Gemini fills this in
    companyId: null,     // resolved once we know the company
  }));
}

module.exports = discoveryScraper;
