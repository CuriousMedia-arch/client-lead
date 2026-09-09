/**
 * Credit cost for revealing one contact's details, by seniority of their
 * title. Founders, Co-Founders, Directors and any "Head of ..." post are
 * priced above a fresh joinee's whole starting balance (50) on purpose — that
 * tier is meant to require a manager/admin balance (180), not a top-up.
 */
const HIGH_LEVEL = /\b(co-?founder|founder|director|head)\b/i;
const MANAGER_LEVEL = /\bmanager\b/i;

const CREDIT_COST_HIGH = 51;
const CREDIT_COST_MANAGER = 12;
const CREDIT_COST_BASE = 5;

function creditCost(roleText) {
  const t = String(roleText || "");
  if (HIGH_LEVEL.test(t)) return CREDIT_COST_HIGH;
  if (MANAGER_LEVEL.test(t)) return CREDIT_COST_MANAGER;
  return CREDIT_COST_BASE;
}

const DEFAULT_CREDITS_MEMBER = 50;
const DEFAULT_CREDITS_ADMIN = 180;

function defaultCreditsForRole(role) {
  return role === "admin" ? DEFAULT_CREDITS_ADMIN : DEFAULT_CREDITS_MEMBER;
}


/* ── Fresh Leads claim rules ───────────────────────────────────────────────
 *
 * Everything below is admin-editable and lives in credit_settings, so nothing
 * here is a constant — these are only the fallbacks used when the table has
 * not been created yet (the app still runs before the migration is applied,
 * it just charges nothing).
 */
const db = require("../db");

const FALLBACK = {
  fresh_claim_cost: 15,
  free_contacts_per_claim: 3,
  win_multiplier: 3,
  refund_pct_3plus: 50,
  refund_pct_2: 40,
  refund_pct_1: 25,
  no_work_penalty: 10,
  max_active_claims: 8,
};

// The rules are read on nearly every list request. They change about twice a
// year. A short cache turns thousands of round trips a day into a handful,
// and 30 seconds is short enough that an admin editing them sees the change
// before they have finished reading the confirmation.
let cache = null;
let cachedAt = 0;
const CACHE_MS = 30_000;

async function settings(force = false) {
  if (!force && cache && Date.now() - cachedAt < CACHE_MS) return cache;

  try {
    const row = await db.one("SELECT * FROM credit_settings WHERE id = 1");
    cache = row ? { ...FALLBACK, ...row, win_multiplier: Number(row.win_multiplier) } : { ...FALLBACK };
  } catch {
    // Table not there yet. Fall back rather than taking the portal down —
    // an unmigrated database should degrade to "claims are free", not to a
    // 500 on every page.
    cache = { ...FALLBACK, missing: true };
  }
  cachedAt = Date.now();
  return cache;
}

/** Call after any write to credit_settings so the next read is not stale. */
function invalidate() {
  cache = null;
  cachedAt = 0;
}

/**
 * Move credits and say why, in one place.
 *
 * Every balance change in the app goes through here so the ledger can never
 * disagree with the balance — they are written in the same statement pair,
 * inside whatever transaction the caller is already running.
 *
 * `q` is a transaction query function from db.tx; pass null to run standalone.
 * Balances floor at zero: a penalty bigger than what someone has left takes
 * what is there rather than pushing them negative, because a negative balance
 * silently blocks every future claim with an error that explains nothing.
 */
async function move(q, { userId, amount, kind, leadId = null, contactId = null, note = null }) {
  const run = q || ((text, params) => db.pool.query(text, params));

  const { rows } = await run(
    `UPDATE users
        SET credits = GREATEST(0, credits + $1)
      WHERE id = $2
      RETURNING credits`,
    [Math.trunc(amount), userId]
  );
  if (!rows[0]) return null;

  const balance = rows[0].credits;

  await run(
    `INSERT INTO credit_ledger (user_id, amount, balance_after, kind, lead_id, contact_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, Math.trunc(amount), balance, kind, leadId, contactId, note]
  );

  return balance;
}

/**
 * What a finished claim is worth back.
 *
 * The ladder is about effort that actually reached someone, so it counts
 * REPLIES, not sends. Five emails into a void is still "no reply" — that
 * costs the claim and nothing more. Claiming and sending nothing at all is
 * the only outcome that costs extra, because it is the only one that denied
 * the company to everyone else for nothing.
 */
function settlementFor(outcome, replyRounds, rules) {
  const cost = Number(rules.fresh_claim_cost) || 0;
  const rounds = Number(replyRounds) || 0;
  const pct = (n) => Math.round((cost * n) / 100);

  if (outcome === "won") {
    return {
      amount: Math.round(cost * (Number(rules.win_multiplier) || 0)),
      kind: "win_bonus",
      label: `Converted — ${rules.win_multiplier}x back`,
    };
  }

  if (outcome === "no_work") {
    return {
      amount: -(Number(rules.no_work_penalty) || 0),
      kind: "penalty",
      label: "Claimed but never worked — penalty",
    };
  }

  if (rounds >= 3) {
    return { amount: pct(rules.refund_pct_3plus), kind: "partial_refund", label: `Lost after ${rounds} replies — ${rules.refund_pct_3plus}% back` };
  }
  if (rounds === 2) {
    return { amount: pct(rules.refund_pct_2), kind: "partial_refund", label: `Lost after 2 replies — ${rules.refund_pct_2}% back` };
  }
  if (rounds === 1) {
    return { amount: pct(rules.refund_pct_1), kind: "partial_refund", label: `Lost after 1 reply — ${rules.refund_pct_1}% back` };
  }

  return { amount: 0, kind: "partial_refund", label: "No reply — nothing back, nothing extra" };
}

module.exports = {
  creditCost,
  defaultCreditsForRole,
  CREDIT_COST_HIGH,
  CREDIT_COST_MANAGER,
  CREDIT_COST_BASE,
  DEFAULT_CREDITS_MEMBER,
  DEFAULT_CREDITS_ADMIN,
  settings,
  invalidate,
  move,
  settlementFor,
  FALLBACK,
};
