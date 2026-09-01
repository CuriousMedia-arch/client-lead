/**
 * Microsoft: OAuth, Outlook calendar, Teams meetings, transcripts, Outlook mail.
 *
 * The Microsoft half of the same job lib/google.js does. Curious Media already
 * pays for Microsoft 365, which includes Teams — so this gets meeting links,
 * transcripts and sending mail on licences that already exist, rather than
 * buying a second stack.
 *
 * Deliberately no SDK. Graph is plain REST and Node has fetch built in;
 * @azure/msal-node and the Graph client would add a heavy dependency to the
 * cold-start path, which is the exact problem that made the portal feel slow
 * everywhere (googleapis, 692ms). Everything here is a fetch call.
 *
 * Setup (once, by whoever administers the Microsoft tenant):
 *
 *   1. Entra admin centre → App registrations → New registration
 *      Accounts: "Accounts in this organizational directory only"
 *      Redirect URI (Web): https://<your-domain>/api/microsoft/callback
 *   2. Certificates & secrets → New client secret → copy the VALUE
 *   3. API permissions → Microsoft Graph → Delegated:
 *        offline_access, User.Read, Calendars.ReadWrite,
 *        OnlineMeetings.ReadWrite, OnlineMeetingTranscript.Read.All, Mail.Send
 *      then Grant admin consent.
 *   4. Teams admin centre → Meetings → Meeting settings →
 *      Transcript API access → turn Microsoft Graph access ON.
 *      This is a tenant switch Microsoft began enforcing on 29 July 2026 and
 *      it is OFF by default. Without it, every transcript request fails no
 *      matter how the permissions are configured.
 *
 * Env:
 *   MS_CLIENT_ID
 *   MS_CLIENT_SECRET
 *   MS_TENANT_ID       your directory (tenant) ID
 *   MS_REDIRECT_URI    https://<your-domain>/api/microsoft/callback
 *   TOKEN_SECRET       shared with the Google integration
 */
const db = require("../db");
const { encrypt, decrypt } = require("./tokens");

const GRAPH = "https://graph.microsoft.com/v1.0";

/**
 * The narrowest set that does the job.
 *
 * OnlineMeetingTranscript.Read.All is the least-privileged DELEGATED permission
 * Microsoft offers for listing a meeting's transcripts — there is no narrower
 * one. Delegated, not application: the portal acts as the person who signed
 * in and can only ever see their own meetings. The application-permission
 * route would let it read every meeting in the company, which is far more
 * power than "put a link on my calendar" needs.
 */
const SCOPES = [
  "offline_access",
  "User.Read",
  "Calendars.ReadWrite",
  "OnlineMeetings.ReadWrite",
  "OnlineMeetingTranscript.Read.All",
  "Mail.Send",
];

const configured = () => Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);

const tenant = () => process.env.MS_TENANT_ID || "organizations";

const authority = () => `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0`;

/* ── connecting ───────────────────────────────────────────────────────────── */

function authUrl(userId) {
  const p = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    response_type: "code",
    redirect_uri: process.env.MS_REDIRECT_URI,
    response_mode: "query",
    scope: SCOPES.join(" "),
    state: String(userId),
    // Force the consent screen so a refresh token comes back even for someone
    // who has approved this app before.
    prompt: "consent",
  });
  return `${authority()}/authorize?${p}`;
}

async function exchange(body) {
  const res = await fetch(`${authority()}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      redirect_uri: process.env.MS_REDIRECT_URI,
      ...body,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || `Microsoft returned ${res.status}`);
  }
  return data;
}

async function saveTokens(userId, code) {
  const tokens = await exchange({ grant_type: "authorization_code", code });
  if (!tokens.refresh_token) {
    throw new Error("Microsoft did not return a refresh token. Make sure offline_access is in the app's permissions.");
  }

  let email = null;
  try {
    const me = await fetch(`${GRAPH}/me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    }).then((r) => r.json());
    email = me.mail || me.userPrincipalName || null;
  } catch {
    // Not fatal — the connection works without knowing which address it is.
  }

  await db.run(
    `INSERT INTO microsoft_accounts (user_id, email, refresh_token, scopes, connected_at, last_error)
     VALUES ($1, $2, $3, $4, now(), NULL)
     ON CONFLICT (user_id) DO UPDATE SET
       email = EXCLUDED.email, refresh_token = EXCLUDED.refresh_token,
       scopes = EXCLUDED.scopes, connected_at = now(), last_error = NULL`,
    [userId, email, encrypt(tokens.refresh_token), SCOPES.join(" ")]
  );

  return { email };
}

async function disconnect(userId) {
  await db.run("DELETE FROM microsoft_accounts WHERE user_id = $1", [userId]);
}

async function accountFor(userId) {
  return db.one(
    "SELECT user_id, email, connected_at, last_error FROM microsoft_accounts WHERE user_id = $1",
    [userId]
  );
}

async function noteError(userId, message) {
  await db.run("UPDATE microsoft_accounts SET last_error = $2 WHERE user_id = $1", [
    userId,
    String(message).slice(0, 300),
  ]);
}

/**
 * A usable access token for this user, or null if they haven't connected.
 *
 * Access tokens last about an hour, so one is minted per call from the stored
 * refresh token. Microsoft may hand back a NEW refresh token on the way — if
 * we ignored it, the old one would eventually be retired and the connection
 * would die silently weeks later.
 */
async function tokenFor(userId) {
  if (!configured()) return null;
  const row = await db.one("SELECT refresh_token FROM microsoft_accounts WHERE user_id = $1", [userId]);
  if (!row) return null;

  const tokens = await exchange({
    grant_type: "refresh_token",
    refresh_token: decrypt(row.refresh_token),
    scope: SCOPES.join(" "),
  });

  if (tokens.refresh_token) {
    await db.run("UPDATE microsoft_accounts SET refresh_token = $2, last_used_at = now() WHERE user_id = $1", [
      userId,
      encrypt(tokens.refresh_token),
    ]);
  } else {
    await db.run("UPDATE microsoft_accounts SET last_used_at = now() WHERE user_id = $1", [userId]);
  }

  return tokens.access_token;
}

/** Every Graph call goes through here so errors read the same way. */
async function graph(token, path, { method = "GET", body } = {}) {
  const res = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return {};

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `Graph returned ${res.status}`);
    err.status = res.status;
    err.code = data.error && data.error.code;
    throw err;
  }
  return data;
}

/* ── Outlook calendar + Teams meeting ─────────────────────────────────────── */

/**
 * Create the calendar event and let Teams mint the join link.
 *
 * isOnlineMeeting + teamsForBusiness is what turns an ordinary Outlook event
 * into a Teams meeting. Creating the event (rather than a bare onlineMeeting)
 * matters for later: Graph will not return transcripts for meetings that have
 * no calendar event behind them.
 */
async function createMeeting(userId, { summary, description, startISO, endISO, attendees }) {
  const token = await tokenFor(userId);
  if (!token) return null;

  const tz = process.env.TZ_NAME || "Asia/Kolkata";

  const event = await graph(token, "/me/events", {
    method: "POST",
    body: {
      subject: summary,
      body: { contentType: "text", content: description || "" },
      start: { dateTime: startISO.replace("Z", ""), timeZone: "UTC" },
      end: { dateTime: endISO.replace("Z", ""), timeZone: "UTC" },
      attendees: (attendees || [])
        .filter(Boolean)
        .map((email) => ({ emailAddress: { address: email }, type: "required" })),
      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness",
      originalStartTimeZone: tz,
    },
  });

  return {
    eventId: event.id,
    meetLink: (event.onlineMeeting && event.onlineMeeting.joinUrl) || null,
    htmlLink: event.webLink,
  };
}

async function cancelMeeting(userId, eventId) {
  const token = await tokenFor(userId);
  if (!token || !eventId) return false;
  try {
    await graph(token, `/me/events/${eventId}`, { method: "DELETE" });
    return true;
  } catch (err) {
    if (err.status === 404 || err.status === 410) return true;   // already gone
    throw err;
  }
}

/* ── transcripts ──────────────────────────────────────────────────────────── */

/**
 * Fetch the transcript for a finished Teams meeting.
 *
 * Three things shape the return value, and all three are normal outcomes
 * rather than errors:
 *
 *  - Transcription has to have been running. Nobody pressing "start
 *    transcript" means there is nothing to fetch, forever.
 *  - The tenant switch has to be on. Microsoft began enforcing a tenant-level
 *    "Transcript API access" control on 29 July 2026 and it is OFF by default;
 *    with it off, Graph refuses regardless of permissions. That failure is
 *    caught and reported in words, because it is fixed by an admin in a
 *    settings page, not by anything in this code.
 *  - Transcripts are not instant. 'pending' means try again shortly.
 */
async function fetchTranscript(userId, { eventId, meetLink }) {
  const token = await tokenFor(userId);
  if (!token) return { state: "none", reason: "not_connected" };
  if (!meetLink) return { state: "none", reason: "no_meet_link" };

  try {
    // The transcript hangs off the onlineMeeting, which is looked up by its
    // join URL — the only handle the calendar event gives us.
    /*
     * The whole $filter expression is encoded as one unit, not just the URL.
     *
     * The obvious version — encodeURIComponent on the join URL, dropped into a
     * template string — leaves the raw spaces in `JoinWebUrl eq '...'`
     * unencoded, and Graph rejects the query. A Teams join URL also carries a
     * `?context={"Tid":"..."}` fragment full of braces and quotes, which has to
     * be escaped or it terminates the query string early.
     *
     * A single quote inside the value is doubled, per OData, before any of
     * this — otherwise it closes the string literal.
     */
    const filter = encodeURIComponent(`JoinWebUrl eq '${meetLink.replace(/'/g, "''")}'`);
    const found = await graph(token, `/me/onlineMeetings?$filter=${filter}`);
    const meeting = (found.value || [])[0];
    if (!meeting) return { state: "pending", reason: "no_conference_yet" };

    const list = await graph(token, `/me/onlineMeetings/${meeting.id}/transcripts`);
    const transcript = (list.value || [])[0];
    if (!transcript) {
      return { state: "none", reason: "transcription_was_off", conferenceRecord: meeting.id };
    }

    // Content comes back as VTT, which is timestamps and cue markers around
    // the words. Strip it to speaker-attributed lines — that is what the notes
    // prompt wants, and it is a third of the tokens.
    const res = await fetch(
      `${GRAPH}/me/onlineMeetings/${meeting.id}/transcripts/${transcript.id}/content?$format=text/vtt`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      const body = await res.text();
      if (/GraphAccessToTranscriptsDisabled/i.test(body)) {
        return { state: "error", reason: "tenant_switch_off" };
      }
      return { state: "error", reason: `Graph returned ${res.status}` };
    }

    const text = vttToLines(await res.text());
    if (!text) return { state: "none", reason: "empty_transcript", conferenceRecord: meeting.id };

    return { state: "ready", text, conferenceRecord: meeting.id };
  } catch (err) {
    if (/GraphAccessToTranscriptsDisabled/i.test(err.message || "") ||
        /disabled for this tenant/i.test(err.message || "")) {
      return { state: "error", reason: "tenant_switch_off" };
    }
    await noteError(userId, err.message);
    return { state: "error", reason: err.message };
  }
}

/** WebVTT → "Speaker: what they said", one line per utterance. */
function vttToLines(vtt) {
  const lines = [];
  let speaker = null;

  for (const raw of String(vtt).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "WEBVTT" || /^\d+$/.test(line) || line.includes("-->")) continue;

    // Teams wraps the speaker in a voice tag: <v Rahul Sharma>text</v>
    const voiced = line.match(/^<v\s+([^>]+)>(.*?)<\/v>$/);
    if (voiced) {
      const [, who, said] = voiced;
      if (who !== speaker) {
        speaker = who;
        lines.push(`${who}: ${said.trim()}`);
      } else if (lines.length) {
        lines[lines.length - 1] += ` ${said.trim()}`;
      }
      continue;
    }
    lines.push(line);
  }

  return lines.join("\n").trim();
}

/* ── sending mail ─────────────────────────────────────────────────────────── */

async function sendMail(userId, { to, subject, body, cc }) {
  const token = await tokenFor(userId).catch(() => null);
  if (!token) return { sent: false, reason: "not_connected" };

  try {
    await graph(token, "/me/sendMail", {
      method: "POST",
      body: {
        message: {
          subject,
          body: { contentType: "text", content: body },
          toRecipients: [{ emailAddress: { address: to } }],
          ...(cc ? { ccRecipients: [{ emailAddress: { address: cc } }] } : {}),
        },
        saveToSentItems: true,
      },
    });
    return { sent: true };
  } catch (err) {
    await noteError(userId, err.message);
    return { sent: false, reason: err.message };
  }
}

/**
 * Is the Microsoft setup actually done?
 *
 * Every step of it lives in somebody else's admin console, and the failure
 * modes are indistinguishable from the outside: a missing permission, an
 * unconsented app and a tenant switch left off all produce "it didn't work".
 *
 * So this walks the chain in order and stops at the first broken link, naming
 * the exact console and setting that fixes it. Each check is the cheapest call
 * that can only succeed if the thing before it is right.
 */
async function diagnose(userId) {
  const steps = [];
  const add = (name, ok, detail, fix) => steps.push({ name, ok, detail, fix });

  // 1. Settings on this deployment.
  const missing = ["MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_TENANT_ID", "MS_REDIRECT_URI"]
    .filter((k) => !process.env[k]);

  add(
    "Credentials are set on the server",
    missing.length === 0,
    missing.length ? `Missing: ${missing.join(", ")}` : "All four present",
    "Add them in Vercel → Settings → Environment Variables, then redeploy. Vercel does not pick up new variables without one."
  );
  if (missing.length) return { ok: false, steps };

  add(
    "Redirect URI looks right",
    /\/api\/microsoft\/callback$/.test(process.env.MS_REDIRECT_URI || ""),
    process.env.MS_REDIRECT_URI,
    "It must end with /api/microsoft/callback and match the Redirect URI on the app registration character for character."
  );

  // 2. Has this person connected?
  const account = await accountFor(userId);
  add(
    "You have connected your Microsoft account",
    Boolean(account),
    account ? `Connected as ${account.email || "unknown"}` : "Not connected yet",
    "Open a lead → Meetings tab → Connect Microsoft."
  );
  if (!account) return { ok: false, steps };

  // 3. Do the client id, secret and tenant actually work together? This is the
  //    first call that talks to Microsoft, so it fails loudly if any of the
  //    three is wrong or the secret has expired.
  let token = null;
  try {
    token = await tokenFor(userId);
    add("Microsoft accepts the credentials", true, "Got an access token", null);
  } catch (err) {
    add(
      "Microsoft accepts the credentials",
      false,
      err.message,
      /expired|invalid_client/i.test(err.message)
        ? "The client secret is wrong or has expired. Entra → App registrations → your app → Certificates & secrets → new secret, then update MS_CLIENT_SECRET."
        : "Check MS_CLIENT_ID and MS_TENANT_ID against the app registration's Overview page. If those are right, disconnect and reconnect your account."
    );
    return { ok: false, steps };
  }

  const probe = async (name, path, fix) => {
    try {
      await graph(token, path);
      add(name, true, "Working", null);
      return true;
    } catch (err) {
      add(name, false, err.message, fix);
      return false;
    }
  };

  // 4. One permission at a time, cheapest call for each.
  await probe(
    "Can read your profile (User.Read)",
    "/me",
    "Entra → your app → API permissions → add delegated User.Read → Grant admin consent."
  );

  await probe(
    "Can create calendar invites (Calendars.ReadWrite)",
    "/me/calendar",
    "Entra → your app → API permissions → add delegated Calendars.ReadWrite → Grant admin consent. Without this, meetings save but get no Teams link."
  );

  const meetingsOk = await probe(
    "Can see Teams meetings (OnlineMeetings.ReadWrite)",
    "/me/onlineMeetings?$top=1",
    "Entra → your app → API permissions → add delegated OnlineMeetings.ReadWrite → Grant admin consent."
  );

  // 5. The tenant switch. Only reachable if the step above passed, and it is
  //    the one people miss — off by default, and enforced since 29 July 2026.
  if (meetingsOk) {
    try {
      const list = await graph(token, "/me/onlineMeetings?$top=1");
      const meeting = (list.value || [])[0];

      if (!meeting) {
        add(
          "Transcript access is switched on",
          null,
          "No Teams meetings on this account yet, so this can't be tested. Book one through the portal and run this again.",
          null
        );
      } else {
        await graph(token, `/me/onlineMeetings/${meeting.id}/transcripts`);
        add("Transcript access is switched on", true, "Graph returned transcripts", null);
      }
    } catch (err) {
      const blocked =
        /GraphAccessToTranscriptsDisabled/i.test(err.message) ||
        /disabled for this tenant/i.test(err.message);
      add(
        "Transcript access is switched on",
        false,
        err.message,
        blocked
          ? "Teams admin centre → Meetings → Meeting settings → Transcript API access → turn Microsoft Graph access ON, and enable speaker attribution. It is off by default and can take 30 minutes to take effect."
          : "Entra → your app → API permissions → add delegated OnlineMeetingTranscript.Read.All → Grant admin consent."
      );
    }
  }

  return { ok: steps.every((s) => s.ok !== false), steps };
}

module.exports = {
  SCOPES,
  configured,
  authUrl,
  saveTokens,
  disconnect,
  accountFor,
  createMeeting,
  cancelMeeting,
  fetchTranscript,
  sendMail,
  vttToLines,
  diagnose,
};
