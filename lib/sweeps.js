/**
 * Every time-based sweep in the portal, in one place.
 *
 * The problem this solves: each sweep used to be called from whichever route
 * happened to need it, which meant a deadline only passed when somebody loaded
 * the right page. Nobody opens the portal on a Sunday, so a lead due back on
 * Saturday sat claimed until Monday morning — and the countdown a salesperson
 * saw on Friday was quietly a lie.
 *
 * So the sweeps live here and get called from two directions:
 *
 *   - on request, as before, so a page is never stale for the person looking
 *     at it right now;
 *   - on a schedule, so deadlines pass on time whether or not anyone is
 *     logged in.
 *
 * Both call the same function. That matters more than it sounds: a cron that
 * runs slightly different logic from the request path is how you end up with a
 * lead that is released according to one screen and claimed according to
 * another.
 *
 * Everything here is idempotent — each sweep selects only rows that are
 * genuinely overdue and then makes them not-overdue, so running it twice in a
 * row is a no-op the second time. That is what makes it safe to call from a
 * request, a cron and a manual admin button all at once.
 */
const db = require("../db");
const lifecycle = require("./lifecycle");

/**
 * Send-or-lose-it: a lead claimed and never messaged goes back to the pool.
 *
 * Worse than an unclaimed lead, because it looks handled — so nobody else
 * touches it while it rots. Only opportunities still at 'new' with nothing
 * ever sent are eligible; logging a first message clears silent_until and
 * takes the row out of this query permanently.
 */
async function sweepSilent() {
  const due = await db.all(
    `SELECT id, contact_id, lead_id, source, company
       FROM opportunities
      WHERE silent_until IS NOT NULL
        AND silent_until < now()
        AND stage = 'new'
        AND last_contacted_at IS NULL`
  );
  if (!due.length) return 0;

  for (const opp of due) {
    // Hand the claim back exactly the way a normal release does, so the lead
    // reappears where the rest of the portal expects to find it.
    if (opp.contact_id) {
      await db.run(
        `UPDATE company_contacts
            SET owner_id = NULL, claimed_at = NULL, deadline_at = NULL,
                claim_source = NULL, status = 'new',
                release_note = 'Returned automatically — no first message was sent'
          WHERE id = $1`,
        [opp.contact_id]
      );
    } else if (opp.lead_id && opp.source === "all") {
      await db.run(
        `UPDATE leads
            SET owner_id = NULL, claimed_at = NULL, claim_source = NULL,
                deadline_at = NULL, status = 'new', updated_at = now()
          WHERE id = $1`,
        [opp.lead_id]
      );
    } else if (opp.lead_id) {
      // A Fresh claim that lapses goes to the Newspaper, not the open pool —
      // that is what lifecycle.sweepExpired does with a Fresh timeout, and the
      // two paths must not disagree about where a lead lands.
      await db.run(
        `UPDATE leads
            SET fresh_owner_id = NULL, fresh_claimed_at = NULL, fresh_deadline_at = NULL,
                in_newspaper = true, fresh_released_at = now(), updated_at = now()
          WHERE id = $1`,
        [opp.lead_id]
      );
    }
  }

  // The opportunity goes with the claim. Nothing was ever done on it — no
  // messages, no meetings, no price — so there is no history worth keeping,
  // and leaving a stub would put a ghost card on someone's Today screen.
  await db.run(`DELETE FROM opportunities WHERE id = ANY($1)`, [due.map((o) => o.id)]);

  return due.length;
}

/** Release every person claim whose clock has run out. */
async function sweepExpiredContacts() {
  const res = await db.run(
    `UPDATE company_contacts
        SET owner_id = NULL, claimed_at = NULL, deadline_at = NULL,
            claim_source = NULL, status = 'new'
      WHERE owner_id IS NOT NULL
        AND deleted_at IS NULL
        AND closed_at IS NULL
        AND deadline_at IS NOT NULL
        AND deadline_at < now()`
  );
  return (res && res.rowCount) || 0;
}

/**
 * Run everything, and never let one failure stop the rest.
 *
 * A sweep that throws must not take the others down with it: if the silence
 * sweep hits a bad row, expired claims should still be released. Each result
 * is reported separately so a cron log says which one had a problem rather
 * than just "sweep failed".
 */
async function runAllSweeps() {
  const result = { at: new Date().toISOString() };

  for (const [name, fn] of [
    ["leads", async () => lifecycle.sweepExpired()],
    ["contacts", sweepExpiredContacts],
    ["silent", sweepSilent],
  ]) {
    try {
      result[name] = await fn();
    } catch (err) {
      result[name] = { error: err.message };
      console.error(`[sweeps] ${name} failed:`, err.message);
    }
  }

  return result;
}

module.exports = { sweepSilent, sweepExpiredContacts, runAllSweeps };
