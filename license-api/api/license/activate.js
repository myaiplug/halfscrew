"use strict";
const { activateLicense } = require("../../lib/unlock");
const { handleCors, licenseDeps, licenseResponse, readBody, sendJson } = require("../../lib/http");

// POST { licenseKey } -> verifies the Gumroad key (counts one activation) and returns a signed 24 h session token.
module.exports = async function handler(req, res) {
  if (!handleCors(req, res)) return;
  const { licenseKey } = await readBody(req);
  if (typeof licenseKey !== "string" || !licenseKey.trim()) return sendJson(res, 400, { valid: false, status: "bad_request", error: "Paste your license key." });
  return licenseResponse(res, await activateLicense(licenseKey, licenseDeps()));
};
