"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { activateLicense, refreshLicense, GUMROAD_VERIFY_URL } = require("../lib/gumroad");
const { verifyToken, issueToken, hashLicenseKey } = require("../lib/token");

const PRODUCT = "TestProd123==";
const SECRET = "x".repeat(48);
const KEY = "ABCD1234-EF567890-1234ABCD-5678EF90";
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

function purchase(overrides = {}) {
  return { product_id: PRODUCT, refunded: false, chargebacked: false, disputed: false, dispute_won: false, subscription_cancelled_at: null, subscription_ended_at: null, subscription_failed_at: null, license_key: KEY, email: "buyer@example.com", ...overrides };
}

// Test-only Gumroad stand-in (lives in tests, never in shipped code): keeps a uses counter, records calls, simulates states.
function mockGumroad({ uses = 0, purchaseOverrides = {}, mode = "ok" } = {}) {
  const state = { uses, calls: [] };
  const fetchImpl = async (url, init) => {
    assert.equal(url, GUMROAD_VERIFY_URL);
    const params = new URLSearchParams(init.body);
    const call = { productId: params.get("product_id"), key: params.get("license_key"), increment: params.get("increment_uses_count") };
    state.calls.push(call);
    if (mode === "network") throw new TypeError("fetch failed");
    if (mode === "500") return new Response("<html>oops</html>", { status: 502 });
    if (mode === "429") return new Response(JSON.stringify({ success: false }), { status: 429 });
    if (call.productId !== PRODUCT || call.key !== KEY) return Response.json({ success: false, message: "That license does not exist for the provided product." }, { status: 404 });
    if (mode === "disabled") return Response.json({ success: false, message: "This license key has been disabled." }, { status: 404 });
    if (call.increment === "true") state.uses += 1;
    return Response.json({ success: true, uses: state.uses, purchase: purchase(purchaseOverrides) });
  };
  return { state, fetchImpl };
}

const deps = (fetchImpl, extra = {}) => ({ productId: PRODUCT, secret: SECRET, maxActivations: 5, supportEmail: "NoDAW@nodawlabs.com", fetchImpl, now: () => NOW, ...extra });

test("valid key activates once (counts one use), returns a signed token without the key", async () => {
  const g = mockGumroad({ uses: 0 });
  const result = await activateLicense(`  ${KEY} \n`, deps(g.fetchImpl));
  assert.equal(result.status, "active");
  assert.equal(g.state.uses, 1);
  assert.deepEqual(g.state.calls.map((c) => c.increment), ["false", "true"]);
  assert.ok(!result.token.includes(KEY));
  assert.ok(!Buffer.from(result.token.split(".")[0], "base64url").toString().includes(KEY));
  const check = verifyToken(result.token, SECRET, NOW + 1000);
  assert.equal(check.valid, true);
  assert.equal(check.payload.kh, hashLicenseKey(KEY));
  assert.equal(check.payload.exp - check.payload.iat, 24 * 3600);
  assert.equal(result.expiresAt, NOW + 24 * 3600 * 1000);
});

test("refresh re-verifies WITHOUT counting a use", async () => {
  const g = mockGumroad({ uses: 2 });
  assert.equal((await refreshLicense(KEY, deps(g.fetchImpl))).status, "active");
  assert.equal(g.state.uses, 2);
  assert.deepEqual(g.state.calls.map((c) => c.increment), ["false"]);
});

test("invalid key is rejected with a friendly message and no token", async () => {
  const g = mockGumroad();
  const result = await activateLicense("WRONG000-WRONG000-WRONG000-WRONG000", deps(g.fetchImpl));
  assert.equal(result.status, "invalid");
  assert.match(result.message, /wasn't recognized/);
  assert.equal(result.token, undefined);
  assert.equal(g.state.uses, 0);
});

test("malformed input never reaches Gumroad", async () => {
  const g = mockGumroad();
  for (const bad of ["", "abc", "<script>", "x".repeat(200), null, 42]) assert.equal((await activateLicense(bad, deps(g.fetchImpl))).status, "invalid");
  assert.equal(g.state.calls.length, 0);
});

test("disabled key is rejected", async () => {
  assert.equal((await activateLicense(KEY, deps(mockGumroad({ mode: "disabled" }).fetchImpl))).status, "disabled");
});

test("refunded purchase is rejected (activate and refresh) and no use is counted", async () => {
  const g = mockGumroad({ purchaseOverrides: { refunded: true } });
  assert.equal((await activateLicense(KEY, deps(g.fetchImpl))).status, "refunded");
  assert.equal(g.state.uses, 0);
  const r = await refreshLicense(KEY, deps(g.fetchImpl));
  assert.equal(r.status, "refunded");
  assert.match(r.message, /NoDAW@nodawlabs\.com/);
});

test("chargebacked purchase is rejected", async () => {
  const g = mockGumroad({ purchaseOverrides: { chargebacked: true } });
  assert.equal((await activateLicense(KEY, deps(g.fetchImpl))).status, "chargebacked");
  assert.equal((await refreshLicense(KEY, deps(g.fetchImpl))).status, "chargebacked");
});

test("disputed purchase is rejected unless the dispute was won", async () => {
  assert.equal((await activateLicense(KEY, deps(mockGumroad({ purchaseOverrides: { disputed: true } }).fetchImpl))).status, "disputed");
  assert.equal((await activateLicense(KEY, deps(mockGumroad({ purchaseOverrides: { disputed: true, dispute_won: true } }).fetchImpl))).status, "active");
});

test("cancelled / failed subscriptions are rejected", async () => {
  for (const field of ["subscription_cancelled_at", "subscription_ended_at", "subscription_failed_at"]) {
    assert.equal((await refreshLicense(KEY, deps(mockGumroad({ purchaseOverrides: { [field]: "2026-10-01T00:00:00Z" } }).fetchImpl))).status, "subscription_inactive");
  }
});

test("sale for a different product_id is rejected", async () => {
  const g = mockGumroad({ purchaseOverrides: { product_id: "SomeOtherProduct==" } });
  assert.equal((await activateLicense(KEY, deps(g.fetchImpl))).status, "wrong_product");
  assert.equal(g.state.uses, 0);
});

test("activation cap: 5 browsers OK, the 6th is rejected without counting; refresh above cap is rejected", async () => {
  const g = mockGumroad({ uses: 0 });
  for (let i = 1; i <= 5; i += 1) assert.equal((await activateLicense(KEY, deps(g.fetchImpl))).status, "active", `activation ${i}`);
  assert.equal(g.state.uses, 5);
  const sixth = await activateLicense(KEY, deps(g.fetchImpl));
  assert.equal(sixth.status, "over_cap");
  assert.match(sixth.message, /NoDAW@nodawlabs\.com/);
  assert.equal(g.state.uses, 5);
  assert.equal((await refreshLicense(KEY, deps(g.fetchImpl))).status, "active", "existing browsers keep working at the cap");
  assert.equal((await refreshLicense(KEY, deps(mockGumroad({ uses: 9 }).fetchImpl))).status, "over_cap");
});

test("Gumroad outage (network error, 5xx, 429) -> outage, never a token", async () => {
  for (const mode of ["network", "500", "429"]) {
    const g = mockGumroad({ mode });
    const a = await activateLicense(KEY, deps(g.fetchImpl));
    const r = await refreshLicense(KEY, deps(g.fetchImpl));
    assert.equal(a.status, "outage", mode);
    assert.equal(r.status, "outage", mode);
    assert.equal(a.token, undefined);
    assert.equal(r.token, undefined);
  }
});

test("timeout counts as outage", async () => {
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  assert.equal((await refreshLicense(KEY, deps(hang, { timeoutMs: 50 }))).status, "outage");
});

test("missing product id or weak secret -> not_configured, no Gumroad call", async () => {
  const g = mockGumroad();
  assert.equal((await activateLicense(KEY, deps(g.fetchImpl, { productId: "" }))).status, "not_configured");
  assert.equal((await activateLicense(KEY, deps(g.fetchImpl, { secret: "short" }))).status, "not_configured");
  assert.equal((await refreshLicense(KEY, deps(g.fetchImpl, { secret: undefined }))).status, "not_configured");
  assert.equal(g.state.calls.length, 0);
});

test("tokens: tampering, wrong secret, expiry and garbage are rejected", () => {
  const { token } = issueToken(KEY, SECRET, NOW);
  assert.equal(verifyToken(token, SECRET, NOW).valid, true);
  assert.equal(verifyToken(token, "y".repeat(48), NOW).reason, "bad_signature");
  assert.equal(verifyToken(token, SECRET, NOW + 24 * 3600 * 1000 + 1).reason, "expired");
  const [body, sig] = token.split(".");
  const forged = JSON.parse(Buffer.from(body, "base64url").toString());
  forged.exp += 365 * 24 * 3600;
  assert.equal(verifyToken(`${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`, SECRET, NOW).reason, "bad_signature");
  for (const garbage of ["", "a.b", "abc", null, 5, "x".repeat(2000), `${body}.`]) assert.equal(verifyToken(garbage, SECRET, NOW).valid, false);
  assert.equal(verifyToken(token, "", NOW).reason, "not_configured");
});
