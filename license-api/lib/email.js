"use strict";
const SITE = "https://myaiplug.github.io/halfscrew/";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function buildKeyEmail({ licenseKey, orderName, supportEmail = "NoDAW@nodawlabs.com" }) {
  const link = `${SITE}?license_key=${encodeURIComponent(licenseKey)}`;
  const text = [
    "Thanks for buying HalfScrew Unlimited!",
    "",
    `Your license key${orderName ? ` (order ${orderName})` : ""}:`,
    licenseKey,
    "",
    `One-click unlock: ${link}`,
    `Or open ${SITE}, click Unlock, and paste the key.`,
    "The key works in up to 5 browsers.",
    "",
    `Questions? Email ${supportEmail}.`,
  ].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px"><h2>Thanks for buying HalfScrew Unlimited!</h2><p>Your license key${orderName ? ` (order ${esc(orderName)})` : ""}:</p><p style="font-family:monospace;font-size:18px;background:#f3f3f3;padding:12px;border-radius:6px">${esc(licenseKey)}</p><p><a href="${esc(link)}">Unlock HalfScrew now</a><br>Or open <a href="${SITE}">${SITE}</a>, click Unlock and paste the key.</p><p>The key works in up to 5 browsers.</p><p>Questions? Email <a href="mailto:${supportEmail}">${supportEmail}</a>.</p></div>`;
  return { subject: "Your HalfScrew Unlimited license key", text, html };
}

// Sends through Resend. Idempotency-Key makes Shopify webhook retries safe (no duplicate email within 24 h).
async function sendKeyEmail({ to, licenseKey, orderName, orderId }, env = process.env, fetchImpl = fetch) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.HALFSCREW_FROM_EMAIL;
  if (!apiKey || !from) return { kind: "not_configured" };
  const mail = buildKeyEmail({ licenseKey, orderName });
  try {
    const r = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "Idempotency-Key": `halfscrew-shopify-${orderId}` },
      body: JSON.stringify({ from, to: [to], subject: mail.subject, text: mail.text, html: mail.html }),
    });
    return r.ok ? { kind: "sent" } : { kind: "failed", status: r.status };
  } catch { return { kind: "failed" }; }
}

module.exports = { buildKeyEmail, sendKeyEmail };
