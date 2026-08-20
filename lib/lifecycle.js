/**
 * The claim clock.
 *
 * Claiming a lead is a commitment with a deadline, not a permanent lock. The
 * window depends on where it was claimed from:
 *
 *   Fresh Leads → 10 days. Miss it and the lead goes to the Newspaper, a
 *                 parking lot anyone can re-claim from.
 *   All Leads   → 30 days. Miss it and it simply returns to All Leads.
 *
 * Only an explicit Close stops the clock. Logging activity does not — someone
 * emailing once a week for a month has not closed anything.
 *
 * Fresh and All are two independent tracks on the same `leads` row, each with
 * its own column set (`fresh_*` vs the bare columns) so one company can be
 * claimed on both at once without either claim stepping on the other.
 */
const db = require("../db");

const DAYS = {
  fresh: Number(process.env.CLAIM_DAYS_FRESH || 10),
  all: Number(process.env.CLAIM_DAYS_ALL || 30),
};

function windowFor(source) {
  return DAYS[source] || DAYS.all;
}

/** Claim a lead, starting its clock. `source` picks which track's columns move. */
async function claim(leadId, userId, source = "all") {
  const days = windowFor(source);

  if (source === "fresh") {
    return db.one(
      `UPDATE leads
          SET fresh_owner_id    = $1,
              fresh_claimed_at  = now(),
              fresh_deadline_at = now() + ($2 || ' days')::interval,
              fresh_closed_at   = NULL,
              fresh_released_at = NULL,
              in_newspaper      = false,
              status            = CASE WHEN status = 'new' THEN 'working' ELSE status END,
              updated_at        = now()
        WHERE id = $3
        RETURNING *`,
      [userId, days, leadId]
    );
  }

  return db.one(
    `UPDATE leads
        SET owner_id     = $1,
            claimed_at   = now(),
            claim_source = $2,
            deadline_at  = now() + ($3 || ' days')::interval,
            closed_at    = NULL,
            released_at  = NULL,
            status       = CASE WHEN status = 'new' THEN 'working' ELSE status END,
            updated_at   = now()
      WHERE id = $4
      RETURNING *`,
    [userId, source, days, leadId]
  );
}

/** Give a lead back voluntarily. Clears the clock; no penalty. */
function release(leadId, source = "all") {
  if (source === "fresh") {
    return db.one(
      `UPDATE leads
          SET fresh_owner_id = NULL, fresh_claimed_at = NULL, fresh_deadline_at = NULL,
              updated_at = now()
        WHERE id = $1 RETURNING *`,
      [leadId]
    );
  }

  return db.one(
    `UPDATE leads
        SET owner_id = NULL, claimed_at = NULL, claim_source = NULL,
            deadline_at = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [leadId]
  );
}

/** Mark it done. The only thing that stops the countdown. */
function close(leadId, source = "all") {
  if (source === "fresh") {
    return db.one(
      `UPDATE leads
          SET fresh_closed_at = now(), fresh_deadline_at = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [leadId]
    );
  }

  return db.one(
    `UPDATE leads
        SET closed_at = now(), deadline_at = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [leadId]
  );
}

/** Undo a close, restarting the clock from a fresh full window. */
function reopen(leadId, source = "all") {
  const days = windowFor(source);

  if (source === "fresh") {
    return db.one(
      `UPDATE leads
          SET fresh_closed_at   = NULL,
              fresh_claimed_at  = now(),
              fresh_deadline_at = now() + ($1 || ' days')::interval,
              updated_at        = now()
        WHERE id = $2 RETURNING *`,
      [days, leadId]
    );
  }

  return db.one(
    `UPDATE leads
        SET closed_at    = NULL,
            claimed_at   = now(),
            deadline_at  = now() + ($1 || ' days')::interval,
            updated_at   = now()
      WHERE id = $2 RETURNING *`,
    [days, leadId]
  );
}

/**
 * Release everything past its deadline, on both tracks independently.
 *
 * Runs before any list is served, so the board is always truthful rather than
 * relying on a background job having fired.
 */
async function sweepExpired() {
  const expired = await db.all(
    `SELECT id, 'fresh' AS track FROM leads
      WHERE fresh_owner_id IS NOT NULL
        AND fresh_closed_at IS NULL
        AND fresh_deadline_at IS NOT NULL
        AND fresh_deadline_at < now()
     UNION ALL
     SELECT id, 'all' AS track FROM leads
      WHERE owner_id IS NOT NULL
        AND closed_at IS NULL
        AND deadline_at IS NOT NULL
        AND deadline_at < now()`
  );

  if (!expired.length) return { released: 0, toNewspaper: 0 };

  const fresh = expired.filter((l) => l.track === "fresh").map((l) => l.id);
  const rest = expired.filter((l) => l.track === "all").map((l) => l.id);

  if (fresh.length) {
    // A Fresh claim that runs out of time lands in the Newspaper, not back
    // in Fresh Leads — that's the whole point of the parking lot.
    await db.run(
      `UPDATE leads
          SET fresh_owner_id = NULL, fresh_claimed_at = NULL, fresh_deadline_at = NULL,
              in_newspaper = true, fresh_released_at = now(), released_at = now(),
              status = 'new', updated_at = now()
        WHERE id = ANY($1)`,
      [fresh]
    );
  }

  if (rest.length) {
    await db.run(
      `UPDATE leads
          SET owner_id = NULL, claimed_at = NULL, claim_source = NULL,
              deadline_at = NULL, status = 'new', updated_at = now()
        WHERE id = ANY($1)`,
      [rest]
    );
  }

  return { released: expired.length, toNewspaper: fresh.length };
}

/**
 * How long is left, in a form a person reads at a glance.
 * Returns null for anything without a running clock.
 */
function countdownFrom(deadlineAt, closedAt) {
  if (!deadlineAt || closedAt) return null;

  const msLeft = new Date(deadlineAt).getTime() - Date.now();
  const dayMs = 86400000;

  if (msLeft <= 0) return { label: "Overdue", days: 0, urgent: true, overdue: true };

  const days = Math.floor(msLeft / dayMs);
  const hours = Math.floor((msLeft % dayMs) / 3600000);

  return {
    label: days >= 1 ? `${days}d ${hours}h left` : `${hours}h left`,
    days,
    urgent: days < 3,
    overdue: false,
  };
}

/** Countdown for the All Leads track. */
function countdown(lead) {
  if (!lead) return null;
  return countdownFrom(lead.deadline_at, lead.closed_at);
}

/** Countdown for the Fresh Leads track. */
function freshCountdown(lead) {
  if (!lead) return null;
  return countdownFrom(lead.fresh_deadline_at, lead.fresh_closed_at);
}

module.exports = {
  claim,
  release,
  close,
  reopen,
  sweepExpired,
  countdown,
  freshCountdown,
  windowFor,
  DAYS,
};
