"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const test = require("node:test");
const { deriveKey, verifyKey, verifyWebhookHmac, orderHasHalfScrew, orderIsPaid, productSkus } = require("../lib/shopify");
const { activateLicense, refreshLicense } = require("../lib/unlock");
const { verifyToken } = require("../lib/token");
const { buildKeyEmail } = require("../lib/email");
const webhook = require("../api/shopify/webhook");

const SECRET = "s".repeat(48);
const WH_SECRET = "whsec_test_secret";
const ORDER_ID = "6543210987654";
const deps = (extra = {}) => ({ productId: "TestProd123==", secret: SECRET, maxActivations: 5, supportEmail: "NoDAW@nodawlabs.com", ...extra });
const order = (o = {}) => ({ id: Number(ORDER_ID), name: "#1042", email: "buyer@example.com", financial_status: "paid", line_items: [{ sku: "HALFSREW-UNLIMITED", title: "HalfScrew Unlimited" }], ...o });

test("derived key: stable, well-formed, matches the client's accepted charset/length", () => {
  const key = deriveKey(ORDER_ID, SECRET);
  assert.equal(key, deriveKey(ORDER_ID, SECRET));
  assert.match(key, /^HSS-[0-9A-Z]+-[0-9A-F]{8}-[0-9A-F]{8}-[0-9A-F]{8}$/);
  assert.match(key, /^[A-Za-z0-9-]{8,80}$/);
  assert.notEqual(key, deriveKey("6543210987655", SECRET));
  assert.deepEqual(verifyKey(key, SECRET), { valid: true, orderId: ORDER_ID });
  assert.equal(verifyKey(key.toLowerCase(), SECRET).valid, true);
});

test("forged / tampered / wrong-secret keys are rejected", () => {
  const key = deriveKey(ORDER_ID, SECRET);
  assert.equal(verifyKey(key, "z".repeat(48)).valid, false);
  assert.equal(verifyKey(key.slice(0, -1) + (key.endsWith("0") ? "1" : "0"), SECRET).valid, false);
  assert.equal(verifyKey("HSS-ZZZZ-00000000-00000000-00000000", SECRET).valid, false);
  assert.equal(verifyKey("HSS-", SECRET).valid, false);
  assert.equal(verifyKey(key, "short").reason, "not_configured");
  assert.throws(() => deriveKey("abc", SECRET));
  assert.throws(() => deriveKey(ORDER_ID, "short"));
});

test("a Shopify key unlocks via activate and refresh (no Gumroad call) and yields a verifiable session token", async () => {
  const key = deriveKey(ORDER_ID, SECRET);
  const noNetwork = async () => { throw new Error("must not call the network"); };
  for (const fn of [activateLicense, refreshLicense]) {
    const r = await fn(key, deps({ fetchImpl: noNetwork }));
    assert.equal(r.status, "active");
    assert.equal(verifyToken(r.token, SECRET).valid, true);
  }
});

test("a bogus HSS key is invalid; Gumroad-style keys still go to Gumroad", async () => {
  assert.equal((await activateLicense("HSS-AAAA-00000000-00000000-00000000", deps())).status, "invalid");
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return Response.json({ success: false, message: "nope" }, { status: 404 }); };
  assert.equal((await activateLicense("ABCD1234-EF567890-1234ABCD-5678EF90", deps({ fetchImpl }))).status, "invalid");
  assert.deepEqual(calls, ["https://api.gumroad.com/v2/licenses/verify"]);
});

test("with an Admin token, refunded/cancelled orders are revoked; outage is not a token", async () => {
  const key = deriveKey(ORDER_ID, SECRET);
  const d = (body, status = 200) => deps({ shopifyStoreDomain: "shop.example.com", shopifyAdminToken: "tok", fetchImpl: async (url, init) => {
    assert.match(url, new RegExp(`^https://shop\\.example\\.com/admin/api/[\\d-]+/orders/${ORDER_ID}\\.json`));
    assert.equal(init.headers["X-Shopify-Access-Token"], "tok");
    return Response.json(body, { status });
  } });
  assert.equal((await activateLicense(key, d({ order: { financial_status: "paid", cancelled_at: null } }))).status, "active");
  assert.equal((await activateLicense(key, d({ order: { financial_status: "refunded" } }))).status, "refunded");
  assert.equal((await refreshLicense(key, d({ order: { financial_status: "paid", cancelled_at: "2026-11-01T00:00:00Z" } }))).status, "refunded");
  assert.equal((await activateLicense(key, d({}, 404))).status, "refunded");
  const out = await activateLicense(key, d({}, 503));
  assert.equal(out.status, "outage");
  assert.equal(out.token, undefined);
});

test("weak secret -> not_configured for Shopify keys", async () => {
  assert.equal((await activateLicense(deriveKey(ORDER_ID, SECRET), deps({ secret: "short" }))).status, "not_configured");
});

test("webhook HMAC verification", () => {
  const raw = Buffer.from('{"a":1}');
  const good = crypto.createHmac("sha256", WH_SECRET).update(raw).digest("base64");
  assert.equal(verifyWebhookHmac(raw, good, WH_SECRET), true);
  assert.equal(verifyWebhookHmac(raw, good, "other"), false);
  assert.equal(verifyWebhookHmac(Buffer.from('{"a":2}'), good, WH_SECRET), false);
  for (const bad of ["", undefined, "!!!", "AAAA"]) assert.equal(verifyWebhookHmac(raw, bad, WH_SECRET), false);
});

test("order filters: SKU (case-insensitive, overridable) and paid", () => {
  assert.equal(orderHasHalfScrew(order(), productSkus({})), true);
  assert.equal(orderHasHalfScrew(order({ line_items: [{ sku: "halfsrew-unlimited" }] }), productSkus({})), true);
  assert.equal(orderHasHalfScrew(order({ line_items: [{ sku: "SCREWAI-PRO", title: "ScrewAI" }] }), productSkus({})), false);
  assert.equal(orderHasHalfScrew(order({ line_items: [{ sku: "NEW-SKU" }] }), productSkus({ HALFSCREW_SHOPIFY_SKUS: "new-sku, other" })), true);
  assert.equal(orderIsPaid(order()), true);
  for (const o of [{ financial_status: "pending" }, { financial_status: "refunded" }, { cancelled_at: "2026-11-01" }]) assert.equal(orderIsPaid(order(o)), false);
});

// ---- webhook handler end-to-end with fake req/res and a fake Resend ----
function call({ body, method = "POST", sign = true, hmac, env = {} }) {
  const raw = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const req = Readable.from([raw]);
  req.method = method;
  req.headers = { "x-shopify-hmac-sha256": hmac !== undefined ? hmac : sign ? crypto.createHmac("sha256", WH_SECRET).update(raw).digest("base64") : "" };
  const res = { headers: {}, statusCode: 0, body: "", setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b || ""; } };
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init, payload: JSON.parse(init.body) }); return Response.json({ id: "email_1" }); };
  const fullEnv = { SHOPIFY_WEBHOOK_SECRET: WH_SECRET, HALFSCREW_LICENSE_SECRET: SECRET, RESEND_API_KEY: "re_test", HALFSCREW_FROM_EMAIL: "HalfScrew <orders@example.com>", ...env };
  return webhook.handle(req, res, fullEnv, env.__fetch || fetchImpl).then(() => ({ res, sent, json: JSON.parse(res.body || "{}") }));
}

test("webhook: paid HalfScrew order -> 200 and one email with a key that verifies; response never leaks the key", async () => {
  const { res, sent, json } = await call({ body: order() });
  assert.equal(res.statusCode, 200);
  assert.equal(json.delivered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.resend.com/emails");
  assert.deepEqual(sent[0].payload.to, ["buyer@example.com"]);
  assert.equal(sent[0].init.headers["Idempotency-Key"], `halfscrew-shopify-${ORDER_ID}`);
  const key = /HSS-[0-9A-Z]+-[0-9A-F]{8}-[0-9A-F]{8}-[0-9A-F]{8}/.exec(sent[0].payload.text)[0];
  assert.deepEqual(verifyKey(key, SECRET), { valid: true, orderId: ORDER_ID });
  assert.equal(key, deriveKey(ORDER_ID, SECRET));
  assert.ok(!res.body.includes(key) && !res.body.includes("buyer@example.com"));
  assert.ok(sent[0].payload.html.includes(key) && sent[0].payload.text.includes("license_key="));
});

test("webhook: bad/missing signature -> 401, nothing sent; non-POST -> 405", async () => {
  assert.equal((await call({ body: order(), sign: false })).res.statusCode, 401);
  const bad = await call({ body: order(), hmac: Buffer.from("nope").toString("base64") });
  assert.equal(bad.res.statusCode, 401);
  assert.equal(bad.sent.length, 0);
  assert.equal((await call({ body: order(), method: "GET" })).res.statusCode, 405);
  assert.equal((await call({ body: order(), env: { SHOPIFY_WEBHOOK_SECRET: "" } })).res.statusCode, 503);
});

test("webhook: other products, unpaid orders and orders without email are acknowledged but ignored", async () => {
  for (const [o, why] of [[order({ line_items: [{ sku: "SCREWAI-PRO" }] }), "not_halfscrew"], [order({ financial_status: "pending" }), "not_paid"], [order({ email: null, contact_email: null }), "no_email"]]) {
    const r = await call({ body: o });
    assert.equal(r.res.statusCode, 200);
    assert.equal(r.json.ignored, why);
    assert.equal(r.sent.length, 0);
  }
});

test("webhook: email not configured -> 503, provider failure -> 502 (Shopify retries); never 200 without delivery", async () => {
  assert.equal((await call({ body: order(), env: { RESEND_API_KEY: "" } })).res.statusCode, 503);
  assert.equal((await call({ body: order(), env: { __fetch: async () => new Response("x", { status: 500 }) } })).res.statusCode, 502);
  assert.equal((await call({ body: order(), env: { __fetch: async () => { throw new Error("net"); } } })).res.statusCode, 502);
  assert.equal((await call({ body: order(), env: { HALFSCREW_LICENSE_SECRET: "short" } })).res.statusCode, 503);
});

test("email body escapes the order name", () => {
  const m = buildKeyEmail({ licenseKey: "HSS-A-00000000-00000000-00000000", orderName: "<b>x</b>" });
  assert.ok(!m.html.includes("<b>x</b>"));
});
