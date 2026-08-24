/**
 * Pricing, costing and the margin guardrail (brief items 5, 6, 7 and 24).
 *
 * Nothing here hardcodes a number. Every rate, multiplier and threshold comes
 * out of `rate_card` and `pricing_settings`, both admin-editable, so the real
 * numbers can be pasted in later without touching this file or redeploying.
 *
 * The one rule this module exists to enforce: a salesperson never sets a price
 * the company loses money on without a manager seeing it first.
 */
const db = require("../db");

/** Fallbacks used only if pricing_settings has never been seeded. */
const DEFAULT_COST_MODEL = {
  creator_rates: { nano: 3000, micro: 12000, macro: 60000 },
  internal_cost_pct: 10,
  geo_multiplier: { India: 1.0, North: 1.0, South: 1.05, Regional: 0.9 },
  language_multiplier: { Hindi: 1.0, English: 1.1, Tamil: 0.95, Telugu: 0.95 },
  deliverable_multiplier: { Reels: 1.0, YouTube: 1.8, Stories: 0.5, "Static post": 0.6 },
};

const DEFAULT_GUARDRAIL = {
  healthy_margin_pct: 35,
  min_margin_pct: 25,
  max_discount_pct: 20,
};

async function setting(key, fallback) {
  try {
    const row = await db.one("SELECT value FROM pricing_settings WHERE key = $1", [key]);
    return row ? { ...fallback, ...row.value } : fallback;
  } catch {
    return fallback;
  }
}

/**
 * When the follow-up sequence fires, and how long a claimed-but-untouched
 * opportunity may sit before the bell nags about it.
 *
 * The day numbers are the brief's (3 / 7 / 14 / 30). They live here rather
 * than in code because the right cadence is something the sales lead will want
 * to tune after watching it run for a month.
 */
const DEFAULT_CADENCE = {
  step1_days: 3,
  step2_days: 7,
  step3_days: 14,
  step4_days: 30,
  nudge_after_hours: 24,
};

const costModel = () => setting("cost_model", DEFAULT_COST_MODEL);
const guardrail = () => setting("guardrail", DEFAULT_GUARDRAIL);
const followupCadence = () => setting("followup_cadence", DEFAULT_CADENCE);

/** The whole rate card, grouped by service — what the plan picker renders. */
async function rateCard() {
  const rows = await db.all(
    `SELECT id, service, tier, label, price, creators, views, deliverables, active, sort
       FROM rate_card
      WHERE active
      ORDER BY service, sort, price`
  );

  const services = new Map();
  for (const row of rows) {
    if (!services.has(row.service)) services.set(row.service, []);
    services.get(row.service).push(row);
  }
  return [...services].map(([service, plans]) => ({ service, plans }));
}

async function planFor(service, tier) {
  return db.one(
    `SELECT * FROM rate_card WHERE lower(service) = lower($1) AND lower(tier) = lower($2)`,
    [service, tier]
  );
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Item 6 — the custom plan builder.
 *
 * Cost is built from the creator mix, then nudged by geography, language and
 * deliverable type. YouTube costs nearly twice a Reel; a Story costs half.
 * These are multipliers rather than separate rate tables so an admin only has
 * to maintain one set of base creator rates.
 *
 * Returns the estimate; it does NOT decide whether the price is acceptable.
 * That is quoteHealth's job, and keeping them apart means the builder can show
 * a live estimate while the salesperson is still typing.
 */
function estimateCustomPlan(config, model) {
  const rates = model.creator_rates || {};
  const mix = config.creator_mix || {};

  let creatorCost = 0;
  let creators = 0;
  for (const type of ["nano", "micro", "macro"]) {
    const count = Math.max(0, Math.round(num(mix[type])));
    creators += count;
    creatorCost += count * num(rates[type]);
  }

  const geo = num((model.geo_multiplier || {})[config.geography]) || 1;
  const lang = num((model.language_multiplier || {})[config.language]) || 1;

  // Several deliverables on one campaign means each creator produces each of
  // them, so the multipliers add rather than replace one another.
  const deliverables = Array.isArray(config.deliverables) ? config.deliverables : [];
  const deliverableFactor = deliverables.length
    ? deliverables.reduce(
        (sum, d) => sum + (num((model.deliverable_multiplier || {})[d]) || 1),
        0
      )
    : 1;

  const vendorCost = Math.round(creatorCost * geo * lang * deliverableFactor);
  const internalCost = Math.round(vendorCost * (num(model.internal_cost_pct) / 100));

  return {
    creators,
    vendor_cost: vendorCost,
    internal_cost: internalCost,
    total_cost: vendorCost + internalCost,
    multipliers: { geography: geo, language: lang, deliverables: deliverableFactor },
  };
}

/**
 * Item 7 — the guardrail.
 *
 * Given what the client will pay and what delivery costs, say whether this is
 * a deal worth doing, and whether a manager has to see it. Three states:
 *
 *   healthy  — at or above the healthy margin, sell it
 *   thin     — below healthy but above the floor, allowed, flagged amber
 *   blocked  — below the floor, or discounted past the cap: approval required
 *
 * `requires_approval` is what the API acts on. The wording is what the
 * salesperson reads, so it says what to do, not just what is wrong.
 */
function quoteHealth({ price, vendorCost, internalCost, listPrice }, rules) {
  const revenue = num(price);
  const cost = num(vendorCost) + num(internalCost);
  const marginAmount = revenue - cost;
  const marginPct = revenue > 0 ? (marginAmount / revenue) * 100 : 0;

  const healthy = num(rules.healthy_margin_pct);
  const floor = num(rules.min_margin_pct);
  const maxDiscount = num(rules.max_discount_pct);

  const list = num(listPrice);
  const discountPct = list > 0 ? ((list - revenue) / list) * 100 : 0;

  const reasons = [];
  if (revenue > 0 && marginPct < floor) {
    reasons.push(
      `At this price we only keep ${marginPct.toFixed(1)}% after paying creators and costs. ` +
        `The company's minimum is ${floor}%.`
    );
  }
  if (discountPct > maxDiscount) {
    reasons.push(
      `That's ${discountPct.toFixed(0)}% off the normal price of ₹${list.toLocaleString("en-IN")}. ` +
        `You can discount up to ${maxDiscount}% on your own.`
    );
  }

  const status = reasons.length ? "blocked" : marginPct < healthy ? "thin" : "healthy";

  return {
    revenue,
    vendor_cost: num(vendorCost),
    internal_cost: num(internalCost),
    total_cost: cost,
    margin_amount: Math.round(marginAmount),
    margin_pct: Number(marginPct.toFixed(2)),
    discount_pct: Number(discountPct.toFixed(2)),
    status,
    requires_approval: status === "blocked",
    reasons,
    thresholds: { healthy, floor, max_discount: maxDiscount },
    // Read by a salesperson mid-quote, so each verdict says what it means for
    // them, not what the number is called.
    label:
      status === "healthy"
        ? "Good deal — go ahead"
        : status === "thin"
        ? "Tight, but you can sell it"
        : "Too cheap — your manager has to approve",
  };
}

/**
 * The one call the routes make: take whatever the salesperson has filled in,
 * work out the cost, and rule on the price. Handles both paths — a plan picked
 * off the rate card and a plan built from scratch — so the caller does not
 * have to know which it is looking at.
 */
async function priceQuote({ service, tier, planConfig = {}, price, budget }) {
  const [model, rules] = await Promise.all([costModel(), guardrail()]);

  let vendorCost;
  let internalCost;
  let listPrice = null;
  let planName = null;
  let estimate = null;

  if (tier && tier !== "custom") {
    const plan = await planFor(service, tier);
    if (plan) {
      listPrice = num(plan.price);
      planName = `${plan.label} — ${plan.creators || 0} creators`;
      // A rate-card plan carries a price, not a cost. Derive the cost from the
      // healthy margin it was priced to hit, so the guardrail has something
      // real to compare a discount against.
      const impliedMargin = num(rules.healthy_margin_pct) / 100;
      const totalCost = Math.round(listPrice * (1 - impliedMargin));
      internalCost = Math.round(totalCost * (num(model.internal_cost_pct) / (100 + num(model.internal_cost_pct))));
      vendorCost = totalCost - internalCost;
    }
  }

  if (vendorCost == null) {
    estimate = estimateCustomPlan(planConfig, model);
    vendorCost = estimate.vendor_cost;
    internalCost = estimate.internal_cost;
    planName = planName || "Custom plan";
    // With no list price, a custom plan's own healthy price is the reference
    // point for "how much has this been discounted".
    listPrice =
      listPrice ||
      Math.round((vendorCost + internalCost) / (1 - num(rules.healthy_margin_pct) / 100));
  }

  const effectivePrice = num(price) || num(budget) || listPrice;

  const health = quoteHealth(
    { price: effectivePrice, vendorCost, internalCost, listPrice },
    rules
  );

  return {
    service,
    tier: tier || "custom",
    plan_name: planName,
    list_price: listPrice,
    recommended_price: listPrice,
    estimate,
    ...health,
  };
}

module.exports = {
  rateCard,
  planFor,
  costModel,
  guardrail,
  followupCadence,
  estimateCustomPlan,
  quoteHealth,
  priceQuote,
  DEFAULT_COST_MODEL,
  DEFAULT_GUARDRAIL,
  DEFAULT_CADENCE,
};
