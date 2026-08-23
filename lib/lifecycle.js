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
  // Fresh claims are governed by freshClock's checkpoints (12h idle, 7d reply,
  // 15d close), not one flat deadline. Kept here only for anything still
  // reading DAYS.fresh.
  fresh: Number(process.env.CLAIM_DAYS_FRESH || 15),
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

    // The clock starts from the claim; freshClock's checkpoints do the rest.
    return db.one(
      `UPDATE leads
          SET fresh_owner_id         = $1,
              fresh_claimed_at       = now(),
              fresh_last_activity_at = now(),
              fresh_warned_at        = NULL,
              -- A fresh claim is on probation for its first day: 24 hours to
              -- show it's actually being worked. Log anything and it opens to
              -- the full window. Do nothing and it's released, which is the
              -- same outcome as before — just visible on the card instead of
              -- arriving as a surprise.
              fresh_deadline_at      = ${fromNewspaper ? "NULL" : `now() + interval '${Number(process.env.FRESH_PROBATION_HOURS || 24)} hours'`},
              fresh_closed_at        = NULL,
              fresh_release_note     = NULL,
              fresh_from_newspaper   = $2,
              in_newspaper           = false,
              updated_at             = now()
        WHERE id = $3
        RETURNING *`,
      [userId, fromNewspaper, leadId]
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

/**
 * Claiming the company sweeps up its people.
 *
 * Whoever holds the Fresh Lead is working the whole account for the next ten
 * days, so they get the account's contacts rather than having to claim eleven
 * rows by hand. Two groups move:
 *
 *   1. Contacts nobody holds.
 *   2. Contacts someone else holds that are still sitting at 'working' —
 *      claimed, never actually progressed. Those are taken over, and the
 *      previous holder gets a line in that contact's log saying so.
 *
 * Everything else is left alone: contacts already past 'working' (contacted,
 * replied, qualified, won, lost) represent a live conversation someone is
 * having, and closed or deleted rows aren't in play at all.
 *
 * The rows land with claim_source = 'fresh', which exempts them from the
 * one-contact-per-company cap that governs manual All Leads claims.
 */
async function cascadeFreshClaim(leadId, userId) {
  const company = await db.one(
    `SELECT c.name FROM leads l JOIN companies c ON c.id = l.company_id WHERE l.id = $1`,
    [leadId]
  );
  if (!company) return { company: null, claimed: [], takenOver: [] };

  const days = windowFor("all");

  // Read who is losing what BEFORE the update, or the previous owner is gone.
  const takenOver = await db.all(
    `SELECT cc.id, cc.name, cc.owner_id, u.display_name AS previous_owner
       FROM company_contacts cc
       LEFT JOIN users u ON u.id = cc.owner_id
      WHERE lower(cc.company) = lower($1)
        AND cc.deleted_at IS NULL
        AND cc.closed_at IS NULL
        AND cc.owner_id IS NOT NULL
        AND cc.owner_id <> $2
        -- Anything without a reply yet moves to the Fresh owner. Once someone
        -- has actually replied, that conversation belongs to whoever started
        -- it and is left alone.
        AND cc.status NOT IN ('replied','qualified','won','lost')`,
    [company.name, userId]
  );

  const claimed = await db.all(
    `UPDATE company_contacts
        SET taken_from        = CASE WHEN owner_id IS NOT NULL AND owner_id <> $2
                                     THEN owner_id ELSE taken_from END,
            taken_from_status = CASE WHEN owner_id IS NOT NULL AND owner_id <> $2
                                     THEN status ELSE taken_from_status END,
            owner_id     = $2,
            claimed_at   = now(),
            deadline_at  = now() + ($3 || ' days')::interval,
            closed_at    = NULL,
            claim_source = 'fresh',
            status       = CASE WHEN status = 'new' THEN 'working' ELSE status END
      WHERE lower(company) = lower($1)
        AND deleted_at IS NULL
        AND closed_at IS NULL
        AND (
              owner_id IS NULL
              -- Anything without a reply yet moves across; a conversation that
              -- has had a reply stays with whoever started it.
              OR (owner_id <> $2 AND status NOT IN ('replied','qualified','won','lost'))
            )
      RETURNING id, name`,
    [company.name, userId, days]
  );

  // The people who lost a contact find out from its log, not from a silent
  // change of avatar in a table they might not open for a week.
  for (const row of takenOver) {
    await db.run(
      `INSERT INTO contact_activity (contact_id, user_id, kind, body)
       VALUES ($1, $2, 'note', $3)`,
      [
        row.id,
        userId,
        `Reassigned with the Fresh Leads claim on ${company.name} — was with ${
          row.previous_owner || "someone else"
        } at "working".`,
      ]
    );
  }

  return { company: company.name, claimed, takenOver };
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

module.exports = {
  claim,
  cascadeFreshClaim,
  release,
  close,
  reopen,
  sweepExpired,
  countdown,
  windowFor,
  DAYS,
};
