"use strict";
// Shared request plumbing: config from env, CORS allow-list, JSON helpers. No secrets are ever sent to the client.

const SUPPORT_EMAIL = "NoDAW@nodawlabs.com";
const DEFAULT_ORIGINS = ["https://myaiplug.github.io"];
const DEFAULT_MAX_ACTIVATIONS = 5;

function licenseDeps(env = process.env) {
  const max = Number.parseInt(env.HALFSCREW_MAX_ACTIVATIONS || "", 10);
  return {
    productId: String(env.GUMROAD_HALFSCREW_PRODUCT_ID || "").trim(),
    secret: env.HALFSCREW_LICENSE_SECRET,
    maxActivations: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_ACTIVATIONS,
    supportEmail: SUPPORT_EMAIL,
  };
}

function allowedOrigins(env = process.env) {
  const extra = String(env.HALFSCREW_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  return extra.length ? extra : DEFAULT_ORIGINS;
}

// Returns true when the request may proceed. Always sets Vary + no-store; sets ACAO only for an allow-listed Origin.
// A request that carries a disallowed Origin (i.e. another website) is refused outright with 403.
function handleCors(req, res, env = process.env, methods = ["POST"]) {
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");
  const origin = req.headers.origin;
  if (origin) {
    if (!allowedOrigins(env).includes(origin)) { sendJson(res, 403, { valid: false, status: "forbidden_origin", error: "This origin may not use the HalfScrew license service." }); return false; }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", `${methods.join(", ")}, OPTIONS`);
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return false; }
  if (!methods.includes(req.method)) { res.setHeader("Allow", `${methods.join(", ")}, OPTIONS`); sendJson(res, 405, { valid: false, status: "method_not_allowed", error: `Use ${methods.join(" or ")}.` }); return false; }
  return true;
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  let raw = typeof req.body === "string" ? req.body : "";
  if (!raw && typeof req.on === "function") {
    raw = await new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => { data += c; if (data.length > 8192) { data = ""; } });
      req.on("end", () => resolve(data));
      req.on("error", () => resolve(""));
    });
  }
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

// Expected rejections (bad key, refunded, over cap…) answer 200 + valid:false so the browser logs no network error;
// only Gumroad outages / missing configuration use 503.
function licenseResponse(res, result) {
  if (result.status === "active") return sendJson(res, 200, { valid: true, status: "active", token: result.token, expiresAt: result.expiresAt });
  const status = result.status === "outage" || result.status === "not_configured" ? 503 : 200;
  return sendJson(res, status, { valid: false, status: result.status, error: result.message });
}

// Public, non-secret storefront config so the Gumroad URL can be changed from Vercel env without re-publishing the site.
function publicConfig(env = process.env) {
  const url = String(env.GUMROAD_HALFSCREW_URL || "").trim();
  return { buyUrl: /^https:\/\/[\w.-]+\.gumroad\.com\/l\/[\w-]+\/?$|^https:\/\/gumroad\.com\/l\/[\w-]+\/?$/.test(url) ? url : "", priceLabel: "$4", supportEmail: SUPPORT_EMAIL, maxActivations: licenseDeps(env).maxActivations };
}

module.exports = { publicConfig, SUPPORT_EMAIL, licenseDeps, allowedOrigins, handleCors, sendJson, readBody, licenseResponse };
