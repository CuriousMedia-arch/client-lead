/**
 * The claim clock — for TWO independent claims per lead.
 *
 * A company has at most one All Leads claim (the contact-database
 * relationship) and, separately, at most one Fresh Leads claim (a specific
 * recent news signal). They used to share a single owner_id, which meant
 * claiming a company from All Leads silently annexed its Fresh Lead too,
 * even though nobody had actually claimed the news. They're tracked with
 * entirely separate columns now, and every function here takes a `source`
 * ("all" | "fresh") and only ever touches that source's columns.
 *
 *   Fresh Leads → 10 days. Miss it and the lead goes to the Newspaper, a
 *                 parking lot anyone can re-claim from. Doesn't touch the
 *                 All Leads claim on the same company, if there is one.
 *   All Leads   → 30 days. Miss it and it simply returns to All Leads,
 *                 unowned. Doesn't touch the Fresh Leads claim.
 *
 * Only an explicit Close stops the relevant clock. Logging activity does
 * not — someone emailing once a week for a month has not closed anything.
 */
const db = require("../db");

const DAYS = {
  fresh: Number(process.env.CLAIM_DAYS_FRESH || 10),
  all: Number(process.env.CLAIM_DAYS_ALL || 30),
};

function windowFor(source) {
  return DAYS[source] || DAYS.all;
}

const isFresh = (source) => source === "fresh" || source === "newspaper";

/** Claim a lead on one track, starting that track's clock only. */
async function claim(leadId, userId, source = "all") {
  const days = windowFor(source);

  if (isFresh(source)) {
    // Newspaper pickups carry no deadline. The lead already ran out of time
    // once; a second countdown would only send it round the same loop.
    const fromNewspaper = source === "newspaper";

    return db.one(
      `UPDATE leads
          SET fresh_owner_id       = $1,
              fresh_claimed_at     = now(),
              fresh_deadline_at    = ${fromNewspaper ? "NULL" : "now() + ($2 || ' days')::interval"},
              fresh_closed_at      = NULL,
              fresh_from_newspaper = $${fromNewspaper ? "2" : "4"},
              in_newspaper         = false,
              updated_at           = now()
        WHERE id = $3
        RETURNING *`,
      fromNewspaper ? [userId, true, leadId] : [userId, days, leadId, false]
    );
  }

  return db.one(
    `UPDATE leads
        SET owner_id     = $1,
            claimed_at   = now(),
            claim_source = 'all',
            deadline_at  = now() + ($2 || ' days')::interval,
            closed_at    = NULL,
            status       = CASE WHEN status = 'new' THEN 'working' ELSE status END,
            updated_at   = now()
      WHERE id = $3
      RETURNING *`,
    [userId, days, leadId]
  );
}

/** Give a lead back voluntarily, on one track. Clears that clock; no penalty. */
function release(leadId, source = "all") {
  if (isFresh(source)) {
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
        SET owner_id = NULL, claimed_at = NULL, claim_source = NULL, deadline_at = NULL,
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [leadId]
  );
}

/** Mark one track done. The only thing that stops that track's countdown. */
function close(leadId, source = "all") {
  if (isFresh(source)) {
    return db.one(
      `UPDATE leads SET fresh_closed_at = now(), fresh_deadline_at = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [leadId]
    );
  }

  return db.one(
    `UPDATE leads SET closed_at = now(), deadline_at = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [leadId]
  );
}

/** Undo a close on one track, restarting that track's clock from a full window. */
function reopen(leadId, source = "all") {
  const days = windowFor(source);

  if (isFresh(source)) {
    return db.one(
      `UPDATE leads
          SET fresh_closed_at = NULL,
              fresh_claimed_at = now(),
              fresh_deadline_at = now() + ($1 || ' days')::interval,
              updated_at = now()
        WHERE id = $2 RETURNING *`,
      [days, leadId]
    );
  }

  return db.one(
    `UPDATE leads
        SET closed_at = NULL,
            claimed_at = now(),
            deadline_at = now() + ($1 || ' days')::interval,
            updated_at = now()
      WHERE id = $2 RETURNING *`,
    [days, leadId]
  );
}

/**
 * Release everything past its deadline, on both tracks independently.
 *
 * Runs before any list is served, so the board is always truthful rather than
 * relying on a background job having fired.
 *
 * An expired All Leads claim just returns to All Leads, unowned — the company
 * profile itself never goes anywhere. An expired Fresh Leads claim is parked
 * in the Newspaper: that particular news window ran out. Neither sweep
 * touches the other track's columns on the same row.
 */
async function sweepExpired() {
  const expiredAll = await db.all(
    `SELECT id FROM leads
      WHERE owner_id IS NOT NULL
        AND closed_at IS NULL
        AND deadline_at IS NOT NULL
        AND deadline_at < now()`
  );

  const expiredFresh = await db.all(
    `SELECT id FROM leads
      WHERE fresh_owner_id IS NOT NULL
        AND fresh_closed_at IS NULL
        AND fresh_deadline_at IS NOT NULL
        AND fresh_deadline_at < now()`
  );

  if (expiredAll.length) {
    await db.run(
      `UPDATE leads
          SET owner_id = NULL, claimed_at = NULL, claim_source = NULL, deadline_at = NULL,
              status = 'new', updated_at = now()
        WHERE id = ANY($1)`,
      [expiredAll.map((l) => l.id)]
    );
  }

  if (expiredFresh.length) {
    // fresh_released_at is what the Newspaper groups by, so it's stamped
    // here and nowhere else — updated_at moves whenever anything changes.
    await db.run(
      `UPDATE leads
          SET fresh_owner_id = NULL, fresh_claimed_at = NULL, fresh_deadline_at = NULL,
              in_newspaper = true, fresh_released_at = now(), updated_at = now()
        WHERE id = ANY($1)`,
      [expiredFresh.map((l) => l.id)]
    );
  }

  return { released: expiredAll.length, toNewspaper: expiredFresh.length };
}

/**
 * How long is left on one track, in a form a person reads at a glance.
 * Returns null for anything without a running clock on that track.
 */
function countdown(deadlineAt, closedAt) {
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

module.exports = { claim, release, close, reopen, sweepExpired, countdown, windowFor, DAYS };
