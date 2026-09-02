/**
 * The Express app itself, with no listener attached.
 *
 * server.js wraps it for local development; api/index.js exports it as a
 * Vercel function. Keeping the two apart is what makes one codebase run in
 * both places.
 */
require("dotenv").config();

const express = require("express");
const path = require("path");

const { attachUser } = require("./lib/auth");

const app = express();

/*
 * 1 MB is plenty for every request the portal makes except one: the contact
 * sheet import, which sends a whole CSV as a JSON string and is routinely
 * several megabytes. That route gets its own parser below.
 *
 * Kept as two limits rather than raising the global one, so a 25 MB body can
 * only be aimed at the single endpoint that has a reason to accept it.
 */
/*
 * Fathom's webhook is verified by an HMAC over the RAW request body, so it has
 * to be mounted before express.json() gets its hands on it. Re-serialising the
 * parsed object changes key order and whitespace, the signature stops
 * matching, and every webhook is rejected — with the confusing symptom that
 * the payload looks perfectly fine in the logs.
 */
app.use("/api/fathom/webhook", express.raw({ type: "*/*", limit: "8mb" }));

/*
 * The import route needs a bigger body than everything else, but note the
 * ceiling is not ours to set on serverless hosting: Vercel caps a function's
 * request body at 4.5 MB at the infrastructure level, and no setting here or
 * in vercel.json changes that. The browser therefore sends large sheets in
 * slices (see importInSlices in public/app.js) and each slice arrives well
 * under both limits. This value only has to be generous enough for one slice.
 */
app.use("/api/admin/import", express.json({ limit: process.env.IMPORT_LIMIT || "8mb" }));
app.use(express.json({ limit: "1mb" }));

/*
 * How long did this request take, and was it the server or the network?
 *
 * The Server-Timing header shows up in the browser's Network tab next to each
 * request, so "the portal is slow" can be answered by looking rather than
 * guessing: if the header says 40ms and the request took 2 seconds, the time
 * went on a cold start or the connection, not on our code.
 *
 * Anything genuinely slow is also logged, so it is visible in the deploy logs
 * without anyone having devtools open.
 */
app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - started;
    if (ms >= Number(process.env.SLOW_REQUEST_MS || 800)) {
      console.warn(`[slow] ${ms}ms ${req.method} ${req.originalUrl}`);
    }
  });

  const send = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    if (String(name).toLowerCase() === "content-type") {
      try { send("Server-Timing", `app;dur=${Date.now() - started}`); } catch { /* already sent */ }
    }
    return send(name, value);
  };

  next();
});

// Minimal cookie setter so we don't need cookie-parser.
app.use((req, res, next) => {
  res.cookie = (name, value, opts = {}) => {
    const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/"];
    if (opts.httpOnly !== false) parts.push("HttpOnly");
    if (opts.maxAge) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
    parts.push(`SameSite=${opts.sameSite || "Lax"}`);
    if (opts.secure) parts.push("Secure");
    res.append("Set-Cookie", parts.join("; "));
    return res;
  };
  res.clearCookie = (name) => {
    res.append("Set-Cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    return res;
  };
  next();
});

app.use(attachUser);

app.use("/api/auth", require("./routes/auth"));
app.use("/api/stats", require("./routes/stats"));
app.use("/api/leads", require("./routes/leads"));
app.use("/api/signals", require("./routes/signals"));
app.use("/api/contacts", require("./routes/contacts"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/outreach", require("./routes/outreach"));

// Machine-authenticated, not session-authenticated — mounted before nothing in
// particular, but kept separate from /api/* so it is obvious in the route list
// that this one is not for humans.
app.use("/api/cron", require("./routes/cron"));
app.use("/api/google", require("./routes/google"));
app.use("/api/microsoft", require("./routes/microsoft"));
app.use("/api/fathom", require("./routes/fathom"));

// Cheap way to confirm a deploy can reach the database.
app.get("/api/health", async (req, res) => {
  const db = require("./db");
  try {
    const row = await db.one("SELECT COUNT(*)::int AS n FROM users");
    res.json({ ok: true, users: row.n });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Static files, revalidated on every request.
 *
 * express.static's default lets a browser hold app.js and styles.css
 * indefinitely, so a deployed fix can sit on the server while everyone keeps
 * running the old copy — a bug that looks like the fix didn't work. `no-cache`
 * doesn't mean "don't cache": the file is still stored and still sent as a 304
 * when unchanged, it just has to ask first. The cost is one small request per
 * file per load; the alternative is shipping fixes nobody sees.
 */
app.use(
  express.static(path.join(__dirname, "public"), {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  })
);

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Unknown endpoint." });
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  /*
   * A body over the limit was being reported as a generic 500 "something broke
   * on our side", which is how a 7 MB contact sheet failed to import for days
   * without anyone being able to tell why. Say the actual numbers.
   */
  if (err && err.type === "entity.too.large") {
    const mb = (n) => `${(Number(n) / 1048576).toFixed(1)} MB`;
    console.error("[server] payload too large:", err.length, "limit", err.limit);
    return res.status(413).json({
      error:
        `That file is ${mb(err.length)} and the limit is ${mb(err.limit)}. ` +
        `Split the sheet into smaller files and import them one after another — ` +
        `importing the same people twice is safe, they just get topped up.`,
    });
  }

  // Malformed JSON deserves its own answer too; it is a client mistake, not
  // a server fault, and "check the server log" sends people to the wrong place.
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "That request wasn't valid JSON." });
  }

  console.error("[server]", err);
  res.status(500).json({ error: "Something broke on our side. Check the server log." });
});

module.exports = app;
