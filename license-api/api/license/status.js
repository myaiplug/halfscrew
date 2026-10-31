"use strict";
const { verifyToken } = require("../../lib/token");
const { handleCors, readBody, sendJson } = require("../../lib/http");

// POST { token } -> checks the HMAC signature and expiry of a HalfScrew session token. No Gumroad call.
module.exports = async function handler(req, res) {
  if (!handleCors(req, res)) return;
  const { token } = await readBody(req);
  const check = verifyToken(token, process.env.HALFSCREW_LICENSE_SECRET);
  if (check.valid) return sendJson(res, 200, { valid: true, expiresAt: check.payload.exp * 1000 });
  if (check.reason === "not_configured") return sendJson(res, 503, { valid: false, status: "not_configured" });
  return sendJson(res, 401, { valid: false, status: check.reason, error: "Missing, invalid or expired license token." });
};
