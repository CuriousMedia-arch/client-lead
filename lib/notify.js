/**
 * Notifications.
 *
 * In-app is the source of truth: every notice is written to the database and
 * shows in the bell whether or not mail is set up. Email is a best-effort copy
 * on top — if SMTP isn't configured, `emailed_at` stays null and nothing is
 * lost. That way the feature works on day one and improves when mail is added,
 * rather than failing silently in between.
 *
 * Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM to turn email
 * on. Nothing else changes.
 */
const db = require("../db");

const MAIL_ENABLED = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);

let transport = null;
if (MAIL_ENABLED) {
  try {
    // Optional dependency: the app runs fine without it.
    const nodemailer = require("nodemailer");
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  } catch (err) {
    console.warn("[notify] SMTP configured but nodemailer isn't installed — in-app only.");
  }
}

/**
 * Record a notification and, where possible, email it.
 *
 * `dedupeKey` makes the write idempotent: the nightly deadline check can run
 * as often as it likes without sending the same warning twice.
 */
async function notify(userId, kind, title, body, linkId = null, dedupeKey = null) {
  let row;
  try {
    row = await db.one(
      `INSERT INTO notifications (user_id, kind, title, body, link_id, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, kind, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [userId, kind, title, body, linkId, dedupeKey]
    );
  } catch (err) {
    console.error("[notify]", err.message);
    return null;
  }

  // No row means the dedupe key caught it — already sent, nothing more to do.
  if (!row) return null;

  if (transport) {
    try {
      const user = await db.one("SELECT username, display_name FROM users WHERE id = $1", [userId]);
      // Usernames are email addresses here, but only send if it looks like one.
      if (user && /@/.test(user.username)) {
        await transport.sendMail({
          from: process.env.MAIL_FROM || process.env.SMTP_USER,
          to: user.username,
          subject: title,
          text: `${body}\n\n— Curious Media Lead Intelligence`,
        });
        await db.run("UPDATE notifications SET emailed_at = now() WHERE id = $1", [row.id]);
      }
    } catch (err) {
      // A mail failure must never lose the in-app notice.
      console.error("[notify] email failed:", err.message);
    }
  }

  return row;
}

/**
 * Warn anyone whose claim runs out within the next few days.
 *
 * Runs on a schedule and also whenever stats are fetched, so the warning
 * appears even if nothing scheduled has fired. The dedupe key is the contact
 * plus the day count, so someone gets one notice at five days and another at
 * one, not the same one every hour.
 */
async function warnExpiringClaims(daysAhead = 5) {
  const due = await db.all(
    `SELECT cc.id, cc.name, cc.company, cc.owner_id, cc.deadline_at,
            GREATEST(0, CEIL(EXTRACT(EPOCH FROM (cc.deadline_at - now())) / 86400))::int AS days_left
       FROM company_contacts cc
      WHERE cc.owner_id IS NOT NULL
        AND cc.deleted_at IS NULL
        AND cc.closed_at IS NULL
        AND cc.deadline_at IS NOT NULL
        AND cc.deadline_at > now()
        AND cc.deadline_at <= now() + ($1 || ' days')::interval`,
    [daysAhead]
  );

  let sent = 0;
  for (const c of due) {
    const created = await notify(
      c.owner_id,
      "deadline",
      `${c.days_left} day${c.days_left === 1 ? "" : "s"} left on ${c.name}`,
      `Your claim on ${c.name} at ${c.company} runs out in ${c.days_left} day${
        c.days_left === 1 ? "" : "s"
      }. Close it, or ask an admin for more time.`,
      c.id,
      `deadline-${c.id}-${c.days_left}`
    );
    if (created) sent++;
  }

  return sent;
}

module.exports = { notify, warnExpiringClaims, MAIL_ENABLED };
