/**
 * Vercel entry point. Every request that isn't a static file lands here.
 *
 * An Express app is itself a (req, res) function, so exporting it directly is
 * all the Node runtime needs.
 *
 * On the config in vercel.json:
 *
 *   `functions` and `builds` cannot both be present — Vercel rejects the whole
 *   deployment with "The `functions` property cannot be used in conjunction
 *   with the `builds` property". `builds` is the older format; this project
 *   uses the current one, which is also better here: `rewrites` are evaluated
 *   AFTER static files, so /app.js and /styles.css are served straight from
 *   the CDN and only real requests reach this function.
 */
module.exports = require("../app");
