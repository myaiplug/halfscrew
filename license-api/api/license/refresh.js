"use strict";
const { refreshLicense } = require("../../lib/unlock");
const { handleCors, licenseDeps, licenseResponse, readBody, sendJson } = require("../../lib/http");

// POST { licenseKey } -> re-verifies with Gumroad WITHOUT counting a use and returns a fresh token.
// Gumroad outage -> 503; the client may keep a still-valid token it already has (confirmed via /api/license/status).
module.exports = async function handler(req, res) {
  if (!handleCors(req, res)) return;
  const { licenseKey } = await readBody(req);
  if (typeof licenseKey !== "string" || !licenseKey.trim()) return sendJson(res, 400, { valid: false, status: "bad_request", error: "Missing license key." });
  return licenseResponse(res, await refreshLicense(licenseKey, licenseDeps()));
};
