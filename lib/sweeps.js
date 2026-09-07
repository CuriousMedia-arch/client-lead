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
 * Release anything whose clock ran out, whichever clock it was on.
 *
 *   contact  claimed and never written to      -> back to the pool, row deleted
 *   reply    written to, no answer in a week   -> back to the pool, row kept
 *   close    they answered, not closed in a week -> back to the pool, row kept
 *
 * The delete/keep split is the point. A lead nobody touched has no history
 * worth preserving and leaving a stub would put a ghost card on someone's
 * Today. A lead that was actually worked has messages, meetings, maybe a price
 * — that is exactly what the next person to pick up this company needs to see,
 * so the row stays and surfaces under "Tried before at this company".
 */
async function sweepDeadlines() {
  const due = await db.all(
    `SELECT id, contact_id, lead_id, source, company, deadline_kind,
            last_contacted_at
       FROM opportunities
      WHERE deadline_at IS NOT NULL
        AND deadline_at < now()
        AND stage NOT IN ('won','lost')`
  );
  if (!due.length) return 0;

  const untouched = [];

  for (const opp of due) {
    const note =
      opp.deadline_kind === "reply"
        ? "Returned automatically — no reply within the week"
        : opp.deadline_kind === "close"
        ? "Returned automatically — not closed within the week"
        : "Returned automatically — no first message was sent";

    // Hand the claim back exactly the way a normal release does, so the lead
    // reappears where the rest of the portal expects to find it.
    if (opp.contact_id) {
      await db.run(
        `UPDATE company_contacts
            SET owner_id = NULL, claimed_at = NULL, deadline_at = NULL,
                claim_source = NULL, status = 'new', release_note = $2
          WHERE id = $1`,
        [opp.contact_id, note]
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
                in_newspaper = true, fresh_released_at = now(),
                fresh_release_note = $2, updated_at = now()
          WHERE id = $1`,
        [opp.lead_id, note]
      );
    }

    if (opp.last_contacted_at) {
      // Worked leads keep their history but lose their owner and their clock,
      // so they stop appearing on anyone's Today while staying readable to
      // whoever picks the company up next.
      //
      // Done per row rather than one UPDATE ... WHERE id = ANY($1): the array
      // binding is a portability trap, and the loop is already open. This
      // sweep only ever touches genuinely overdue rows, so N is small.
      await db.run(
        `UPDATE opportunities
            SET owner_id = NULL, deadline_at = NULL, deadline_kind = NULL,
                next_action = NULL, updated_at = now()
          WHERE id = $1`,
        [opp.id]
      );
    } else {
      untouched.push(opp.id);
    }
  }

  for (const id of untouched) {
    await db.run(`DELETE FROM opportunities WHERE id = $1`, [id]);
  }

  return due.length;
}

/** Kept under its old name — several routes still call it. */
const sweepSilent = sweepDeadlines;

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
 * Write meeting notes without anyone asking.
 *
 * Runs on the same schedule as the other sweeps: picks up meetings that have
 * finished, have no notes, and whose owner has a transcript source connected,
 * then fetches the transcript and turns it into notes. The notes are simply
 * there next time someone opens the lead, instead of waiting behind a button
 * nobody remembers to press.
 *
 * Two things shape the retries:
 *
 *  - Transcripts are not ready when a call ends. Minutes at best, sometimes an
 *    hour. Trying once would miss nearly all of them.
 *  - Many meetings will never have one — a client hosted it, or nobody turned
 *    transcription on. Retrying those every fifteen minutes forever would burn
 *    API calls for the life of the record.
 *
 * So it backs off, and gives up after six tries or when the answer is one that
 * will never change.
 */
async function sweepMeetingNotes() {
  const meetings = require("./meetings");
  const ai = require("./outreachAI");

  const due = await db.all(
    `SELECT m.id, m.calendar_event_id, m.meet_link, m.transcript_attempts,
            o.owner_id, o.company, o.service_primary, o.plan_name
       FROM opportunity_meetings m
       JOIN opportunities o ON o.id = m.opportunity_id
      WHERE m.notes_generated_at IS NULL
        AND (m.notes IS NULL OR m.notes = '')
        AND m.scheduled_at < now() - interval '10 minutes'
        AND m.scheduled_at > now() - interval '7 days'
        AND COALESCE(m.transcript_attempts, 0) < 6
        AND (m.transcript_next_try IS NULL OR m.transcript_next_try < now())
        AND o.owner_id IS NOT NULL
      ORDER BY m.scheduled_at DESC
      LIMIT 20`
  );

  let written = 0;

  for (const m of due) {
    // Back off first, so a throw below cannot turn this into a hot loop.
    const attempts = Number(m.transcript_attempts || 0) + 1;
    const wait = Math.min(15 * 2 ** (attempts - 1), 240);
    await db.run(
      `UPDATE opportunity_meetings
          SET transcript_attempts = $2,
              transcript_next_try = now() + ($3 || ' minutes')::interval
        WHERE id = $1`,
      [m.id, attempts, String(wait)]
    );

    let result;
    try {
      result = await meetings.fetchTranscript(m.owner_id, {
        eventId: m.calendar_event_id,
        meetLink: m.meet_link,
      });
    } catch (err) {
      console.warn(`[notes] meeting ${m.id}:`, err.message);
      continue;
    }

    // Answers that will never change — stop asking.
    const permanent = [
      "transcription_was_off",
      "provider_cannot_transcribe",
      "no_meet_link",
      "not_connected",
    ];
    if (result.state === "none" && permanent.includes(result.reason)) {
      await db.run(
        `UPDATE opportunity_meetings SET transcript_attempts = 6, transcript_state = $2 WHERE id = $1`,
        [m.id, result.reason]
      );
      continue;
    }

    if (result.state !== "ready" || !result.text) continue;   // still processing

    const structured = await ai.structureMeetingNotes(result.text, {
      company: m.company,
      service: m.service_primary,
      plan_name: m.plan_name,
    });

    const summary = [
      structured.requirement ? `What they need: ${structured.requirement}` : null,
      structured.budget_mentioned ? `Budget mentioned: ${structured.budget_mentioned}` : null,
      structured.timeline ? `Timeline: ${structured.timeline}` : null,
      structured.decision_makers && structured.decision_makers.length
        ? `In the room: ${structured.decision_makers.join(", ")}`
        : null,
      structured.objections && structured.objections.length
        ? `Concerns raised: ${structured.objections.join("; ")}`
        : null,
      structured.next_step ? `Next step: ${structured.next_step}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    await db.run(
      `UPDATE opportunity_meetings
          SET transcript_state = 'ready',
              transcript_text = $2,
              transcript_source = COALESCE($3, transcript_source, 'provider'),
              notes = COALESCE(NULLIF(notes, ''), $4),
              outcome = COALESCE(outcome, $5),
              requirement = COALESCE(requirement, $6),
              structured = $7,
              notes_generated_at = now()
        WHERE id = $1`,
      [
        m.id,
        result.text.slice(0, 200000),
        result.provider || null,
        summary,
        structured.outcome || null,
        structured.requirement || null,
        JSON.stringify(structured),
      ]
    );

    written++;
    console.log(`[notes] wrote notes for meeting ${m.id} (${m.company})`);
  }

  return written;
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
    ["deadlines", sweepDeadlines],
    ["notes", sweepMeetingNotes],
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

module.exports = {
  sweepSilent,
  sweepDeadlines,
  sweepExpiredContacts,
  sweepMeetingNotes,
  runAllSweeps,
};
