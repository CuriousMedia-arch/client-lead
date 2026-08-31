/**
 * Google: OAuth, Calendar/Meet, transcripts, and sending mail.
 *
 * Everything here degrades to "not connected" rather than throwing, because
 * the portal has to keep working for people who have not linked an account —
 * which, on the day this ships, is everyone.
 *
 * Setup (once, by an admin):
 *
 *   1. Google Cloud project owned by the curiousmedia.in organisation.
 *   2. OAuth consent screen -> User type: INTERNAL. This is the important one.
 *      Internal apps skip Google's verification and the annual CASA security
 *      assessment entirely; External would mean weeks of review and a
 *      recurring third-party audit fee for exactly the same features.
 *   3. Enable: Google Calendar API, Google Meet API, Gmail API.
 *   4. Create an OAuth client (Web application) with redirect URI
 *      https://<your-domain>/api/google/callback
 *   5. Set the env vars listed below.
 *
 * Env:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REDIRECT_URI     e.g. https://leads.curiousmedia.in/api/google/callback
 *   TOKEN_SECRET            any long random string; encrypts refresh tokens
 */
const crypto = require("crypto");

const db = require("../db");

/*
 * googleapis is loaded on demand, not at the top of this file.
 *
 * It is a very large module — measured at 692ms to require, against 890ms for
 * the entire application. Requiring it at module load meant every cold start
 * paid two thirds of a second before serving anything, on every request that
 * woke a sleeping function, whether or not that request had anything to do
 * with Google. On Vercel, where functions sleep constantly, that is felt as
 * "the whole portal is slow" — because it is, uniformly, on every screen.
 *
 * Cached after the first call, so the cost lands once on whoever books a
 * meeting rather than on everyone who opens a page.
 */
let _google = null;
function api() {
  if (!_google) _google = require("googleapis").google;
  return _google;
}

/**
 * The narrowest set that does the job.
 *
 * calendar.events   create the meeting and get a Meet link
 * meetings.space.readonly + meetings.space.created
 *                   read the conference record and its transcript
 * gmail.send        send the proposal and forward meeting notes
 *
 * Note what is NOT here: no gmail.readonly. Sending is a "sensitive" scope;
 * reading the mailbox is "restricted" and a much bigger thing to hold. Reply
 * tracking would need it, and that is a separate decision to take on purpose.
 */
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/meetings.space.created",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
];

const configured = () =>
  Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

function oauthClient() {
  const { OAuth2 } = api().auth;
  return new OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/* ── token storage ────────────────────────────────────────────────────────── */

/**
 * Refresh tokens are as sensitive as passwords — one is enough to act as that
 * person indefinitely. Encrypted with AES-256-GCM so a leaked database dump is
 * not a leaked set of Google accounts.
 */
function key() {
  const secret = process.env.TOKEN_SECRET || process.env.SESSION_SECRET || "";
  if (!secret) throw new Error("TOKEN_SECRET is not set — refusing to store tokens in plain text.");
  return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

function decrypt(blob) {
  const [iv, tag, data] = String(blob).split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

/* ── connecting ───────────────────────────────────────────────────────────── */

function authUrl(userId) {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    // Without this, Google only returns a refresh token the FIRST time a user
    // ever consents. Reconnecting after a revoke would then silently produce
    // an account that works until the access token expires an hour later.
    prompt: "consent",
    scope: SCOPES,
    state: String(userId),
  });
}

async function saveTokens(userId, code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token. Disconnect the app in your Google account settings and try again.");
  }

  client.setCredentials(tokens);
  let email = null;
  try {
    const info = await api().oauth2({ version: "v2", auth: client }).userinfo.get();
    email = info.data.email;
  } catch {
    // Not fatal — the connection works without knowing which address it is.
  }

  await db.run(
    `INSERT INTO google_accounts (user_id, email, refresh_token, scopes, connected_at, last_error)
     VALUES ($1, $2, $3, $4, now(), NULL)
     ON CONFLICT (user_id) DO UPDATE SET
       email = EXCLUDED.email, refresh_token = EXCLUDED.refresh_token,
       scopes = EXCLUDED.scopes, connected_at = now(), last_error = NULL`,
    [userId, email, encrypt(tokens.refresh_token), SCOPES.join(" ")]
  );

  return { email };
}

async function disconnect(userId) {
  await db.run("DELETE FROM google_accounts WHERE user_id = $1", [userId]);
}

async function accountFor(userId) {
  return db.one("SELECT user_id, email, connected_at, last_error FROM google_accounts WHERE user_id = $1", [userId]);
}

/** An authorised client for this user, or null if they haven't connected. */
async function clientFor(userId) {
  if (!configured()) return null;
  const row = await db.one("SELECT refresh_token FROM google_accounts WHERE user_id = $1", [userId]);
  if (!row) return null;

  const client = oauthClient();
  client.setCredentials({ refresh_token: decrypt(row.refresh_token) });
  await db.run("UPDATE google_accounts SET last_used_at = now() WHERE user_id = $1", [userId]);
  return client;
}

/** Record why a call failed so the UI can say "reconnect" instead of "error". */
async function noteError(userId, message) {
  await db.run("UPDATE google_accounts SET last_error = $2 WHERE user_id = $1", [
    userId,
    String(message).slice(0, 300),
  ]);
}

/* ── Calendar + Meet ──────────────────────────────────────────────────────── */

/**
 * Create the event and let Google mint the Meet link.
 *
 * requestId must be unique per conference or Google returns the existing one —
 * which is why it is a random string rather than anything derived from the
 * meeting, and why rescheduling patches the event instead of creating another.
 */
async function createMeeting(userId, { summary, description, startISO, endISO, attendees }) {
  const auth = await clientFor(userId);
  if (!auth) return null;

  const calendar = api().calendar({ version: "v3", auth });

  const res = await calendar.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    sendUpdates: "all",
    requestBody: {
      summary,
      description,
      start: { dateTime: startISO, timeZone: process.env.TZ_NAME || "Asia/Kolkata" },
      end: { dateTime: endISO, timeZone: process.env.TZ_NAME || "Asia/Kolkata" },
      attendees: (attendees || []).filter(Boolean).map((email) => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: crypto.randomUUID(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
  });

  const ev = res.data;
  return {
    eventId: ev.id,
    meetLink: ev.hangoutLink || (ev.conferenceData && ev.conferenceData.entryPoints
      ? (ev.conferenceData.entryPoints.find((e) => e.entryPointType === "video") || {}).uri
      : null),
    htmlLink: ev.htmlLink,
  };
}

async function cancelMeeting(userId, eventId) {
  const auth = await clientFor(userId);
  if (!auth || !eventId) return false;
  try {
    await api().calendar({ version: "v3", auth }).events.delete({
      calendarId: "primary",
      eventId,
      sendUpdates: "all",
    });
    return true;
  } catch (err) {
    // Already gone is a success as far as we're concerned.
    if (err.code === 404 || err.code === 410) return true;
    throw err;
  }
}

/* ── transcripts ──────────────────────────────────────────────────────────── */

/**
 * Fetch the transcript for a finished meeting.
 *
 * Three things worth knowing, all of which shape the return value:
 *
 *  - Transcription is a manual toggle in the Meet UI by default. There is no
 *    API to force it on. An admin can set it to run automatically for the whole
 *    organisation, and without that this returns 'none' most of the time —
 *    which is why 'none' is a normal outcome here, not an error.
 *  - Artifacts belong to the meeting ORGANISER. If the client hosted the call,
 *    there is nothing to fetch.
 *  - They are not instant. Reports put it as long as 45 minutes after the call
 *    ends, so 'pending' is expected and the caller should try again later.
 */
async function fetchTranscript(userId, { eventId, meetLink }) {
  const auth = await clientFor(userId);
  if (!auth) return { state: "none", reason: "not_connected" };

  const meet = api().meet({ version: "v2", auth });

  // The Meet space is identified by the meeting code — the tail of the Meet
  // link — not by the calendar event id.
  const code = meetLink ? String(meetLink).split("/").filter(Boolean).pop() : null;
  if (!code) return { state: "none", reason: "no_meet_link" };

  try {
    const space = await meet.spaces.get({ name: `spaces/${code}` });
    const spaceName = space.data.name;

    const records = await meet.conferenceRecords.list({
      filter: `space.name = "${spaceName}"`,
      pageSize: 5,
    });
    const list = records.data.conferenceRecords || [];
    if (!list.length) return { state: "pending", reason: "no_conference_yet" };

    // Newest first — a recurring meeting reuses the space.
    const record = list.sort(
      (a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0)
    )[0];

    const transcripts = await meet.conferenceRecords.transcripts.list({ parent: record.name });
    const t = (transcripts.data.transcripts || [])[0];
    if (!t) return { state: "none", reason: "transcription_was_off", conferenceRecord: record.name };
    if (t.state && t.state !== "FILE_GENERATED") {
      return { state: "pending", reason: "still_processing", conferenceRecord: record.name };
    }

    // Entries are per-utterance with speaker attribution. Page through them —
    // an hour of conversation is comfortably more than one page.
    const lines = [];
    let pageToken;
    do {
      const page = await meet.conferenceRecords.transcripts.entries.list({
        parent: t.name,
        pageSize: 1000,
        pageToken,
      });
      for (const e of page.data.transcriptEntries || []) {
        lines.push(`${(e.participant || "").split("/").pop() || "Speaker"}: ${e.text}`);
      }
      pageToken = page.data.nextPageToken;
    } while (pageToken);

    if (!lines.length) return { state: "none", reason: "empty_transcript", conferenceRecord: record.name };

    return { state: "ready", text: lines.join("\n"), conferenceRecord: record.name };
  } catch (err) {
    await noteError(userId, err.message);
    return { state: "error", reason: err.message };
  }
}

/* ── sending mail ─────────────────────────────────────────────────────────── */

/** RFC 2822, base64url. Gmail wants the whole message, not fields. */
function rawMessage({ to, from, subject, body, cc }) {
  const headers = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    from ? `From: ${from}` : null,
    `Subject: =?UTF-8?B?${Buffer.from(subject || "").toString("base64")}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ].filter(Boolean);

  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sendMail(userId, { to, subject, body, cc }) {
  const auth = await clientFor(userId);
  if (!auth) return { sent: false, reason: "not_connected" };

  const account = await accountFor(userId);

  try {
    const res = await api().gmail({ version: "v1", auth }).users.messages.send({
      userId: "me",
      requestBody: { raw: rawMessage({ to, cc, from: account && account.email, subject, body }) },
    });
    return { sent: true, id: res.data.id, threadId: res.data.threadId };
  } catch (err) {
    await noteError(userId, err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = {
  SCOPES,
  configured,
  authUrl,
  saveTokens,
  disconnect,
  accountFor,
  clientFor,
  createMeeting,
  cancelMeeting,
  fetchTranscript,
  sendMail,
};
