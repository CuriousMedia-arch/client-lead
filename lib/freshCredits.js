/**
 * Credits on the Fresh Leads track.
 *
 * Claiming a company from Fresh Leads is the one action in the portal that
 * takes something away from everyone else: for as long as the claim runs,
 * nobody else can work that company or unlock a single person at it. That is
 * why it costs, why there is a cap on how many you may hold, and why the
 * claim is settled when it ends rather than just forgotten.
 *
 * The whole lifecycle of one claim:
 *
 *   claim    -15 credits, and three free contact unlocks to spend at that
 *            company on whoever they judge worth reaching. The company locks
 *            to them everywhere.
 *   working  nothing moves.
 *   ends     settled exactly once, by outcome:
 *
 *              converted            +3x the cost  (+45)
 *              lost, 3+ replies     +50%          (+8)
 *              lost, 2 replies      +40%          (+6)
 *              lost, 1 reply        +25%          (+4)
 *              worked, no reply      0            (the cost is simply gone)
 *              never worked at all  -penalty      (-10, on top of the cost)
 *
 * A "reply" is them answering — an inbound message or a meeting that actually
 * happened. Sending six emails into silence is the no-reply row, not the
 * one-round row, because the ladder is paying for conversations, not effort.
 *
 * Every number above comes from credit_settings and is admin-editable.
 */
const db = require("../db");
const credits = require("./credits");

/**
 * What a claim costs, by where it was claimed from.
 *
 * Fresh Leads is the full price. The Newspaper is cheaper because everything
 * in it has already been failed by somebody — it is the last option, and
 * nobody works the last option at full price. What it pays back is unchanged.
 */
function costFor(rules, source) {
  return source === "newspaper"
    ? Number(rules.newspaper_claim_cost) || 0
    : Number(rules.fresh_claim_cost) || 0;
}

/** How many Fresh claims this person is holding right now. */
async function activeClaims(userId) {
  return db.value(
    "SELECT COUNT(*)::int AS n FROM fresh_claim_credits WHERE user_id = $1 AND settled_at IS NULL",
    [userId]
  );
}

/**
 * Everything the Claim button needs to know before it is pressed.
 *
 * Answered up front so the button can say "not enough credits" or "8 of 8
 * claims" instead of letting someone press it and be refused — being told
 * why after the fact is how a working rule reads as a broken portal.
 */
async function preflight(userId) {
  const rules = await credits.settings();

  const [balance, held] = await Promise.all([
    db.value("SELECT credits FROM users WHERE id = $1", [userId], "credits"),
    activeClaims(userId),
  ]);

  const max = Number(rules.max_active_claims) || 0;
  const room = held < max;
  const full = `You're holding ${held} of ${max} claims. Close or release one before taking another.`;

  // Both tracks are answered in one go: the two prices differ, so "can I
  // claim" has two answers, and a board showing Fresh Leads and the
  // Newspaper needs both without a second round trip.
  const forSource = (source) => {
    const cost = costFor(rules, source);
    const affordable = balance >= cost;
    return {
      cost,
      can_claim: affordable && room,
      reason: room
        ? affordable
          ? null
          : `Not enough credits — this costs ${cost} and you have ${balance}.`
        : full,
    };
  };

  const fresh = forSource("fresh");
  const newspaper = forSource("newspaper");

  return {
    balance,
    active: held,
    max_active: max,
    free_contacts: Number(rules.free_contacts_per_claim) || 0,
    sources: { fresh, newspaper },
    // Kept flat as well, so anything reading `cost` / `can_claim` without
    // naming a track still gets the Fresh Leads answer it always got.
    cost: fresh.cost,
    can_claim: fresh.can_claim,
    reason: fresh.reason,
  };
}

/**
 * Charge for a claim and grant the free unlocks that come with it.
 *
 * One transaction, with the user row locked for the whole of it: the cap
 * check, the balance check and the deduction have to see the same numbers, or
 * two claims fired a second apart both pass a check against a balance only
 * one of them is going to spend.
 *
 * Returns null if credits are not configured yet (no migration), which leaves
 * claiming free rather than broken.
 */
async function charge(leadId, userId, source = "fresh") {
  const rules = await credits.settings();
  if (rules.missing) return null;

  const cost = costFor(rules, source);
  const freeCount = Number(rules.free_contacts_per_claim) || 0;
  const maxActive = Number(rules.max_active_claims) || 0;

  return db.tx(async (q) => {
    const { rows: urows } = await q("SELECT credits FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (!urows[0]) throw Object.assign(new Error("Account no longer exists."), { status: 404 });

    const { rows: heldRows } = await q(
      "SELECT COUNT(*)::int AS n FROM fresh_claim_credits WHERE user_id = $1 AND settled_at IS NULL",
      [userId]
    );
    const held = heldRows[0].n;
    if (maxActive && held >= maxActive) {
      throw Object.assign(
        new Error(
          `You're holding ${held} of ${maxActive} claims. Close or release one before taking another.`
        ),
        { status: 409 }
      );
    }

    if (urows[0].credits < cost) {
      throw Object.assign(
        new Error(
          `Not enough credits — ${
            source === "newspaper" ? "picking this up" : "a claim"
          } costs ${cost} and you have ${urows[0].credits}.`
        ),
        { status: 402 }
      );
    }

    const balance = await credits.move(q, {
      userId,
      amount: -cost,
      kind: "claim",
      leadId,
      note:
        (source === "newspaper" ? "Newspaper pick-up" : "Fresh Leads claim") +
        (freeCount ? ` — ${freeCount} free unlock${freeCount === 1 ? "" : "s"} to spend` : ""),
    });

    // The allowance is stamped onto the claim rather than read from settings
    // when it is spent. An admin changing the rule from three to two should
    // not quietly take a pick off somebody mid-claim.
    const { rows: claimRows } = await q(
      `INSERT INTO fresh_claim_credits
         (lead_id, user_id, credits_spent, free_allowance, free_contact_ids)
       VALUES ($1, $2, $3, $4, '{}')
       RETURNING *`,
      [leadId, userId, cost, freeCount]
    );

    return { balance, cost, free_allowance: freeCount, free_unlocked: 0, claim: claimRows[0] };
  });
}

/**
 * How many free unlocks this person has left on this company.
 *
 * Keyed on the live claim, so it answers zero for anyone who does not hold
 * the company — there is no allowance to be had without a claim to hang it
 * on. `by company` exists because the unlock endpoint starts from a contact
 * and has a company name, not a lead id.
 */
async function allowance(leadId, userId) {
  const row = await db.one(
    `SELECT free_allowance,
            COALESCE(array_length(free_contact_ids, 1), 0) AS used
       FROM fresh_claim_credits
      WHERE lead_id = $1 AND user_id = $2 AND settled_at IS NULL`,
    [leadId, userId]
  );
  if (!row) return { granted: 0, used: 0, remaining: 0, holds: false };

  const granted = Number(row.free_allowance) || 0;
  const used = Number(row.used) || 0;
  return { granted, used, remaining: Math.max(0, granted - used), holds: true };
}

async function allowanceForCompany(company, userId) {
  const row = await db.one(
    `SELECT f.lead_id, f.free_allowance,
            COALESCE(array_length(f.free_contact_ids, 1), 0) AS used
       FROM fresh_claim_credits f
       JOIN leads l     ON l.id = f.lead_id
       JOIN companies c ON c.id = l.company_id
      WHERE lower(c.name) = lower($1)
        AND f.user_id = $2
        AND f.settled_at IS NULL
        AND l.fresh_owner_id = $2`,
    [company, userId]
  );
  if (!row) return { granted: 0, used: 0, remaining: 0, holds: false, lead_id: null };

  const granted = Number(row.free_allowance) || 0;
  const used = Number(row.used) || 0;
  return {
    lead_id: row.lead_id,
    granted,
    used,
    remaining: Math.max(0, granted - used),
    holds: true,
  };
}

/**
 * Spend one free pick on one contact.
 *
 * The whole check lives in the WHERE clause on purpose. Reading the count and
 * then writing would let two unlocks fired a second apart both pass a test
 * against the same number and spend a fourth pick between them; this way the
 * row is locked for the update and the guard is evaluated against what is
 * actually stored. No row back means no pick was available, and nothing
 * happened.
 *
 * Returns the claim row on success, null if there was nothing left to spend.
 */
async function spendFreePick(q, { leadId, userId, contactId }) {
  const run = q || ((text, params) => db.pool.query(text, params));

  const { rows } = await run(
    `UPDATE fresh_claim_credits
        SET free_contact_ids = array_append(free_contact_ids, $3::bigint)
      WHERE lead_id = $1
        AND user_id = $2
        AND settled_at IS NULL
        AND COALESCE(array_length(free_contact_ids, 1), 0) < free_allowance
        AND NOT ($3::bigint = ANY(free_contact_ids))
      RETURNING free_allowance,
                COALESCE(array_length(free_contact_ids, 1), 0) AS used`,
    [leadId, userId, contactId]
  );

  if (!rows[0]) return null;

  const granted = Number(rows[0].free_allowance) || 0;
  const used = Number(rows[0].used) || 0;
  return { granted, used, remaining: Math.max(0, granted - used) };
}

/**
 * How many times the company actually answered, since the claim started.
 *
 * Inbound messages plus meetings that happened. A meeting counts because
 * getting someone into a call is the strongest reply there is, and it would
 * be perverse for a claim that reached a meeting and then lost to settle at
 * the same rate as one nobody ever answered.
 */
async function replyRounds(leadId, since) {
  const from = since || new Date(0);

  const row = await db.one(
    `SELECT
       (SELECT COUNT(*) FROM opportunity_messages m
          JOIN opportunities o ON o.id = m.opportunity_id
         WHERE o.lead_id = $1 AND m.direction = 'in' AND m.created_at >= $2)
     + (SELECT COUNT(*) FROM opportunity_meetings mt
          JOIN opportunities o ON o.id = mt.opportunity_id
         WHERE o.lead_id = $1 AND mt.outcome IS NOT NULL AND mt.scheduled_at >= $2)
       AS n`,
    [leadId, from]
  );

  return row ? Number(row.n) : 0;
}

/**
 * Did they do anything at all?
 *
 * Deliberately generous: one sent email, one logged call, one note against a
 * contact at that company all count. The penalty is for claiming a company
 * and walking away from it, not for trying and failing, so the bar for
 * "tried" is as low as it can be while still meaning something.
 */
async function didWork(leadId, userId, since) {
  const from = since || new Date(0);

  const row = await db.one(
    `SELECT (
       EXISTS (SELECT 1 FROM opportunities o
                WHERE o.lead_id = $1 AND o.last_contacted_at IS NOT NULL)
       OR EXISTS (SELECT 1 FROM opportunity_messages m
                    JOIN opportunities o ON o.id = m.opportunity_id
                   WHERE o.lead_id = $1 AND m.direction = 'out' AND m.created_at >= $3)
       OR EXISTS (SELECT 1 FROM opportunity_meetings mt
                    JOIN opportunities o ON o.id = mt.opportunity_id
                   WHERE o.lead_id = $1 AND mt.scheduled_at >= $3)
       OR EXISTS (SELECT 1 FROM contact_activity a
                    JOIN company_contacts cc ON cc.id = a.contact_id
                    JOIN leads l ON l.id = $1
                    JOIN companies c ON c.id = l.company_id
                   WHERE lower(cc.company) = lower(c.name)
                     AND a.user_id = $2
                     AND a.kind <> 'note'
                     AND a.created_at >= $3)
     ) AS worked`,
    [leadId, userId, from]
  );

  return Boolean(row && row.worked);
}

/**
 * End a claim and pay out.
 *
 * Idempotent by construction: the UPDATE that stamps settled_at is what wins
 * the right to move credits, and it can only succeed once. Every exit path
 * calls this — winning, losing, releasing, the idle sweep, the deadline
 * sweep — so a claim settles exactly once no matter which of them fires
 * first, or how many fire at all.
 *
 * `outcome` may be "won", "lost" or "auto". "auto" works it out from what
 * actually happened, which is what every path except an explicit win/loss
 * should pass.
 */
async function settle(leadId, { outcome = "auto", note = null } = {}) {
  const rules = await credits.settings();
  if (rules.missing) return null;

  const open = await db.one(
    "SELECT * FROM fresh_claim_credits WHERE lead_id = $1 AND settled_at IS NULL",
    [leadId]
  );
  if (!open) return null;

  const rounds = await replyRounds(leadId, open.claimed_at);

  let resolved = outcome;
  if (resolved === "auto") {
    const won = await db.one(
      "SELECT 1 AS n FROM opportunities WHERE lead_id = $1 AND stage = 'won' LIMIT 1",
      [leadId]
    );
    if (won) resolved = "won";
    else if (!(await didWork(leadId, open.user_id, open.claimed_at))) resolved = "no_work";
    else resolved = "lost";
  } else if (resolved === "lost" && !(await didWork(leadId, open.user_id, open.claimed_at))) {
    // Marked lost without ever having sent anything is the same as walking
    // away from it — filing a loss interview is not work on the lead.
    resolved = "no_work";
  }

  // Settled against what this claim actually cost, so a 5-credit Newspaper
  // pick-up returns a fifth-of-fifteen's worth, not a full claim's worth.
  const payout = credits.settlementFor(resolved, rounds, rules, open.credits_spent);

  // Whoever's UPDATE lands first owns the settlement. A second caller gets
  // zero rows back and stops here, before touching a balance.
  const claimed = await db.one(
    `UPDATE fresh_claim_credits
        SET settled_at = now(), outcome = $2, reply_rounds = $3, settlement_amount = $4
      WHERE id = $1 AND settled_at IS NULL
      RETURNING *`,
    [open.id, resolved === "lost" && rounds === 0 ? "no_reply" : resolved, rounds, payout.amount]
  );
  if (!claimed) return null;

  let balance = null;
  if (payout.amount !== 0) {
    balance = await credits.move(null, {
      userId: open.user_id,
      amount: payout.amount,
      kind: payout.kind,
      leadId,
      note: note ? `${payout.label} — ${note}` : payout.label,
    });
  }

  return {
    outcome: claimed.outcome,
    rounds,
    amount: payout.amount,
    label: payout.label,
    balance,
    user_id: open.user_id,
  };
}

/**
 * Who is holding each of these companies on the Fresh track.
 *
 * Used to lock All Leads: the lock is not a second flag that has to be kept in
 * step with the claim, it IS the claim, read by company name.
 */
async function locksByCompany(companyNames) {
  if (!companyNames || !companyNames.length) return new Map();

  const rows = await db.all(
    `SELECT lower(c.name) AS key, l.fresh_owner_id, u.display_name AS owner_name
       FROM leads l
       JOIN companies c ON c.id = l.company_id
       LEFT JOIN users u ON u.id = l.fresh_owner_id
      WHERE l.fresh_owner_id IS NOT NULL
        AND lower(c.name) = ANY($1)`,
    [companyNames.map((n) => String(n).toLowerCase())]
  );

  return new Map(rows.map((r) => [r.key, { owner_id: r.fresh_owner_id, owner_name: r.owner_name }]));
}

/** The same question for one company, by name. */
async function lockFor(company) {
  const map = await locksByCompany([company]);
  return map.get(String(company).toLowerCase()) || null;
}


/**
 * Undo a charge that bought nothing.
 *
 * Only for the case where the money moved and then the claim itself failed to
 * land — never for a claim that ran and ended, which goes through settle().
 * Puts the credits back, drops the row, and takes away the free unlocks it
 * granted, so nobody keeps three revealed contacts from a claim they do not
 * hold.
 */
async function voidCharge(claimId) {
  const row = await db.one(
    "SELECT * FROM fresh_claim_credits WHERE id = $1 AND settled_at IS NULL",
    [claimId]
  );
  if (!row) return null;

  await db.tx(async (q) => {
    if (row.free_contact_ids && row.free_contact_ids.length) {
      await q(
        `DELETE FROM contact_unlocks
          WHERE user_id = $1 AND contact_id = ANY($2) AND source = 'fresh_claim'`,
        [row.user_id, row.free_contact_ids]
      );
    }
    await q("DELETE FROM fresh_claim_credits WHERE id = $1", [row.id]);
    await credits.move(q, {
      userId: row.user_id,
      amount: row.credits_spent,
      kind: "admin_adjust",
      leadId: row.lead_id,
      note: "Claim could not be completed — credits returned",
    });
  });

  return row;
}

module.exports = {
  costFor,
  activeClaims,
  preflight,
  charge,
  allowance,
  allowanceForCompany,
  spendFreePick,
  voidCharge,
  settle,
  replyRounds,
  didWork,
  locksByCompany,
  lockFor,
};
