"use strict";
const { deriveKey, keySecret, secretOk, productSkus, orderHasHalfScrew, orderIsPaid, verifyWebhookHmac } = require("../../lib/shopify");
const { sendKeyEmail } = require("../../lib/email");

// Shopify "Order payment" (orders/paid) webhook -> emails the buyer their HalfScrew key.
// Server-to-server only (no CORS). Needs the RAW body for the HMAC, so Vercel's body parser is switched off.

async function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  if (req.body && typeof req.body === "object") return null; // already parsed -> exact bytes lost -> cannot verify
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    const b = typeof c === "string" ? Buffer.from(c) : c;
    size += b.length;
    if (size > 2 * 1024 * 1024) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function handle(req, res, env = process.env, fetchImpl) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return reply(res, 405, { ok: false, error: "Use POST." }); }
  const webhookSecret = env.SHOPIFY_WEBHOOK_SECRET;
  if (!webhookSecret) return reply(res, 503, { ok: false, error: "SHOPIFY_WEBHOOK_SECRET is not set." });
  const raw = await rawBody(req);
  if (!raw || !verifyWebhookHmac(raw, req.headers["x-shopify-hmac-sha256"], webhookSecret)) return reply(res, 401, { ok: false, error: "Bad signature." });

  let order;
  try { order = JSON.parse(raw.toString("utf8")); } catch { return reply(res, 400, { ok: false, error: "Bad JSON." }); }
  if (!orderHasHalfScrew(order, productSkus(env))) return reply(res, 200, { ok: true, ignored: "not_halfscrew" });
  if (!orderIsPaid(order)) return reply(res, 200, { ok: true, ignored: "not_paid" });

  const secret = keySecret(env);
  if (!secretOk(secret)) return reply(res, 503, { ok: false, error: "License secret is not configured." });
  const to = String(order.email || order.contact_email || (order.customer && order.customer.email) || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return reply(res, 200, { ok: true, ignored: "no_email" });

  const licenseKey = deriveKey(order.id, secret);
  const sent = await sendKeyEmail({ to, licenseKey, orderName: order.name, orderId: order.id }, env, fetchImpl);
  if (sent.kind === "not_configured") return reply(res, 503, { ok: false, error: "Email sender (RESEND_API_KEY / HALFSCREW_FROM_EMAIL) is not configured." });
  if (sent.kind !== "sent") return reply(res, 502, { ok: false, error: "Email provider failed; Shopify will retry." });
  return reply(res, 200, { ok: true, delivered: true, order: order.name || String(order.id) }); // never echo the key or address
}

module.exports = (req, res) => handle(req, res);
module.exports.handle = handle;
module.exports.config = { api: { bodyParser: false } };
