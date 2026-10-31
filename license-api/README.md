# HalfScrew license API

Tiny Vercel serverless project (no database, no build step) that turns a Gumroad license key into a short-lived signed session token.
The static site (GitHub Pages) calls it cross-origin; CORS only allows `https://myaiplug.github.io` (override with `HALFSCREW_ALLOWED_ORIGINS`, comma-separated).

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/license/activate` | POST `{licenseKey}` | Verifies with Gumroad, enforces the 5-browser cap, counts the activation, returns `{valid, token, expiresAt}` |
| `/api/license/refresh` | POST `{licenseKey}` | Re-checks refund/chargeback/dispute/subscription state **without** counting an activation |
| `/api/license/status` | POST `{token}` | Protected path: 200 for a good signed token, 401 for missing/forged/expired |
| `/api/license/config` | GET | Public storefront config (`buyUrl`, price label, support email) so the Gumroad URL can change without a site release |

## Environment variables (Vercel project `halfscrew-license`, Production + Preview)

| Name | Meaning |
| --- | --- |
| `GUMROAD_HALFSCREW_PRODUCT_ID` | The Gumroad **product id** (not the permalink). Until it is the real id every key answers "invalid". |
| `GUMROAD_HALFSCREW_URL` | Public product page, e.g. `https://nodaw.gumroad.com/l/halfscrew`. Served by `/config` and used by the Unlock button. |
| `HALFSCREW_LICENSE_SECRET` | Random >=32 char secret that signs session tokens (HMAC-SHA256, 24 h TTL). Never in client code. |
| `HALFSCREW_ALLOWED_ORIGINS` | Optional CORS allow-list override. |
| `HALFSCREW_MAX_ACTIVATIONS` | Optional cap override (default 5). |

## Gumroad product settings
* Product type: **Digital product** (not a bundle), name **HalfScrew — Unlimited Exports**, price **$4**, permalink `halfscrew`.
* Enable **Generate a unique license key per sale** (license keys). Leave "limit activations" off - the API enforces 5 browsers itself.
* Content page (what the buyer sees after paying): insert the **License key** block (Insert -> License key) and a button/link "Open HalfScrew" -> `https://myaiplug.github.io/halfscrew/`, with the line "Copy the license key above, open HalfScrew and paste it under *Enter license key*". Gumroad does **not** document substituting the key into a redirect/button URL, so the buyer pastes the key (it is also in the emailed receipt and on the product's download page). `?license_key=XXXX` deep links still work if you ever generate one (the page activates, then strips it from the address bar).
* Support contact in all copy: NoDAW@nodawlabs.com. Refunds: Gumroad refund -> key stops working at the next refresh/activation.
* Product id: Gumroad -> product -> Content/Share, or `GET https://api.gumroad.com/v2/products` with an access token; it is the base64-looking `product_id`.

## Go-live checklist
1. Create/publish the Gumroad product with the settings above.
2. `vercel env` -> set `GUMROAD_HALFSCREW_PRODUCT_ID` and `GUMROAD_HALFSCREW_URL` (Production + Preview), then `vercel deploy --prod` from this folder.
3. If the permalink differs from `halfscrew`, also update `gumroadUrl` in `/halfscrew-config.js` (fallback used if `/config` is unreachable).
4. Buy once with a real $4 (or 100%-off) purchase, open HalfScrew, paste the key, confirm "Unlimited · full export".
5. Merge the PR.

## Tests
`npm test` - unit tests with a mock Gumroad (test-only; production code never fakes Gumroad).
