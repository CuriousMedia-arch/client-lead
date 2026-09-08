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

module.exports = {
  creditCost,
  defaultCreditsForRole,
  CREDIT_COST_HIGH,
  CREDIT_COST_MANAGER,
  CREDIT_COST_BASE,
  DEFAULT_CREDITS_MEMBER,
  DEFAULT_CREDITS_ADMIN,
};
