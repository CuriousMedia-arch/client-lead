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

app.use(express.json({ limit: "1mb" }));

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
  console.error("[server]", err);
  res.status(500).json({ error: "Something broke on our side. Check the server log." });
});

module.exports = app;
