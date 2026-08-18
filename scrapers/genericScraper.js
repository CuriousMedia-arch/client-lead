const axios = require("axios");
require("dotenv").config();

const NEWSAPI_URL = "https://eventregistry.org/api/v1/article/getArticles";

const DEFAULTS = {
  size: 10,
  lang: "eng",
};

/**
 * Fetch articles from NewsAPI.ai (Event Registry) for ONE company across ALL
 * sources in a single request.
 *
 * This used to be one call per company per source. With 16 companies and 23
 * sources that was 368 calls a scan, which burns API credits for no benefit —
 * Event Registry lets you OR the sources into one query, so it's now one call
 * per company and the results carry which source each article came from.
 *
 * config = {
 *   company:        "Meesho",
 *   companyId:      3,
 *   sourceUris:     ["livemint.com", "afaqs.com", ...],
 *   companyKeyword: ["Meesho"],       // accepted name variants
 *   topics:         ["funding", ...], // optional narrowing keywords
 *   size:           40,
 * }
 *
 * Returns a plain array of article objects (never throws for "no results").
 */
async function genericScraper(config) {
  const apiKey = process.env.NEWSAPI_AI_KEY;
  if (!apiKey) {
    throw new Error("NEWSAPI_AI_KEY is missing - check your .env file");
  }

  const size = config.size || DEFAULTS.size;
  const lang = config.lang || DEFAULTS.lang;

  const companyKeywords = Array.isArray(config.companyKeyword)
    ? config.companyKeyword
    : [config.companyKeyword];

  const companyCondition =
    companyKeywords.length > 1
      ? { $or: companyKeywords.map((k) => ({ keyword: k })) }
      : { keyword: companyKeywords[0] };

  // One or many sources, OR-ed together into a single request.
  const sources = config.sourceUris && config.sourceUris.length
    ? config.sourceUris
    : [config.sourceUri].filter(Boolean);

  const andConditions = [companyCondition];

  if (sources.length === 1) andConditions.push({ sourceUri: sources[0] });
  else if (sources.length > 1) andConditions.push({ $or: sources.map((u) => ({ sourceUri: u })) });

  if (config.topics && config.topics.length > 0) {
    andConditions.push({ $or: config.topics.map((t) => ({ keyword: t })) });
  }

  const query = {
    $query: { $and: andConditions },
    $filter: { lang },
  };

  let data;
  try {
    ({ data } = await axios.post(
    NEWSAPI_URL,
    {
      query,
      resultType: "articles",
      articlesSortBy: "date",
      articlesCount: size,
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
    site: post.source?.title ?? post.source?.uri ?? config.site ?? null,
    section_title: post.categories?.[0]?.label ?? null,
    company: config.company,
    companyId: config.companyId,
  }));
}

module.exports = genericScraper;
