"use strict";
const crypto = require("node:crypto");

// Shopify-sold HalfScrew keys. Stateless: the key is derived from the Shopify order id with an HMAC, so no database is needed.
//   key = HSS-<order id in base36>-<24 hex of HMAC-SHA256(secret, "halfscrew.shopify.v1:<order id>")>, grouped 8-8-8
// Only someone holding the server secret can mint a valid key. The key is never logged.

const KEY_PREFIX = "HSS-";
const DEFAULT_SKUS = ["HALFSREW-UNLIMITED"]; // the SKU on shop.nodawlabs.com (sic: "HALFSREW")
const DOMAIN = "halfscrew.shopify.v1:";

const keySecret = (env = process.env) => env.HALFSCREW_SHOPIFY_KEY_SECRET || env.HALFSCREW_LICENSE_SECRET;
const secretOk = (s) => typeof s === "string" && s.length >= 32;

function productSkus(env = process.env) {
  const list = String(env.HALFSCREW_SHOPIFY_SKUS || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  return list.length ? list : DEFAULT_SKUS;
}

function mac(orderId, secret) {
  return crypto.createHmac("sha256", secret).update(`${DOMAIN}${orderId}`).digest("hex").slice(0, 24).toUpperCase();
}

function deriveKey(orderId, secret) {
  const id = String(orderId || "").trim();
  if (!/^\d{1,20}$/.test(id) || !secretOk(secret)) throw new Error("cannot derive a Shopify key");
  const m = mac(id, secret);
  return `${KEY_PREFIX}${BigInt(id).toString(36).toUpperCase()}-${m.slice(0, 8)}-${m.slice(8, 16)}-${m.slice(16, 24)}`;
}

const isShopifyKey = (key) => typeof key === "string" && key.trim().toUpperCase().startsWith(KEY_PREFIX);

// -> { valid, orderId } ; constant-time MAC comparison.
function verifyKey(key, secret) {
  if (!isShopifyKey(key) || !secretOk(secret)) return { valid: false, reason: secretOk(secret) ? "malformed" : "not_configured" };
  const m = /^HSS-([0-9A-Z]{1,14})-([0-9A-F]{8})-([0-9A-F]{8})-([0-9A-F]{8})$/.exec(key.trim().toUpperCase());
  if (!m) return { valid: false, reason: "malformed" };
  let orderId;
  try { orderId = [...m[1].toLowerCase()].reduce((n, c) => n * 36n + BigInt(parseInt(c, 36)), 0n).toString(); } catch { return { valid: false, reason: "malformed" }; }
  const expected = Buffer.from(mac(orderId, secret));
  const given = Buffer.from(`${m[2]}${m[3]}${m[4]}`);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return { valid: false, reason: "bad_mac" };
  return { valid: true, orderId };
}

// Shopify webhook signature: base64 HMAC-SHA256 of the RAW body with the app/webhook signing secret.
function verifyWebhookHmac(rawBody, header, secret) {
  if (!secret || typeof header !== "string" || !header) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  let given;
  try { given = Buffer.from(header, "base64"); } catch { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const orderHasHalfScrew = (order, skus) => Array.isArray(order && order.line_items) && order.line_items.some((i) => skus.includes(String(i.sku || "").trim().toUpperCase()));
const orderIsPaid = (order) => !!order && order.financial_status === "paid" && !order.cancelled_at;

// Optional revocation check (refund / cancel) via the Shopify Admin API. Needs SHOPIFY_STORE_DOMAIN + SHOPIFY_ADMIN_TOKEN.
// Returns { kind: "ok" | "revoked" | "outage" | "skipped" }.
async function checkOrderStillGood(orderId, deps) {
  if (!deps.shopifyAdminToken || !deps.shopifyStoreDomain) return { kind: "skipped" };
  const fetchImpl = deps.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs || 8000);
  try {
    const r = await fetchImpl(`https://${deps.shopifyStoreDomain}/admin/api/2025-10/orders/${orderId}.json?fields=id,financial_status,cancelled_at`, {
      headers: { "X-Shopify-Access-Token": deps.shopifyAdminToken, accept: "application/json" }, signal: controller.signal,
    });
    if (r.status === 404) return { kind: "revoked" };
    if (!r.ok) return { kind: "outage" };
    const { order } = await r.json();
    if (!order) return { kind: "outage" };
    if (order.cancelled_at || ["refunded", "voided"].includes(order.financial_status)) return { kind: "revoked" };
    return { kind: "ok" };
  } catch { return { kind: "outage" }; } finally { clearTimeout(timer); }
}

module.exports = { KEY_PREFIX, DEFAULT_SKUS, keySecret, secretOk, productSkus, deriveKey, verifyKey, isShopifyKey, verifyWebhookHmac, orderHasHalfScrew, orderIsPaid, checkOrderStillGood };
