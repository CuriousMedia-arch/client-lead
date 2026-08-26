/**
 * A doorbell for the sweeps.
 *
 * On Render (or locally) the scheduler runs an in-process timer and this route
 * is never needed. On Vercel there is no always-on process — a function only
 * exists while it is handling a request — so an in-process cron would never
 * fire. Something outside has to knock, and this is what it knocks on.
 *
 * Deliberately thin: it does not reimplement anything, it calls the exact same
 * lib/sweeps.runAllSweeps() the web requests and the in-process cron call. A
 * cron path with its own copy of the logic is how you get a lead that is
 * released according to one screen and claimed according to another.
 *
 * Auth is a shared secret, not a session, because the caller is a machine.
 */
const express = require("express");
const sweeps = require("../lib/sweeps");

const router = express.Router();

/**
 * Both header styles are accepted:
 *   Authorization: Bearer <secret>   — what Vercel Cron sends
 *   x-cron-secret: <secret>          — easier to set from curl or Actions
 *
 * If CRON_SECRET is unset the endpoint refuses rather than running openly.
 * An unauthenticated route that releases other people's leads is not something
 * to leave switched on by accident, and failing loudly here is far easier to
 * diagnose than a sweep that silently never ran.
 */
function authorised(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = req.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  return bearer === secret || req.get("x-cron-secret") === secret;
}

async function handle(req, res) {
  if (!authorised(req)) {
    return res.status(401).json({
      error: process.env.CRON_SECRET
        ? "Bad cron secret."
        : "CRON_SECRET is not set on this deployment, so the cron endpoint is off.",
    });
  }

  try {
    const result = await sweeps.runAllSweeps();
    console.log("[cron] sweeps:", JSON.stringify(result));
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron] sweeps failed:", err.message);
    res.status(500).json({ error: err.message });
  }
}

// GET as well as POST: Vercel Cron issues a GET, and being able to check it
// with a browser or curl is worth more than REST purity on an internal hook.
router.get("/sweep", handle);
router.post("/sweep", handle);

module.exports = router;
