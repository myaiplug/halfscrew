"use strict";
const { createHash, createHmac, timingSafeEqual } = require("node:crypto");

// Signed HalfScrew session tokens: base64url(payload).base64url(HMAC-SHA256(secret, "halfscrew.v1." + payload)).
// The payload carries a hash of the license key (never the key), issued-at and expiry. Server-only.

const TOKEN_TTL_SECONDS = 24 * 60 * 60;
const PRODUCT = "halfscrew";
const MIN_SECRET_LENGTH = 32;
const CLOCK_SKEW_SECONDS = 60;

function secretIsUsable(secret) {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}
function normalizeLicenseKey(raw) {
  return String(raw == null ? "" : raw).replace(/\s+/g, "");
}
function looksLikeLicenseKey(key) {
  return /^[A-Za-z0-9-]{8,80}$/.test(key);
}
function hashLicenseKey(key) {
  return createHash("sha256").update(`${PRODUCT}:${key}`).digest("hex").slice(0, 32);
}
const b64url = (input) => Buffer.from(input).toString("base64url");
function sign(secret, body) {
  return createHmac("sha256", secret).update(`${PRODUCT}.v1.${body}`).digest();
}

function issueToken(licenseKey, secret, nowMs = Date.now(), ttlSeconds = TOKEN_TTL_SECONDS) {
  const iat = Math.floor(nowMs / 1000);
  const payload = { v: 1, prd: PRODUCT, kh: hashLicenseKey(licenseKey), iat, exp: iat + ttlSeconds };
  const body = b64url(JSON.stringify(payload));
  return { token: `${body}.${b64url(sign(secret, body))}`, expiresAt: payload.exp * 1000 };
}

function verifyToken(token, secret, nowMs = Date.now()) {
  if (!secretIsUsable(secret)) return { valid: false, reason: "not_configured" };
  if (typeof token !== "string" || token.length > 1024) return { valid: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { valid: false, reason: "malformed" };
  const [body, signature] = parts;
  const expected = sign(secret, body);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { valid: false, reason: "bad_signature" };
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return { valid: false, reason: "malformed" }; }
  if (!payload || payload.v !== 1 || payload.prd !== PRODUCT || typeof payload.exp !== "number" || typeof payload.iat !== "number") return { valid: false, reason: "malformed" };
  const now = Math.floor(nowMs / 1000);
  if (payload.iat > now + CLOCK_SKEW_SECONDS || payload.exp <= now) return { valid: false, reason: "expired" };
  return { valid: true, payload };
}

module.exports = { TOKEN_TTL_SECONDS, secretIsUsable, normalizeLicenseKey, looksLikeLicenseKey, hashLicenseKey, issueToken, verifyToken };
