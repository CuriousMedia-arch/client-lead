/**
 * The Fresh Leads clock.
 *
 * A Fresh claim isn't one flat deadline — it's a sequence of checkpoints, each
 * asking a different question:
 *
 *   12h with no activity   warn the owner
 *   24h with no activity   release it; they never started
 *    7d without a reply    to the Newspaper; the approach isn't landing
 *   15d without closing    to the Newspaper; it's stalled
 *
 * Where a lapsed claim goes depends on how long it was held. Released inside
 * three days it goes back to Fresh Leads, because it's still news. After that
 * the story is stale and it belongs in the Newspaper.
 *
 * Every check is idempotent and driven by timestamps, so running it twice
 * changes nothing and a missed run only delays a transition.
 */
const db = require("../db");
const { notify } = require("./notify");

const HOURS = (n) => `${n} hours`;

const RULES = {
  warnAfterHours: Number(process.env.FRESH_WARN_HOURS || 12),
  releaseAfterHours: Number(process.env.FRESH_IDLE_RELEASE_HOURS || 24),
  replyByDays: Number(process.env.FRESH_REPLY_DAYS || 7),
  closeByDays: Number(process.env.FRESH_CLOSE_DAYS || 15),
  backToFreshWithinDays: Number(process.env.FRESH_RETURN_DAYS || 3),
};

/**
 * Anything the owner does counts as activity: logging a call, moving the
 * stage, claiming a contact at that company. It's what all four checkpoints
 * are measured from.
 */
function touch(leadId) {
  return db.run(
    "UPDATE leads SET fresh_last_activity_at = now(), fresh_warned_at = NULL WHERE id = $1",
    [leadId]
  );
}

/** Where a released Fresh claim should land, given how long it was held. */
async function returnDestination(lead) {
  const claimedAt = lead.fresh_claimed_at ? new Date(lead.fresh_claimed_at).getTime() : Date.now();
  const heldDays = (Date.now() - claimedAt) / 86400000;
  return heldDays <= RULES.backToFreshWithinDays ? "fresh" : "newspaper";
}

/** Hand a Fresh claim back, to whichever pool it belongs in. */
async function releaseFresh(leadId, { note = null, toNewspaper = null } = {}) {
  const lead = await db.one("SELECT * FROM leads WHERE id = $1", [leadId]);
  if (!lead) return null;

  const destination =
    toNewspaper === null ? await returnDestination(lead) : toNewspaper ? "newspaper" : "fresh";

  return db.one(
    `UPDATE leads
        SET fresh_owner_id = NULL,
            fresh_claimed_at = NULL,
            fresh_deadline_at = NULL,
            fresh_last_activity_at = NULL,
            fresh_warned_at = NULL,
            fresh_release_note = $2,
            fresh_released_at = now(),
            in_newspaper = $3,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [leadId, note, destination === "newspaper"]
  );
}

/**
 * Run every checkpoint. Called on a schedule and before any list is served, so
 * the board is truthful even if nothing scheduled has fired.
 */
async function runChecks() {
  const result = { warned: 0, releasedIdle: 0, toNewspaper: 0 };

  // --- 12 hours idle: warn ---------------------------------------------------
  const idle = await db.all(
    `SELECT l.id, l.fresh_owner_id, c.name AS company
       FROM leads l JOIN companies c ON c.id = l.company_id
      WHERE l.fresh_owner_id IS NOT NULL
        AND l.fresh_closed_at IS NULL
        AND l.fresh_warned_at IS NULL
        AND COALESCE(l.fresh_last_activity_at, l.fresh_claimed_at) < now() - interval '${HOURS(
          RULES.warnAfterHours
        )}'`
  );

  for (const l of idle) {
    await notify(
      l.fresh_owner_id,
      "idle",
      `No progress on ${l.company}`,
      `You claimed ${l.company} ${RULES.warnAfterHours} hours ago and nothing has been logged. ` +
        `If nothing happens in the next ${RULES.releaseAfterHours - RULES.warnAfterHours} hours ` +
        `it goes back to Fresh Leads for someone else.`,
      l.id,
      `idle-${l.id}-${new Date().toISOString().slice(0, 10)}`
    );
    await db.run("UPDATE leads SET fresh_warned_at = now() WHERE id = $1", [l.id]);
    result.warned++;
  }

  // --- 24 hours idle: release ------------------------------------------------
  const stale = await db.all(
    `SELECT l.id, l.fresh_owner_id, c.name AS company
       FROM leads l JOIN companies c ON c.id = l.company_id
      WHERE l.fresh_owner_id IS NOT NULL
        AND l.fresh_closed_at IS NULL
        AND COALESCE(l.fresh_last_activity_at, l.fresh_claimed_at) < now() - interval '${HOURS(
          RULES.releaseAfterHours
        )}'`
  );

  for (const l of stale) {
    const owner = l.fresh_owner_id;
    await releaseFresh(l.id, {
      note: `Auto-released — nothing logged in ${RULES.releaseAfterHours} hours.`,
    });
    await notify(
      owner,
      "idle",
      `${l.company} released`,
      `Nothing was logged in ${RULES.releaseAfterHours} hours, so ${l.company} has gone back for someone else to pick up.`,
      l.id,
      `released-${l.id}`
    );
    result.releasedIdle++;
  }

  // --- 7 days without a reply, 15 without closing: Newspaper -----------------
  const missed = await db.all(
    `SELECT l.id, l.fresh_owner_id, l.status, c.name AS company,
            (l.fresh_claimed_at < now() - interval '${RULES.replyByDays} days'
             AND l.status NOT IN ('replied','qualified','won')) AS no_reply,
            (l.fresh_claimed_at < now() - interval '${RULES.closeByDays} days') AS not_closed
       FROM leads l JOIN companies c ON c.id = l.company_id
      WHERE l.fresh_owner_id IS NOT NULL
        AND l.fresh_closed_at IS NULL
        AND (l.fresh_claimed_at < now() - interval '${RULES.replyByDays} days')`
  );

  for (const l of missed) {
    if (!l.no_reply && !l.not_closed) continue;

    const owner = l.fresh_owner_id;
    const why = l.not_closed
      ? `Not closed within ${RULES.closeByDays} days.`
      : `No reply within ${RULES.replyByDays} days.`;

    await releaseFresh(l.id, { note: `Auto-released — ${why}`, toNewspaper: true });
    await notify(
      owner,
      "deadline",
      `${l.company} moved to the Newspaper`,
      `${why} It's in the Newspaper now for anyone to pick up.`,
      l.id,
      `np-${l.id}`
    );
    result.toNewspaper++;
  }

  return result;
}

module.exports = { runChecks, touch, releaseFresh, returnDestination, RULES };
