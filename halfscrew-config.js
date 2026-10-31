/* HALFSCREW — storefront + license service config (public values only, never secrets).
   licenseApi : the Vercel project "halfscrew-license" (Gumroad key verification, signed 24 h tokens).
   gumroadUrl : the $4 Gumroad product page. The live value can also be set without a site release through the
                Vercel env GUMROAD_HALFSCREW_URL, which the page reads from <licenseApi>/api/license/config. */
window.HALFSCREW_CONFIG = {
  licenseApi: "https://halfscrew-license.vercel.app",
  gumroadUrl: "https://nodaw.gumroad.com/l/halfscrew",
  priceLabel: "$4",
  supportEmail: "NoDAW@nodawlabs.com",
};
