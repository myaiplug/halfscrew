"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { handleCors, allowedOrigins, publicConfig } = require("../lib/http");

function fakeRes() {
  const res = { headers: {}, statusCode: 200, body: "", ended: false, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b || ""; this.ended = true; } };
  return res;
}
const PAGES = "https://myaiplug.github.io";

test("allowed origin gets ACAO + preflight 204", () => {
  const res = fakeRes();
  assert.equal(handleCors({ method: "OPTIONS", headers: { origin: PAGES } }, res, {}), false);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], PAGES);
  assert.match(res.headers["access-control-allow-headers"], /content-type/);
});

test("POST from the Pages origin proceeds with ACAO echo, no-store and Vary", () => {
  const res = fakeRes();
  assert.equal(handleCors({ method: "POST", headers: { origin: PAGES } }, res, {}), true);
  assert.equal(res.headers["access-control-allow-origin"], PAGES);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers.vary, "Origin");
});

test("another website's Origin is refused (403) and gets no ACAO", () => {
  const res = fakeRes();
  assert.equal(handleCors({ method: "POST", headers: { origin: "https://evil.example" } }, res, {}), false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("non-POST is 405; no-Origin POST (curl/server) proceeds without CORS headers", () => {
  const res = fakeRes();
  assert.equal(handleCors({ method: "GET", headers: {} }, res, {}), false);
  assert.equal(res.statusCode, 405);
  const res2 = fakeRes();
  assert.equal(handleCors({ method: "POST", headers: {} }, res2, {}), true);
  assert.equal(res2.headers["access-control-allow-origin"], undefined);
});

test("allow-list is overridable via env and trims trailing slashes", () => {
  assert.deepEqual(allowedOrigins({}), [PAGES]);
  assert.deepEqual(allowedOrigins({ HALFSCREW_ALLOWED_ORIGINS: "https://a.example/, https://b.example" }), ["https://a.example", "https://b.example"]);
});

test("public config only exposes a gumroad.com /l/ URL", () => {
  assert.equal(publicConfig({ GUMROAD_HALFSCREW_URL: "https://nodaw.gumroad.com/l/halfscrew" }).buyUrl, "https://nodaw.gumroad.com/l/halfscrew");
  assert.equal(publicConfig({ GUMROAD_HALFSCREW_URL: "https://evil.example/l/x" }).buyUrl, "");
  assert.equal(publicConfig({}).buyUrl, "");
  assert.equal(publicConfig({}).priceLabel, "$4");
});

test("status: protected path rejects a missing / forged token with 401 and accepts a signed one", async () => {
  const { issueToken } = require("../lib/token");
  const secret = "s".repeat(48); process.env.HALFSCREW_LICENSE_SECRET = secret;
  const status = require("../api/license/status.js");
  const call = async (body) => {
    const { Readable } = require("node:stream");
    const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: "POST", headers: { origin: "https://myaiplug.github.io" } });
    const res = { headers: {}, statusCode: 200, body: "", setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b || ""; } };
    await status(req, res); return { code: res.statusCode, json: JSON.parse(res.body) };
  };
  assert.equal((await call({})).code, 401);
  assert.equal((await call({ token: "eyJ2IjoxfQ.AAAA" })).code, 401);
  const t = issueToken("GOODKEY1-AAAA", secret);
  const ok = await call({ token: t.token || t });
  assert.equal(ok.code, 200); assert.equal(ok.json.valid, true);
});
