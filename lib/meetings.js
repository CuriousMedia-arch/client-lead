/**
 * One meeting interface, two providers behind it.
 *
 * Curious Media runs on Microsoft 365, so Teams is the default — the licences
 * are already paid for. Google is kept because the integration exists and
 * someone may connect a Google account instead.
 *
 * Everything above this file (routes, the workspace UI) asks for "a meeting"
 * and "send this mail" without knowing or caring which. That matters more than
 * it sounds: without it, adding Microsoft would have meant an if/else at every
 * one of the six call sites, and the seventh would have been forgotten.
 *
 * If someone has connected both, Microsoft wins — it is the one their calendar
 * and mail actually live on, so a Teams invite reaches people where they
 * already are.
 */
const google = require("./google");
const microsoft = require("./microsoft");

/** Which provider to use for this person, or null if they've connected none. */
async function providerFor(userId) {
  if (microsoft.configured()) {
    const account = await microsoft.accountFor(userId).catch(() => null);
    if (account) return { name: "microsoft", api: microsoft, account };
  }
  if (google.configured()) {
    const account = await google.accountFor(userId).catch(() => null);
    if (account) return { name: "google", api: google, account };
  }
  return null;
}

/** What the UI needs to decide between "Connect", "Reconnect" and neither. */
async function statusFor(userId) {
  const [ms, g] = await Promise.all([
    microsoft.configured() ? microsoft.accountFor(userId).catch(() => null) : null,
    google.configured() ? google.accountFor(userId).catch(() => null) : null,
  ]);

  const active = ms ? "microsoft" : g ? "google" : null;

  return {
    // What an admin has set up on this deployment at all.
    available: [
      microsoft.configured() ? "microsoft" : null,
      google.configured() ? "google" : null,
    ].filter(Boolean),
    connected: active,
    email: (ms || g || {}).email || null,
    last_error: (ms || g || {}).last_error || null,
    label: active === "microsoft" ? "Microsoft Teams" : active === "google" ? "Google Meet" : null,
  };
}

async function createMeeting(userId, details) {
  const p = await providerFor(userId);
  if (!p) return null;
  const result = await p.api.createMeeting(userId, details);
  return result ? { ...result, provider: p.name } : null;
}

async function cancelMeeting(userId, eventId) {
  const p = await providerFor(userId);
  if (!p) return false;
  return p.api.cancelMeeting(userId, eventId);
}

async function fetchTranscript(userId, meeting) {
  const p = await providerFor(userId);
  if (!p) return { state: "none", reason: "not_connected" };
  return { ...(await p.api.fetchTranscript(userId, meeting)), provider: p.name };
}

async function sendMail(userId, message) {
  const p = await providerFor(userId);
  if (!p) return { sent: false, reason: "not_connected" };
  return p.api.sendMail(userId, message);
}

/**
 * Why a transcript isn't there, in words the person reading can act on.
 *
 * Shared by both providers because the situations are the same even though the
 * error strings are not. `tenant_switch_off` is Microsoft-only and worth its
 * own message: it is fixed by an admin ticking a box, not by trying again, and
 * without saying so people retry for days.
 */
const TRANSCRIPT_REASONS = {
  not_connected: "Connect your Microsoft or Google account first — Settings, then Connect.",
  no_meet_link: "This meeting has no online meeting link, so there's nothing to fetch.",
  no_conference_yet: "The call hasn't been processed yet. Try again in a few minutes.",
  still_processing: "Still preparing the transcript. Usually ready within an hour of the call.",
  transcription_was_off:
    "Nobody switched transcription on during this call, so there's no record to work from. An admin can turn it on automatically for everyone.",
  empty_transcript: "The transcript came back empty — nothing was captured.",
  tenant_switch_off:
    "Microsoft is blocking transcript access for your whole organisation. An admin needs to turn it on: Teams admin centre → Meetings → Meeting settings → Transcript API access.",
};

module.exports = {
  providerFor,
  statusFor,
  createMeeting,
  cancelMeeting,
  fetchTranscript,
  sendMail,
  TRANSCRIPT_REASONS,
};
