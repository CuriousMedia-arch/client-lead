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

  const andConditions = [
    { $or: topics.map((t) => ({ keyword: t })) },
    { sourceUri: config.sourceUri },
  ];

  // Only look at the recent window - discovery is about what's happening now,
  // and an unbounded query burns API credits on old news.
  const since = new Date(Date.now() - (config.sinceHours || 48) * 3600e3);
  const dateStart = since.toISOString().slice(0, 10);

  const { data } = await axios.post(
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
  );

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
    site: post.source?.title ?? post.source?.uri ?? config.sourceUri,
    section_title: post.categories?.[0]?.label ?? null,
    company: null,       // Gemini fills this in
    companyId: null,     // resolved once we know the company
  }));
}

module.exports = discoveryScraper;
