/**
 * Packages and the discount rule.
 *
 * Nothing here hardcodes a number. Prices and the discount cap come out of
 * `rate_card` and `pricing_settings`, both admin-editable, so they can change
 * without touching this file or redeploying.
 *
 * The one rule this module exists to enforce: a salesperson cannot quietly
 * discount past the agreed limit without a manager seeing it.
 */
const db = require("../db");

/**
 * Only one number left. The healthy/minimum margin thresholds went with the
 * cost model — nothing computes margin any more.
 */
const DEFAULT_GUARDRAIL = {
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
 * Is this price acceptable?
 *
 * Cost and margin used to be worked out here — vendor cost, internal cost,
 * margin percentage, a healthy/thin/blocked verdict. All of that is gone at
 * the client's request: a salesperson now sees the client's budget and the
 * price we quote, and nothing about what delivery costs us.
 *
 * Manager approval survives, because "don't let people discount without
 * asking" is a separate concern from margin and still matters. It is now
 * measured purely against the package's list price.
 */
function quoteHealth({ price, listPrice }, rules) {
  const revenue = num(price);
  const list = num(listPrice);
  const maxDiscount = num(rules.max_discount_pct);

  const discountPct = list > 0 ? ((list - revenue) / list) * 100 : 0;
  const over = discountPct > maxDiscount;

  const reasons = over
    ? [
        `That's ${discountPct.toFixed(0)}% off the standard price of ₹${list.toLocaleString("en-IN")}. ` +
          `You can discount up to ${maxDiscount}% on your own.`,
      ]
    : [];

  return {
    revenue,
    list_price: list,
    discount_pct: Number(discountPct.toFixed(2)),
    status: over ? "blocked" : "ok",
    requires_approval: over,
    reasons,
    thresholds: { max_discount: maxDiscount },
    label: over ? "Needs your manager's approval" : "Fine to send",
  };
}

/**
 * The one call the routes make. Takes a package off the rate card and the
 * price being quoted, and rules on it.
 *
 * The custom package builder is gone — every quote is now a listed package,
 * optionally discounted. That removes the whole cost model (creator rates,
 * geography and language multipliers, deliverable weightings) along with it.
 */
async function priceQuote({ service, tier, price, budget }) {
  const rules = await guardrail();

  let listPrice = null;
  let planName = null;

  if (tier && tier !== "custom") {
    const plan = await planFor(service, tier);
    if (plan) {
      listPrice = num(plan.price);
      planName = `${plan.label}${plan.creators ? ` — ${plan.creators} creators` : ""}`;
    }
  }

  const effectivePrice = num(price) || num(budget) || listPrice || 0;

  return {
    service,
    tier: tier || null,
    plan_name: planName,
    recommended_price: listPrice,
    ...quoteHealth({ price: effectivePrice, listPrice }, rules),
  };
}

module.exports = {
  rateCard,
  planFor,
  guardrail,
  followupCadence,
  quoteHealth,
  priceQuote,
  DEFAULT_GUARDRAIL,
  DEFAULT_CADENCE,
};
