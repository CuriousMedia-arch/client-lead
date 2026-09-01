/**
 * Connecting a Microsoft account.
 *
 * Mirrors routes/google.js exactly. Kept as its own file rather than merged
 * into a generic /api/oauth route because the callback URL is registered with
 * Microsoft and must never change — a shared route would make the two
 * providers' redirect URIs depend on each other.
 */
const express = require("express");

const microsoft = require("../lib/microsoft");
const meetings = require("../lib/meetings");
const { requireAuth } = require("../lib/auth");

const router = express.Router();

/** Both providers at once, so the UI can render one Connect button. */
router.get("/status", requireAuth, async (req, res, next) => {
  try {
    res.json(await meetings.statusFor(req.user.id));
  } catch (err) {
    next(err);
  }
});

/**
 * Walk the whole setup and report what's broken.
 *
 * The point is that every step lives in a different admin console and they all
 * fail the same way from outside. This says which one, and where to fix it.
 */
router.get("/check", requireAuth, async (req, res, next) => {
  try {
    res.json(await microsoft.diagnose(req.user.id));
  } catch (err) {
    next(err);
  }
});

router.get("/connect", requireAuth, (req, res) => {
  if (!microsoft.configured()) {
    return res.status(400).json({
      error: "Microsoft isn't set up on this deployment yet. An admin needs to add the Microsoft credentials.",
    });
  }
  res.json({ url: microsoft.authUrl(req.user.id) });
});

/**
 * Where Microsoft sends them back.
 *
 * Not behind requireAuth: the browser arrives from login.microsoftonline.com
 * and the session cookie may not survive the redirect. The user id travels in
 * `state`, which is echoed back unchanged — so it is the thing an attacker
 * would forge, and it is checked against a real user before anything is saved.
 */
router.get("/callback", async (req, res) => {
  const back = (msg, ok) =>
    res.redirect(`/?microsoft=${ok ? "connected" : "failed"}&msg=${encodeURIComponent(msg)}`);

  try {
    if (req.query.error) {
      return back(req.query.error_description || req.query.error, false);
    }

    const userId = Number(req.query.state);
    if (!userId || !req.query.code) return back("That sign-in link was incomplete.", false);

    const db = require("../db");
    const user = await db.one("SELECT id FROM users WHERE id = $1 AND active", [userId]);
    if (!user) return back("That account no longer exists.", false);

    const { email } = await microsoft.saveTokens(userId, req.query.code);
    return back(email ? `Connected ${email}` : "Microsoft account connected", true);
  } catch (err) {
    console.error("[microsoft] callback failed:", err.message);
    return back(err.message, false);
  }
});

router.post("/disconnect", requireAuth, async (req, res, next) => {
  try {
    await microsoft.disconnect(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
