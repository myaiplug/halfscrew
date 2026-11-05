#!/usr/bin/env node
"use strict";
// Support tool: re-derive the key for a Shopify order id (e.g. a buyer lost their email).
//   HALFSCREW_LICENSE_SECRET=... node scripts/issue-shopify-key.js 1234567890123
const { deriveKey, keySecret } = require("../lib/shopify");
const id = process.argv[2];
if (!id) { console.error("usage: issue-shopify-key.js <shopify order id>"); process.exit(1); }
try { console.log(deriveKey(id, keySecret())); } catch (e) { console.error(e.message); process.exit(1); }
