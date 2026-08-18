/**
 * Gemini, called directly over its native REST endpoint.
 *
 * We deliberately do NOT use an SDK here. Google is migrating API keys from
 * the old Standard format (AIza...) to the new Auth format (AQ.Ab...), and the
 * new keys are rejected by OpenAI-compatible shims and by wrappers that assume
 * the old prefix. The native endpoint accepts both formats, so talking to it
 * straight removes a whole class of "invalid API key" failures where the key
 * is actually fine.
 *
 * The key is passed in the x-goog-api-key header — never as a query string,
 * where it would end up in logs.
 */
const axios = require("axios");

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const TIMEOUT = Number(process.env.GEMINI_TIMEOUT_MS || 60000);

function configured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

/** Pull the model's text out of the response, whatever shape it arrives in. */
function extractText(data) {
  const candidate = data && data.candidates && data.candidates[0];
  if (!candidate) return "";

  const parts = (candidate.content && candidate.content.parts) || [];
  return parts.map((p) => p.text || "").join("").trim();
}

/**
 * Send one prompt, get text back.
 * Throws with the API's own message so a wrong model name or an exhausted
 * quota says so, rather than surfacing as a bare status code.
 */
async function generate(prompt, { model = MODEL } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");

  try {
    const { data } = await axios.post(
      `${BASE}/${model}:generateContent`,
      {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, responseMimeType: "application/json" },
      },
      {
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        timeout: TIMEOUT,
      }
    );

    const blocked = data && data.promptFeedback && data.promptFeedback.blockReason;
    if (blocked) throw new Error(`Gemini refused the prompt (${blocked})`);

    const text = extractText(data);
    if (!text) throw new Error("Gemini returned an empty response");
    return text;
  } catch (err) {
    const res = err.response;
    if (!res) throw err;

    const apiMessage =
      (res.data && res.data.error && res.data.error.message) ||
      (typeof res.data === "string" ? res.data.slice(0, 200) : JSON.stringify(res.data || {}).slice(0, 200));

    const hint =
      res.status === 404
        ? ` — the model "${model}" may not exist on this API version; set GEMINI_MODEL to one your key can use`
        : res.status === 429
        ? " — rate limited or out of quota"
        : res.status === 401 || res.status === 403
        ? " — the key was rejected by Google (not a prefix problem; this endpoint accepts both AIza and AQ. keys)"
        : "";

    throw new Error(`Gemini ${res.status}: ${apiMessage}${hint}`);
  }
}

/**
 * One-shot connectivity check for the admin screen: is the key live, and can
 * it reach the configured model?
 */
async function healthCheck() {
  if (!configured()) return { ok: false, reason: "GEMINI_API_KEY is not set" };
  try {
    // Success is "the call came back with something", not "the model echoed a
    // magic word" — models vary in how literally they follow a toy prompt, and
    // a working key shouldn't be reported as broken over phrasing.
    const text = await generate('Reply with exactly this JSON and nothing else: {"ok":true}');
    return { ok: true, model: MODEL, sample: text.slice(0, 80) };
  } catch (err) {
    return { ok: false, reason: err.message, model: MODEL };
  }
}

module.exports = { generate, healthCheck, configured, MODEL };
