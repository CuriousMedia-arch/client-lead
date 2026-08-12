const crypto = require("crypto");
const db = require("../db");

const SESSION_DAYS = 14;

// --- passwords ---------------------------------------------------------------
// scrypt ships with Node, so there is no native module to compile.

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(plain, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(plain, stored) {
  try {
    const [scheme, salt, expected] = String(stored).split("$");
    if (scheme !== "scrypt" || !salt || !expected) return false;
    const actual = crypto.scryptSync(plain, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

// --- sessions ----------------------------------------------------------------

/**
 * Every authenticated request needs the session row, so on a remote database
 * that's one round trip of pure latency before the endpoint does any real
 * work. Cache the resolved user briefly instead.
 *
 * The cost of the cache is staleness: a role change or a deactivation takes
 * up to SESSION_CACHE_MS to bite. Sign-out is instant because we evict there
 * explicitly. On serverless each warm instance keeps its own copy, which is
 * fine — they all expire on the same clock.
 */
const SESSION_CACHE_MS = Number(process.env.SESSION_CACHE_MS || 60_000);
const sessionCache = new Map();

function cacheGet(id) {
  const hit = sessionCache.get(id);
  if (!hit) return null;
  if (hit.until < Date.now()) {
    sessionCache.delete(id);
    return null;
  }
  return hit.user;
}

function cacheSet(id, user) {
  // Keep it small — this is a convenience cache, not a session store.
  if (sessionCache.size > 500) sessionCache.clear();
  sessionCache.set(id, { user, until: Date.now() + SESSION_CACHE_MS });
}

async function createSession(userId) {
  const id = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await db.run("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)", [
    id,
    userId,
    expires,
  ]);
  return { id, expires };
}

async function destroySession(id) {
  if (!id) return;
  sessionCache.delete(id);
  await db.run("DELETE FROM sessions WHERE id = $1", [id]);
}

async function userForSession(id) {
  if (!id) return null;

  const cached = cacheGet(id);
  if (cached) return cached;

  const row = await db.one(
    `SELECT u.id, u.username, u.display_name, u.role, u.active, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`,
    [id]
  );

  if (!row) return null;
  if (new Date(row.expires_at) < new Date() || !row.active) {
    await destroySession(id);
    return null;
  }

  const user = { id: row.id, username: row.username, name: row.display_name, role: row.role };
  cacheSet(id, user);
  return user;
}

async function purgeExpiredSessions() {
  await db.run("DELETE FROM sessions WHERE expires_at < now()");
}

// --- express middleware ------------------------------------------------------

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

async function attachUser(req, res, next) {
  try {
    req.sessionId = readCookie(req, "sid");
    req.user = await userForSession(req.sessionId);
    next();
  } catch (err) {
    next(err);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Sign in to continue." });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Sign in to continue." });
  if (req.user.role !== "admin")
    return res.status(403).json({ error: "This section is admin-only." });
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  userForSession,
  purgeExpiredSessions,
  attachUser,
  requireAuth,
  requireAdmin,
  SESSION_DAYS,
};
