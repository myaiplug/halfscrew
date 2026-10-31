"use strict";
const { issueToken, looksLikeLicenseKey, normalizeLicenseKey, secretIsUsable } = require("./token");

// Gumroad license verification for HalfScrew (no SDK, no OAuth: /v2/licenses/verify is public).
// Mirrors reTUNE[432]'s lib/gumroad-license.ts. Never logs or returns the license key.

const GUMROAD_VERIFY_URL = "https://api.gumroad.com/v2/licenses/verify";
const NAME = "HalfScrew unlimited exports";

async function callGumroad(licenseKey, increment, deps) {
  const fetchImpl = deps.fetchImpl || fetch;
  const body = new URLSearchParams({ product_id: deps.productId, license_key: licenseKey, increment_uses_count: increment ? "true" : "false" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs || 8000);
  try {
    const response = await fetchImpl(GUMROAD_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status >= 500 || response.status === 429) return { kind: "outage" };
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object") return response.ok ? { kind: "outage" } : { kind: "rejected", message: "" };
    if (!response.ok || data.success !== true) return { kind: "rejected", message: String(data.message || "") };
    return { kind: "ok", data };
  } catch {
    return { kind: "outage" };
  } finally {
    clearTimeout(timer);
  }
}

const contact = (deps) => `email ${deps.supportEmail} with your Gumroad receipt`;

function rejection(message, deps) {
  if (/disabled/i.test(message)) return { status: "disabled", message: `This license key has been disabled. If you think that's a mistake, ${contact(deps)}.` };
  return { status: "invalid", message: "That license key wasn't recognized for HalfScrew. Paste the full key from your Gumroad receipt (it looks like XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX)." };
}
function overCap(deps) {
  return { status: "over_cap", message: `This license key has reached its activation limit (${deps.maxActivations} browsers). If it's your key, ${contact(deps)} and we'll reset it.` };
}

// Judge a successful Gumroad response. Returns null when the purchase is in good standing.
function judgePurchase(data, deps) {
  const purchase = data && data.purchase;
  if (!data || data.success !== true || !purchase) return rejection("", deps);
  if (purchase.product_id && purchase.product_id !== deps.productId) return { status: "wrong_product", message: `That license key belongs to a different product, not ${NAME}.` };
  if (purchase.refunded) return { status: "refunded", message: `That purchase was refunded, so the key no longer unlocks unlimited exports. Questions? ${contact(deps)}.` };
  if (purchase.chargebacked) return { status: "chargebacked", message: `That purchase was charged back, so the key no longer unlocks unlimited exports. Questions? ${contact(deps)}.` };
  if (purchase.disputed && !purchase.dispute_won) return { status: "disputed", message: `That purchase is under a payment dispute, so the key can't unlock exports right now. Questions? ${contact(deps)}.` };
  if (purchase.subscription_cancelled_at || purchase.subscription_ended_at || purchase.subscription_failed_at) return { status: "subscription_inactive", message: `That subscription is no longer active. Questions? ${contact(deps)}.` };
  return null;
}

function precheck(rawKey, deps) {
  if (!deps.productId || !secretIsUsable(deps.secret)) return { status: "not_configured", message: "License activation isn't configured yet. Please try again later." };
  const key = normalizeLicenseKey(rawKey);
  if (!looksLikeLicenseKey(key)) return rejection("", deps);
  return { key };
}

const OUTAGE = { status: "outage", message: "Couldn't reach Gumroad to check the key. Please try again in a minute." };

// First activation in a browser: validate without counting, enforce the cap, then count this activation.
async function activateLicense(rawKey, deps) {
  const pre = precheck(rawKey, deps);
  if ("status" in pre) return pre;
  const first = await callGumroad(pre.key, false, deps);
  if (first.kind === "outage") return OUTAGE;
  if (first.kind === "rejected") return rejection(first.message, deps);
  const bad = judgePurchase(first.data, deps);
  if (bad) return bad;
  if (Number(first.data.uses || 0) >= deps.maxActivations) return overCap(deps);

  const counted = await callGumroad(pre.key, true, deps);
  if (counted.kind === "outage") return OUTAGE;
  if (counted.kind === "rejected") return rejection(counted.message, deps);
  const badAfter = judgePurchase(counted.data, deps);
  if (badAfter) return badAfter;
  const uses = Number(counted.data.uses || 0);
  if (uses > deps.maxActivations) return overCap(deps);
  const { token, expiresAt } = issueToken(pre.key, deps.secret, (deps.now || Date.now)());
  return { status: "active", token, expiresAt, uses };
}

// Silent re-check on page load: never counts a use.
async function refreshLicense(rawKey, deps) {
  const pre = precheck(rawKey, deps);
  if ("status" in pre) return pre;
  const outcome = await callGumroad(pre.key, false, deps);
  if (outcome.kind === "outage") return OUTAGE;
  if (outcome.kind === "rejected") return rejection(outcome.message, deps);
  const bad = judgePurchase(outcome.data, deps);
  if (bad) return bad;
  const uses = Number(outcome.data.uses || 0);
  if (uses > deps.maxActivations) return overCap(deps);
  const { token, expiresAt } = issueToken(pre.key, deps.secret, (deps.now || Date.now)());
  return { status: "active", token, expiresAt, uses };
}

module.exports = { GUMROAD_VERIFY_URL, activateLicense, refreshLicense, judgePurchase };
