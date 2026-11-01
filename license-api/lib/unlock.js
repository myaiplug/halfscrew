"use strict";
const gumroad = require("./gumroad");
const { issueToken } = require("./token");
const { isShopifyKey, verifyKey, checkOrderStillGood, secretOk } = require("./shopify");

// Shopify-issued keys (HSS-...) are checked offline (HMAC) + optional refund check; everything else goes to Gumroad as before.
async function shopifyUnlock(licenseKey, deps) {
  const secret = deps.shopifyKeySecret || deps.secret;
  if (!secretOk(secret) || !secretOk(deps.secret)) return { status: "not_configured", message: "License checking isn't configured yet. Please try again later." };
  const v = verifyKey(licenseKey, secret);
  if (!v.valid) return { status: "invalid", message: "That license key wasn't recognized for HalfScrew. Paste the full key from your order email (it starts with HSS-)." };
  const order = await checkOrderStillGood(v.orderId, deps);
  if (order.kind === "revoked") return { status: "refunded", message: `This order was refunded or cancelled, so the key no longer works. Email ${deps.supportEmail} if that's a mistake.` };
  if (order.kind === "outage") return { status: "outage", message: "Couldn't reach the order service. Please try again in a minute." };
  const t = issueToken(licenseKey.trim().toUpperCase(), deps.secret, (deps.now || Date.now)());
  return { status: "active", token: t.token, expiresAt: t.expiresAt };
}

const activateLicense = (key, deps) => (isShopifyKey(key) ? shopifyUnlock(key, deps) : gumroad.activateLicense(key, deps));
const refreshLicense = (key, deps) => (isShopifyKey(key) ? shopifyUnlock(key, deps) : gumroad.refreshLicense(key, deps));

module.exports = { activateLicense, refreshLicense };
