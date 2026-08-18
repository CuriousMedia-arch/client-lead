/**
 * The Curious Media PFA playbook.
 *
 * This file is the single source of truth for what counts as a buying signal,
 * how urgent it is, what to pitch, and what the SDR does next. The news query,
 * the offline classifier, the Gemini prompt and the dashboard all read from
 * here — change the playbook in one place and the whole portal follows.
 */

const TIERS = {
  1: { label: "HOT", note: "Call today", rank: 1 },
  2: { label: "WARM", note: "Reach out this week", rank: 2 },
  3: { label: "LOW", note: "Drip email only", rank: 3 },
};

/**
 * Segment order matters: when an article matches more than one, the earlier
 * segment wins. Capital beats everything, because a funded company has budget
 * regardless of what else it announced that day.
 */
const SEGMENTS = [
  {
    id: "capital",
    angle: "Meme & Influencer Takeover",
    points: 40,
    label: "Funding & Capital",
    tier: 1,
    score: 95,
    trigger: "Funding raised (Seed / Series A/B/C), IPO or major growth milestone",
    why: "Fresh capital equals an immediate mandate to spend on customer acquisition and brand awareness.",
    action: "Instant dial — match against the contact database and WhatsApp/call the same day.",
    pitch:
      "rapidly scale top-of-funnel reach and lower customer acquisition cost for their post-funding growth targets, with UGC video building brand value.",
    keywords: [
      "raises", "secures", "bags", "closes funding", "infusion", "investment round",
      "seed round", "pre-series a", "series a", "series b", "series c", "growth round",
      "backed by", "led by", "participated by", "debt financing", "venture debt",
      "gears up for ipo", "files drhp", "pre-ipo round", "crosses arr", "targets gmv",
      "valuation", "funding round",
    ],
  },
  {
    id: "brand_launch",
    angle: "Creator UGC & Meme Surges",
    points: 30,
    label: "Launch & Ambassador",
    tier: 1,
    score: 90,
    trigger: "New product line, rebranding, or a celebrity / brand ambassador signing",
    why: "Every new collection, product line or ambassador deal requires mandatory distribution assets and viral momentum.",
    action: "Pitch the Meme + UGC creator bundle immediately, while the campaign is still being planned.",
    pitch:
      "amplify their new TVC or ambassador campaign through meme pages, turning high-budget ads into organic social conversation.",
    keywords: [
      "launches new", "unveils", "introduces", "rolls out", "enters new segment",
      "summer line", "festive collection", "d2c range", "new sku", "product revamp",
      "ropes in", "signs", "onboards", "as brand ambassador", "brand ambassador",
      "unveils new brand campaign", "launches tvc", "ad campaign",
      "rebrands", "unveils new logo", "new brand identity", "repositions itself",
    ],
  },
  {
    id: "retail_expansion",
    angle: "Curious Studios Retainer",
    points: 10,
    label: "Retail Expansion",
    tier: 1,
    score: 88,
    trigger: "New stores, flagship outlets or offline footprint growth",
    why: "Physical outlets need continuous footfall, localised content shoots and geo-targeted social engagement.",
    action: "Pitch the Curious Studios retainer — local shoot plus geo-targeted meme distribution.",
    pitch:
      "end-to-end in-store video shoots, local geo-targeted creator pushes, and Google Business / Instagram management to drive store footfall through community pages.",
    keywords: [
      "opens new store", "launches flagship outlet", "expands retail presence",
      "unveils experience centre", "inaugurates outlet", "offline expansion",
      "omnichannel push", "stores across", "to open stores", "new outlets",
      "partners with shoppers stop", "partners with lifestyle", "partners with reliance retail",
      "launches kiosk", "pop-up store", "shop-in-shop",
    ],
  },
  {
    id: "leadership",
    angle: "Introductory Credential Drop",
    points: 10,
    label: "Leadership Move",
    tier: 2,
    score: 68,
    trigger: "New CMO / marketing head, or an agency review",
    why: "A new marketing leader evaluates current performance and frequently tests new agencies within their first 90 days.",
    action: "Send the credentials deck with a congratulations note. No hard pitch yet.",
    pitch:
      "congratulations note, agency credentials, case studies, and a low-risk trial pilot package.",
    keywords: [
      "appoints", "names", "onboards", "elevates", "chief marketing officer", "cmo",
      "head of marketing", "vp growth", "brand director", "stepped down", "moves on from",
      "calls for multi-agency pitch", "reviews media mandate", "reviews creative mandate",
      "awards account to", "new ceo", "joins as",
    ],
  },
  {
    id: "crisis",
    angle: "Meme Sentiment Flipping",
    points: 10,
    label: "Brand Crisis",
    tier: 2,
    score: 62,
    trigger: "Backlash, trolling or negative PR",
    why: "Brands facing backlash need rapid sentiment repair and relatable narrative correction.",
    action: "Opportunistic outreach — lead with sentiment repair, and be tactful about the timing.",
    pitch:
      "culture-led positive meme campaigns and relatable UGC creators to neutralise negative social sentiment and push down negative posts.",
    keywords: [
      "faces backlash", "trolled on social media", "ad withdrawn", "clarifies statement",
      "boycott trend", "slammed for", "apologises", "under fire", "controversy",
    ],
  },
  {
    id: "none",
    angle: "No pitch yet",
    points: 0,
    label: "No clear trigger",
    tier: 3,
    score: 25,
    trigger: "Generic news or PR with no buying signal",
    why: "Nothing here suggests a budget decision is imminent.",
    action: "No SDR call. Leave it to the automated email drip.",
    pitch:
      "No strong buying trigger yet. Keep them on the drip and wait for a real signal before spending a call on them.",
    keywords: [],
  },
];

const BY_ID = new Map(SEGMENTS.map((s) => [s.id, s]));

/**
 * How a lead's score is built.
 *
 * Each distinct trigger the company has shown contributes its points ONCE,
 * however many articles reported it. Funding is worth the most because it is
 * the clearest sign of budget; a launch is next; the rest are supporting
 * evidence. The five weights add up to exactly 100, so a company showing every
 * trigger scores 100 and nothing needs an artificial cap.
 *
 *   Funding & Capital    40
 *   Launch & Ambassador  30
 *   Retail Expansion     10
 *   Leadership Move      10
 *   Brand Crisis         10
 *
 * The score answers "how much is going on here". The TIER, which decides how
 * urgently to call, comes from the single strongest trigger — so one funding
 * story is still HOT at 40 points.
 */
/**
 * Signals filed before the playbook existed used a different vocabulary.
 * Mapping them keeps old rows readable instead of showing a raw slug.
 */
const LEGACY = {
  funding: "capital",
  m_and_a: "capital",
  financials: "capital",
  launch: "brand_launch",
  partnership: "brand_launch",
  expansion: "retail_expansion",
  leadership: "leadership",
  other: "none",
};

function segment(id) {
  return BY_ID.get(id) || BY_ID.get(LEGACY[id]) || BY_ID.get("none");
}

const tierOf = (id) => segment(id).tier;
const tierLabel = (id) => TIERS[segment(id).tier].label;
const tierNote = (id) => TIERS[segment(id).tier].note;
const pitchFor = (id) => segment(id).pitch;
const angleFor = (id) => segment(id).angle;
const actionFor = (id) => segment(id).action;

/** Every keyword in the playbook — what the discovery sweep searches for. */
function allKeywords() {
  const out = new Set();
  for (const s of SEGMENTS) for (const k of s.keywords) out.add(k);
  return [...out];
}

/**
 * Keyword classification. Used when Gemini is unavailable or returns junk.
 * Scores by how many distinct playbook phrases hit, so "raises Series B led by
 * Sequoia" outranks a passing mention of the word "investment".
 */
function classify(text) {
  const hay = String(text || "").toLowerCase();

  let best = null;
  let bestHits = 0;

  for (const seg of SEGMENTS) {
    if (!seg.keywords.length) continue;
    const hits = seg.keywords.reduce((n, k) => (hay.includes(k) ? n + 1 : n), 0);
    if (hits > bestHits) {
      bestHits = hits;
      best = seg;
    }
  }

  if (!best) return { id: "none", score: 20, hits: 0 };

  const confidence = Math.min(bestHits, 3) / 3;
  const floor = best.tier === 1 ? 55 : best.tier === 2 ? 45 : 20;
  const score = Math.round(floor + (100 - floor) * confidence);

  return { id: best.id, score, hits: bestHits };
}

function scoreBreakdown(triggers) {
  const seen = new Map();

  // Keep the strongest story per trigger — that's what the points are based on.
  for (const t of triggers || []) {
    const raw = typeof t === "string" ? { signal_type: t } : t || {};
    const seg = segment(raw.signal_type);
    if (seg.id === "none") continue;

    const strength = Number.isFinite(Number(raw.score)) ? Number(raw.score) : 100;
    const existing = seen.get(seg.id);
    if (!existing || strength > existing.strength) {
      seen.set(seg.id, { seg, strength, title: raw.title || null, url: raw.url || null, at: raw.at || null });
    }
  }

  const lines = [];
  let total = 0;

  for (const { seg, strength, title, url, at } of seen.values()) {
    // A weak or borderline story shouldn't earn the same as a headline one, so
    // each trigger pays out a share of its maximum. A confidently-scored 100
    // article earns the full weight; a 50 earns half.
    const clamped = Math.max(0, Math.min(100, strength));
    const points = Math.round((seg.points * clamped) / 100);

    total += points;
    lines.push({
      id: seg.id,
      label: seg.label,
      angle: seg.angle,
      points,
      max: seg.points,
      strength: clamped,
      tier: seg.tier,
      title,
      url,
      at,
    });
  }

  lines.sort((a, b) => b.max - a.max || b.points - a.points);

  return { total: Math.min(100, total), max: 100, lines };
}

/** The rules block dropped into the Gemini prompt, generated from this file. */
function promptRules() {
  return SEGMENTS.filter((s) => s.id !== "none")
    .map(
      (s) =>
        `- "${s.id}" (Tier ${s.tier} ${TIERS[s.tier].label}) — ${s.trigger}. ${s.why}\n` +
        `  Typical phrasing: ${s.keywords.slice(0, 8).join(", ")}\n` +
        `  Agency angle to apply: ${s.pitch}`
    )
    .join("\n") + `\n- "none" (Tier 3 LOW) — generic news, PR or a passing mention with no buying trigger.`;
}

module.exports = {
  SEGMENTS,
  TIERS,
  segment,
  tierOf,
  tierLabel,
  tierNote,
  pitchFor,
  angleFor,
  actionFor,
  allKeywords,
  classify,
  scoreBreakdown,
  promptRules,
  SEGMENT_IDS: SEGMENTS.map((s) => s.id),
};
