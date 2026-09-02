/**
 * Fathom's webhook, and a way to check the setup.
 *
 * The webhook is the only route in the app that is not behind a login — it is
 * called by Fathom's servers, not a browser. Its authentication is the HMAC
 * signature, which is why the raw request body has to survive intact all the
 * way here (see the express.raw mount in app.js).
 */
const express = require("express");

const db = require("../db");
const fathom = require("../lib/fathom");
const ai = require("../lib/outreachAI");
const { requireAuth } = require("../lib/auth");

const router = express.Router();

/**
 * A meeting finished processing.
 *
 * Always answers 200 unless the signature is wrong. Fathom retries on any
 * other status, and retrying will not help when the problem is "this call had
 * nothing to do with a lead" — which is most of them, since Fathom records
 * internal meetings too.
 */
router.post("/webhook", async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

  const signature =
    req.get("webhook-signature") ||
    req.get("x-fathom-signature") ||
    req.get("x-signature") ||
    req.get("fathom-signature");

  const check = fathom.verifySignature(raw, signature);
  if (!check.ok) {
    console.warn("[fathom] rejected a webhook:", check.reason);
    return res.status(401).json({ error: check.reason });
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Body was not JSON." });
  }

  try {
    const info = fathom.normalise(payload);

    // The webhook can carry these inline; fetch whatever is missing.
    let text = info.transcript;
    if (!text && info.recordingId && fathom.configured()) {
      text = await fathom.transcriptFor(info.recordingId).catch((err) => {
        console.warn("[fathom] couldn't fetch transcript:", err.message);
        return "";
      });
    }

    if (!info.summary && info.recordingId && fathom.configured()) {
      info.summary = await fathom.summaryFor(info.recordingId).catch(() => "");
    }

    if (!text && !info.summary) {
      console.log("[fathom] nothing usable in", info.recordingId);
      return res.json({ ok: true, matched: false, reason: "no transcript or summary" });
    }

    const match = await fathom.matchMeeting(info);
    if (!match) {
      // Kept, not discarded. An unmatched recording is usually an internal
      // call, but it is also how a matching bug looks — and the admin screen
      // shows these so it is visible rather than silent.
      await db.run(
        `INSERT INTO fathom_unmatched (recording_id, title, started_at, emails, share_url, transcript)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (recording_id) DO NOTHING`,
        [
          info.recordingId, info.title, info.startedAt,
          JSON.stringify(info.emails), info.shareUrl, text.slice(0, 200000),
        ]
      );
      console.log("[fathom] no matching meeting for", info.recordingId);
      return res.json({ ok: true, matched: false, reason: "no matching meeting" });
    }

    await applyTranscript(match.meeting, text, info, match.how);

    res.json({ ok: true, matched: true, meeting_id: match.meeting.id, how: match.how });
  } catch (err) {
    console.error("[fathom] webhook failed:", err.message);
    // 200 on purpose: a retry will hit the same bug. The log is the record.
    res.json({ ok: false, error: err.message });
  }
});

/**
 * Transcript in, notes out.
 *
 * Shared by the webhook and the manual "get notes" button so both produce
 * identical results — the notes are written by our own prompt, in the fields
 * the reporting already reads, with the company and the price in context.
 */
async function applyTranscript(meeting, text, info, how) {
  const context = await db.one(
    `SELECT o.company, o.service_primary, o.plan_name
       FROM opportunity_meetings m JOIN opportunities o ON o.id = m.opportunity_id
      WHERE m.id = $1`,
    [meeting.id]
  );

  /*
   * Whose summary appears on screen — Fathom's or ours.
   *
   * Admin-editable in Settings so it can be changed without a deploy, because
   * it has a cost attached: Fathom's free plan caps advanced summaries at five
   * a month, so choosing theirs means paying for Premium for anyone who hosts
   * meetings.
   */
  const preferFathom = (await notesSource()) === "fathom";

  /*
   * The structured extraction runs either way, and it is not the same thing as
   * the summary.
   *
   * Fathom returns prose. The funnel report, the loss reasons and the "what do
   * they need" line on the card all read individual FIELDS — requirement,
   * budget, timeline, objections, next step. Skipping this to save a Gemini
   * call would leave those blank and quietly break reporting that already
   * works. Gemini is already paid for, so it costs nothing extra.
   */
  const structured = text
    ? await ai.structureMeetingNotes(text, {
        company: context && context.company,
        service: context && context.service_primary,
        plan_name: context && context.plan_name,
      })
    : {};

  const ours = [
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

  // Fathom's summary, with its action items under it.
  const theirs = [info.summary, info.actionItems && `\nAction items\n${info.actionItems}`]
    .filter(Boolean)
    .join("\n");

  // Fall back to ours if Fathom sent nothing — an empty notes box helps nobody.
  const summary = (preferFathom && theirs) || ours || theirs;

  await db.run(
    `UPDATE opportunity_meetings
        SET transcript_state = 'ready',
            transcript_text = $2,
            transcript_source = 'fathom',
            fathom_recording_id = COALESCE($3, fathom_recording_id),
            fathom_share_url = COALESCE($4, fathom_share_url),
            fathom_summary = COALESCE($10, fathom_summary),
            notes = COALESCE(NULLIF(notes, ''), $5),
            outcome = COALESCE(outcome, $6),
            requirement = COALESCE(requirement, $7),
            structured = $8,
            notes_generated_at = now()
      WHERE id = $1`,
    [
      meeting.id,
      text.slice(0, 200000),
      info.recordingId,
      info.shareUrl,
      summary,
      structured.outcome || null,
      structured.requirement || null,
      JSON.stringify(structured),
      theirs || null,
    ]
  );

  console.log(
    `[fathom] notes written for meeting ${meeting.id}, matched by ${how}, ` +
      `summary from ${preferFathom && theirs ? "Fathom" : "the portal"}`
  );
}

/** Is Fathom set up, and is anything arriving? */
router.get("/status", requireAuth, async (req, res, next) => {
  try {
    const [recent, unmatched] = await Promise.all([
      db.one(
        `SELECT COUNT(*)::int AS n FROM opportunity_meetings
          WHERE transcript_source = 'fathom' AND notes_generated_at > now() - interval '30 days'`
      ),
      db.one(`SELECT COUNT(*)::int AS n FROM fathom_unmatched WHERE created_at > now() - interval '30 days'`),
    ]);

    res.json({
      configured: fathom.configured(),
      webhook_secret_set: Boolean(process.env.FATHOM_WEBHOOK_SECRET),
      webhook_url: `${req.protocol}://${req.get("host")}/api/fathom/webhook`,
      notes_last_30_days: recent.n,
      unmatched_last_30_days: unmatched.n,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Recordings that arrived but matched nothing.
 *
 * Mostly internal calls, which is fine. But if a client meeting lands here,
 * something is wrong with the matching and this is where you would see it.
 */
router.get("/unmatched", requireAuth, async (req, res, next) => {
  try {
    res.json({
      items: await db.all(
        `SELECT recording_id, title, started_at, emails, share_url, created_at
           FROM fathom_unmatched ORDER BY created_at DESC LIMIT 25`
      ),
    });
  } catch (err) {
    next(err);
  }
});

/** Which summary the team wants on screen. Defaults to Fathom's. */
async function notesSource() {
  try {
    const row = await db.one("SELECT body FROM content_templates WHERE key = 'notes_source'");
    const value = row && String(row.body || "").trim().toLowerCase();
    return value === "portal" ? "portal" : "fathom";
  } catch {
    return "fathom";
  }
}

module.exports = router;
module.exports.applyTranscript = applyTranscript;
module.exports.notesSource = notesSource;
