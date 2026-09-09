/**
 * Credits: what I have, where it went, and the rules everyone plays by.
 *
 * The balance itself already rides along on the session, so this is the two
 * things that could not: the history behind the number, and the rules that
 * decide it. Both matter for the same reason — a balance nobody can explain
 * is a balance people argue with.
 */
const express = require("express");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../lib/auth");
const credits = require("../lib/credits");
const freshCredits = require("../lib/freshCredits");

const router = express.Router();
router.use(requireAuth);

/** Balance, claim slots, the rules in force, and the last 50 movements. */
router.get("/me", async (req, res, next) => {
  try {
    const [pre, rules] = await Promise.all([
      freshCredits.preflight(req.user.id),
      credits.settings(),
    ]);

    const ledger = await db
      .all(
        `SELECT cl.id, cl.amount, cl.balance_after, cl.kind, cl.note, cl.created_at,
                c.name AS company
           FROM credit_ledger cl
           LEFT JOIN leads l    ON l.id = cl.lead_id
           LEFT JOIN companies c ON c.id = l.company_id
          WHERE cl.user_id = $1
          ORDER BY cl.created_at DESC
          LIMIT 50`,
        [req.user.id]
      )
      .catch(() => []);

    const open = await db
      .all(
        `SELECT f.lead_id, f.credits_spent, f.claimed_at, c.name AS company
           FROM fresh_claim_credits f
           JOIN leads l     ON l.id = f.lead_id
           JOIN companies c ON c.id = l.company_id
          WHERE f.user_id = $1 AND f.settled_at IS NULL
          ORDER BY f.claimed_at DESC`,
        [req.user.id]
      )
      .catch(() => []);

    res.json({ ...pre, rules: publicRules(rules), ledger, open_claims: open });
  } catch (err) {
    next(err);
  }
});

/**
 * The rules, as the whole team should see them — no internal columns, and
 * the win multiplier already worked out into credits so nobody has to do the
 * arithmetic to know what a conversion is worth.
 */
function publicRules(r) {
  const fresh = Number(r.fresh_claim_cost) || 0;
  const paper = Number(r.newspaper_claim_cost) || 0;

  // One ladder per track, because every figure is a proportion of what that
  // track's claim costs. Same shape, different stakes: 15 to make 45, or 5 to
  // make 15. Sent as credits rather than percentages — "50%" is a policy and
  // "3 credits" is what someone actually gets, and only the second one
  // settles an argument.
  const ladder = (cost) => {
    const pct = (n) => Math.round((cost * (Number(n) || 0)) / 100);
    return [
      { key: "won", label: "Client signs", value: Math.round(cost * (Number(r.win_multiplier) || 0)) },
      { key: "lost3", label: "Lost after 3+ replies", value: pct(r.refund_pct_3plus) },
      { key: "lost2", label: "Lost after 2 replies", value: pct(r.refund_pct_2) },
      { key: "lost1", label: "Lost after 1 reply", value: pct(r.refund_pct_1) },
      { key: "no_reply", label: "Worked it, never heard back", value: 0 },
      { key: "no_work", label: "Claimed it and did nothing", value: -(Number(r.no_work_penalty) || 0) },
    ];
  };

  return {
    fresh_claim_cost: fresh,
    newspaper_claim_cost: paper,
    free_contacts_per_claim: Number(r.free_contacts_per_claim) || 0,
    max_active_claims: Number(r.max_active_claims) || 0,
    win_multiplier: Number(r.win_multiplier) || 0,
    refund_pct_3plus: Number(r.refund_pct_3plus) || 0,
    refund_pct_2: Number(r.refund_pct_2) || 0,
    refund_pct_1: Number(r.refund_pct_1) || 0,
    no_work_penalty: Number(r.no_work_penalty) || 0,
    ladders: { fresh: ladder(fresh), newspaper: ladder(paper) },
    // The Fresh ladder stays under its old name for anything already reading it.
    outcomes: ladder(fresh),
  };
}

/* ── Admin ───────────────────────────────────────────────────────────────── */

router.get("/settings", requireAdmin, async (req, res, next) => {
  try {
    res.json({ settings: await credits.settings(true) });
  } catch (err) {
    next(err);
  }
});

/**
 * Change the rules.
 *
 * Only the fields sent are touched, and every one is clamped: a negative
 * claim cost or a 900% refund is a typo, not a policy, and the cheapest place
 * to catch it is before it is stored.
 */
router.put("/settings", requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};

    const int = (v, min, max) => {
      const n = Math.trunc(Number(v));
      if (!Number.isFinite(n)) return null;
      return Math.min(max, Math.max(min, n));
    };

    const fields = {
      fresh_claim_cost: int(b.fresh_claim_cost, 0, 10000),
      newspaper_claim_cost: int(b.newspaper_claim_cost, 0, 10000),
      free_contacts_per_claim: int(b.free_contacts_per_claim, 0, 50),
      win_multiplier: Number.isFinite(Number(b.win_multiplier))
        ? Math.min(20, Math.max(0, Number(b.win_multiplier)))
        : null,
      refund_pct_3plus: int(b.refund_pct_3plus, 0, 100),
      refund_pct_2: int(b.refund_pct_2, 0, 100),
      refund_pct_1: int(b.refund_pct_1, 0, 100),
      no_work_penalty: int(b.no_work_penalty, 0, 10000),
      max_active_claims: int(b.max_active_claims, 1, 500),
    };

    const sets = [];
    const args = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === null || b[key] === undefined) continue;
      sets.push(`${key} = $${args.push(value)}`);
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to change." });

    sets.push(`updated_at = now()`);
    sets.push(`updated_by = $${args.push(req.user.id)}`);

    const row = await db.one(
      `UPDATE credit_settings SET ${sets.join(", ")} WHERE id = 1 RETURNING *`,
      args
    );

    credits.invalidate();
    res.json({ settings: row });
  } catch (err) {
    next(err);
  }
});

/**
 * Everyone's balance and what they are holding — the view a manager needs to
 * answer "who has run out" without opening eight profiles.
 */
router.get("/team", requireAdmin, async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT u.id, u.display_name, u.username, u.role, u.credits,
              COALESCE(f.open_claims, 0)::int AS open_claims,
              COALESCE(f.spent, 0)::int       AS lifetime_spent,
              COALESCE(f.earned, 0)::int      AS lifetime_earned
         FROM users u
         LEFT JOIN (
           SELECT user_id,
                  COUNT(*) FILTER (WHERE settled_at IS NULL) AS open_claims,
                  SUM(credits_spent)                          AS spent,
                  SUM(GREATEST(COALESCE(settlement_amount, 0), 0)) AS earned
             FROM fresh_claim_credits GROUP BY user_id
         ) f ON f.user_id = u.id
        WHERE u.active
        ORDER BY u.credits ASC, LOWER(u.display_name)`
    );
    res.json({ team: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
