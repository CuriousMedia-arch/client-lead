/**
 * Encrypting stored OAuth refresh tokens.
 *
 * A refresh token is as good as a password — one is enough to act as that
 * person indefinitely, reading their mail and their calendar. AES-256-GCM so a
 * leaked database dump is not a leaked set of accounts.
 *
 * Shared by every provider (Google, Microsoft) rather than copied into each:
 * two implementations of the same crypto is two chances to get it wrong, and
 * only one of them would ever get fixed.
 */
const crypto = require("crypto");

function key() {
  const secret = process.env.TOKEN_SECRET || process.env.SESSION_SECRET || "";
  if (!secret) {
    throw new Error("TOKEN_SECRET is not set — refusing to store tokens in plain text.");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    enc.toString("base64"),
  ].join(".");
}

function decrypt(blob) {
  const [iv, tag, data] = String(blob).split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

module.exports = { encrypt, decrypt };
