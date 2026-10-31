"use strict";
const { handleCors, publicConfig, sendJson } = require("../../lib/http");

// GET -> { buyUrl, priceLabel, supportEmail, maxActivations }. Public values only; buyUrl comes from env GUMROAD_HALFSCREW_URL
// ("" when unset or not a gumroad.com /l/ link, in which case the site falls back to its built-in config).
module.exports = function handler(req, res) {
  if (!handleCors(req, res, process.env, ["GET"])) return;
  res.setHeader("Cache-Control", "public, max-age=300");
  return sendJson(res, 200, publicConfig());
};
