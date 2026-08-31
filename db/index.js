/**
 * Postgres (Supabase) connection.
 *
 * One pool per warm serverless instance. Vercel reuses the module between
 * invocations, so we cache the pool on globalThis — otherwise every request
 * opens new connections and Supabase runs out.
 *
 * Use the SESSION or TRANSACTION pooler string from Supabase
 * (Project → Connect → ORMs/Node), not the direct 5432 one: serverless
 * functions open and drop connections constantly and the pooler is built
 * for exactly that.
 */
const { Pool, types } = require("pg");

// Postgres returns bigint (and COUNT) as a STRING, because int8 can exceed
// what a JS number holds. SQLite handed back real numbers, and the frontend
// relies on that: `u.id === lead.owner_id` for the owner dropdown,
// `count === 1 ? "signal" : "signals"` for pluralisation. Our ids will never
// come close to 2^53, so parse them as numbers and keep every comparison
// working the way it always did.
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));   // int8 / bigint
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));   // numeric

const CONNECTION = process.env.DATABASE_URL;

if (!CONNECTION) {
  console.warn("[db] DATABASE_URL is not set — every query will fail.");
}

function makePool() {
  // Supabase requires SSL; a local Postgres doesn't offer it at all. Detect
  // rather than force, so the same file works in both places.
  const isLocal = /@(localhost|127\.0\.0\.1|\/)/.test(CONNECTION || "");
  const ssl =
    process.env.PGSSL === "disable" || isLocal ? false : { rejectUnauthorized: false };

  return new Pool({
    connectionString: CONNECTION,
    ssl,
    max: Number(process.env.PG_POOL_MAX || 8),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  });
}

const pool = globalThis.__cmPool || (globalThis.__cmPool = makePool());

pool.on("error", (err) => console.error("[db] idle client error:", err.message));

/*
 * Say which query was slow, in the logs.
 *
 * Without this, "the portal is slow" is unanswerable: the deploy logs show a
 * request took two seconds and nothing about why. A threshold rather than
 * every query, so normal traffic stays quiet and only the outliers speak up.
 *
 * SLOW_QUERY_MS=0 turns it off; lower it to see more.
 */
const SLOW_MS = Number(process.env.SLOW_QUERY_MS ?? 250);

if (SLOW_MS > 0) {
  const original = pool.query.bind(pool);
  pool.query = async (...args) => {
    const started = Date.now();
    try {
      return await original(...args);
    } finally {
      const ms = Date.now() - started;
      if (ms >= SLOW_MS) {
        const text = typeof args[0] === "string" ? args[0] : (args[0] && args[0].text) || "";
        console.warn(`[db] ${ms}ms — ${text.replace(/\s+/g, " ").trim().slice(0, 160)}`);
      }
    }
  };
}

/** Every row. */
async function all(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

/** First row, or undefined. */
async function one(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows[0];
}

/** A single scalar from the first row — handy for COUNT(*) queries. */
async function value(text, params = [], column = "n") {
  const row = await one(text, params);
  return row ? Number(row[column]) : 0;
}

/** Write with no meaningful return. */
async function run(text, params = []) {
  const res = await pool.query(text, params);
  return res.rowCount;
}

/**
 * Run several statements atomically.
 *   await tx(async (q) => { await q("INSERT ..."); await q("UPDATE ..."); });
 */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn((text, params = []) => client.query(text, params));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, all, one, value, run, tx };
