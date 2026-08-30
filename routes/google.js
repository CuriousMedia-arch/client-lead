/**
 * Connecting a Google account.
 *
 * Three endpoints and a status check. Everything else Google-related lives on
 * the resources it belongs to — creating a meeting is part of an opportunity,
 * not part of "Google".
 */
const express = require("express");

const google = require("../lib/google");
const { requireAuth } = require("../lib/auth");

const router = express.Router();

/** Is Google set up at all, and has this person connected? */
router.get("/status", requireAuth, async (req, res, next) => {
  try {
    const account = google.configured() ? await google.accountFor(req.user.id) : null;
    res.json({
      configured: google.configured(),
      connected: Boolean(account),
      email: account && account.email,
      connected_at: account && account.connected_at,
      // Surfaced so the UI can say "reconnect your account" instead of failing
      // silently the next time someone books a meeting.
      last_error: account && account.last_error,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/connect", requireAuth, (req, res) => {
  if (!google.configured()) {
    return res.status(400).json({
      error: "Google isn't set up on this deployment yet. An admin needs to add the Google credentials.",
    });
  }
  res.json({ url: google.authUrl(req.user.id) });
});

/**
 * Where Google sends them back.
 *
 * Not behind requireAuth: the browser arrives here from accounts.google.com,
 * and depending on cookie settings the session may not come with it. The user
 * id travels in `state` instead, which Google echoes back unchanged.
 *
 * That makes `state` the thing an attacker would forge, so it is checked
 * against a real user before anything is stored.
 */
router.get("/callback", async (req, res) => {
  const back = (msg, ok) =>
    res.redirect(`/?google=${ok ? "connected" : "failed"}&msg=${encodeURIComponent(msg)}`);

  try {
    if (req.query.error) return back(`Google said: ${req.query.error}`, false);

    const userId = Number(req.query.state);
    if (!userId || !req.query.code) return back("That sign-in link was incomplete.", false);

    const db = require("../db");
    const user = await db.one("SELECT id FROM users WHERE id = $1 AND active", [userId]);
    if (!user) return back("That account no longer exists.", false);

    const { email } = await google.saveTokens(userId, req.query.code);
    return back(email ? `Connected ${email}` : "Google account connected", true);
  } catch (err) {
    console.error("[google] callback failed:", err.message);
    return back(err.message, false);
  }
});

router.post("/disconnect", requireAuth, async (req, res, next) => {
  try {
    await google.disconnect(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
