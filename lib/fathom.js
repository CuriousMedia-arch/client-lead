/**
 * Fathom — transcripts, without needing anybody's admin.
 *
 * Fathom's bot joins the meeting as a guest and records it itself, so it works
 * on a free Google account, on Zoom, on Teams, on anything. That is the whole
 * reason it is here: Google Meet transcripts need a paid Workspace plan and
 * Teams transcripts need a tenant switch only an admin can flip.
 *
 * We take the TRANSCRIPT and nothing else. Fathom's own AI summaries are a
 * paid feature capped at five a month on the free plan — and we don't want
 * them anyway. lib/outreachAI.js already writes notes that know the company,
 * the service being sold and the price quoted, and puts them in the structured
 * fields the reporting reads. Fathom's would be prose in Fathom's shape.
 *
 * Setup:
 *   1. Fathom → Settings → Integrations → API → create an API key
 *   2. FATHOM_API_KEY on the server
 *   3. Fathom → Settings → Integrations → Webhooks → add
 *      "New meeting content ready" → https://<domain>/api/fathom/webhook
 *      with "Include transcript" ticked
 *   4. Put the webhook's secret in FATHOM_WEBHOOK_SECRET
 */
const crypto = require("crypto");

const db = require("../db");

const API = "https://api.fathom.ai/external/v1";

const configured = () => Boolean(process.env.FATHOM_API_KEY);

/**
 * Is this webhook really from Fathom?
 *
 * HMAC-SHA256 over the raw request body. The raw bytes matter — re-serialising
 * the parsed JSON changes key order and whitespace and the signature stops
 * matching, which is the classic way this check silently starts failing.
 *
 * timingSafeEqual rather than ===, because a plain string compare returns
 * faster on an early mismatch and leaks the signature a byte at a time.
 */
function verifySignature(rawBody, signature) {
  const secret = process.env.FATHOM_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: "FATHOM_WEBHOOK_SECRET is not set on the server." };
  if (!signature) return { ok: false, reason: "The request carried no signature header." };

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  // Providers vary: some send the hex digest bare, some prefix it, some use
  // base64. Compare against the plausible forms rather than assuming one.
  const offered = String(signature).replace(/^sha256=/i, "").trim();
  const candidates = [
    expected,
    Buffer.from(expected, "hex").toString("base64"),
  ];

  const ok = candidates.some((c) => {
    const a = Buffer.from(c);
    const b = Buffer.from(offered);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });

  return ok ? { ok: true } : { ok: false, reason: "Signature did not match." };
}

async function call(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { "X-Api-Key": process.env.FATHOM_API_KEY, Accept: "application/json" },
  });

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `Fathom returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Turn whatever Fathom sent into speaker-attributed lines.
 *
 * The transcript arrives as an array of items with a speaker object, or
 * occasionally as a plain string. Both are handled because the shape has
 * changed once already and the cost of being wrong is an empty set of notes.
 */
function transcriptToLines(transcript) {
  if (!transcript) return "";
  if (typeof transcript === "string") return transcript.trim();
  if (!Array.isArray(transcript)) return "";

  const lines = [];
  let last = null;

  for (const item of transcript) {
    const who =
      (item.speaker && (item.speaker.display_name || item.speaker.name)) ||
      item.speaker_name ||
      item.display_name ||
      "Speaker";
    const said = String(item.text || item.transcript || "").trim();
    if (!said) continue;

    // Merge consecutive lines from one person — a per-utterance transcript is
    // mostly speaker labels otherwise, and that is wasted context for the model.
    if (who === last && lines.length) lines[lines.length - 1] += ` ${said}`;
    else {
      lines.push(`${who}: ${said}`);
      last = who;
    }
  }

  return lines.join("\n").trim();
}

/** Pull the transcript for a recording, when the webhook didn't carry one. */
async function transcriptFor(recordingId) {
  const data = await call(`/recordings/${recordingId}/transcript`);
  return transcriptToLines(data.items || data.transcript || data);
}

/**
 * Flatten a webhook body or a meetings-list entry into the same shape.
 *
 * Fathom sends slightly different envelopes depending on where the data came
 * from, and half the fields have two plausible names. Normalising once here
 * means the matching logic below reads as logic rather than as a pile of
 * fallbacks.
 */
function normalise(payload) {
  const m = payload.meeting || payload.recording || payload;

  const invitees = m.calendar_invitees || m.invitees || [];

  return {
    recordingId: m.recording_id || m.id || payload.recording_id || null,
    title: m.title || m.meeting_title || null,
    shareUrl: m.share_url || m.url || null,
    // The URL of the meeting itself (a Meet or Teams link), not Fathom's page.
    meetingUrl: m.meeting_url || m.calendar_meeting_url || m.join_url || null,
    startedAt:
      m.recording_start_time || m.scheduled_start_time || m.created_at || null,
    emails: invitees
      .map((i) => (typeof i === "string" ? i : i.email))
      .filter(Boolean)
      .map((e) => e.toLowerCase()),
    transcript: transcriptToLines(m.transcript || payload.transcript),
    summary: summaryText(m.default_summary || m.summary || payload.summary),
    actionItems: actionItemsText(m.action_items || payload.action_items),
  };
}

/**
 * Fathom's summary, however it arrived.
 *
 * It comes back either as markdown or as an object carrying the markdown plus
 * the template it was written from. Both shapes appear in the wild.
 */
function summaryText(summary) {
  if (!summary) return "";
  if (typeof summary === "string") return summary.trim();
  return String(summary.markdown_formatted || summary.markdown || summary.text || "").trim();
}

/** Action items as a plain list, appended under the summary. */
function actionItemsText(items) {
  if (!items || !Array.isArray(items) || !items.length) return "";
  return items
    .map((i) => {
      const text = typeof i === "string" ? i : i.description || i.text || i.title;
      if (!text) return null;
      const who = i.assignee && (i.assignee.name || i.assignee.display_name);
      return `• ${text}${who ? ` — ${who}` : ""}`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Which meeting in the portal is this?
 *
 * Three ways, tried in order of how certain they are:
 *
 *  1. The meeting link matches exactly. Unambiguous when it is there, but
 *     Fathom does not always include it.
 *  2. A calendar invitee's email matches a contact on an opportunity, and the
 *     times are close. This is the one that usually fires.
 *  3. Time alone, within a tight window, when only one meeting is a candidate.
 *     Deliberately last and deliberately refuses to guess between two.
 *
 * Returning null is a normal outcome — Fathom records internal calls too, and
 * those have no opportunity behind them.
 */
async function matchMeeting(info) {
  if (info.meetingUrl) {
    const byLink = await db.one(
      `SELECT * FROM opportunity_meetings WHERE meet_link = $1 ORDER BY scheduled_at DESC LIMIT 1`,
      [info.meetingUrl]
    );
    if (byLink) return { meeting: byLink, how: "meeting link" };
  }

  if (!info.startedAt) return null;

  // Two hours either side: a call can start late or run over, and Fathom's
  // timestamp is when recording began, not when the invite said.
  const near = await db.all(
    `SELECT m.*, o.company,
            COALESCE(fc.email, cc.email) AS contact_email
       FROM opportunity_meetings m
       JOIN opportunities o ON o.id = m.opportunity_id
       LEFT JOIN company_contacts cc ON cc.id = o.contact_id
       LEFT JOIN company_contacts fc ON fc.id = o.focus_contact_id
      WHERE m.scheduled_at BETWEEN $1::timestamptz - interval '2 hours'
                               AND $1::timestamptz + interval '2 hours'
      ORDER BY m.scheduled_at`,
    [info.startedAt]
  );

  if (!near.length) return null;

  if (info.emails.length) {
    const byEmail = near.find(
      (m) => m.contact_email && info.emails.includes(m.contact_email.toLowerCase())
    );
    if (byEmail) return { meeting: byEmail, how: "who was invited" };
  }

  // Only when there is exactly one candidate. Attaching a client's transcript
  // to the wrong company would be considerably worse than attaching it to none.
  if (near.length === 1) return { meeting: near[0], how: "the time it started" };

  return null;
}

module.exports = {
  configured,
  verifySignature,
  normalise,
  matchMeeting,
  transcriptFor,
  transcriptToLines,
  summaryText,
  actionItemsText,
  summaryFor,
};

/** Fetch the summary for a recording, when the webhook didn't carry one. */
async function summaryFor(recordingId) {
  const data = await call(`/recordings/${recordingId}/summary`);
  return summaryText(data);
}
