const crypto = require("crypto");

function verifyShopifyHmac(rawBody, header, secret) {
  if (!secret || !header) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(String(header));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function paidOrder(email, name) {
  const shop = process.env.SHOPIFY_SHOP || "shop.nodawlabs.com";
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) return { ok: false, error: "missing SHOPIFY_ADMIN_TOKEN" };
  const q = new URLSearchParams({ status: "any", email, limit: "20" });
  if (name) q.set("name", name);
  const res = await fetch(`https://${shop}/admin/api/2024-10/orders.json?${q}`, {
    headers: { "X-Shopify-Access-Token": token },
  });
  if (!res.ok) return { ok: false, error: "shopify " + res.status };
  const data = await res.json();
  const hit = (data.orders || []).find((o) => o.financial_status === "paid" || o.financial_status === "partially_paid");
  return hit ? { ok: true, order: hit.name, email: hit.email } : { ok: false, error: "no paid order" };
}

exports.handler = async (event) => {
  const headers = { "access-control-allow-origin": "*", "content-type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
  const hmac = event.headers["x-shopify-hmac-sha256"] || event.headers["X-Shopify-Hmac-Sha256"];
  if (hmac) {
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    if (!verifyShopifyHmac(raw, hmac, secret)) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: "bad signature" }) };
    const order = JSON.parse(raw || "{}");
    const paid = order.financial_status === "paid";
    return { statusCode: 200, headers, body: JSON.stringify({ ok: paid, order: order.name, email: order.email }) };
  }
  const body = JSON.parse(raw || "{}");
  const result = await paidOrder(String(body.email || "").toLowerCase(), body.order || "");
  return { statusCode: result.ok ? 200 : 402, headers, body: JSON.stringify(result) };
};
