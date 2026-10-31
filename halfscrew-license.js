/* HALFSCREW — Gumroad license-key unlock ($4, unlimited exports). Mirrors reTUNE[432]'s unlock.
   - The buyer pastes the key from the Gumroad receipt / content page (a ?license_key=… deep link also works: auto-activated, then stripped).
   - <licenseApi>/api/license/activate verifies it with Gumroad (counts one browser, max 5) and returns a signed 24 h session token.
   - Unlimited export is only enabled after the server confirmed a token during THIS page session (activate / refresh / status),
     so editing localStorage alone unlocks nothing on this path. window.HSLicense.active() is read by role() in halfscrew.js. */
(function () {
  "use strict";
  var CFG = window.HALFSCREW_CONFIG || {};
  var API = String(CFG.licenseApi || "").replace(/\/$/, "");
  var STORE = "halfscrew-license";
  var REFRESH_MARGIN = 2 * 60 * 60 * 1000;
  var verified = null;            /* { token, expiresAt } in memory only, set after a server check */
  var pendingKey = "";            /* key to retry after a network error */
  var busy = false;

  var $ = function (id) { return document.getElementById(id); };
  var el = {};

  function readRec() { try { var r = JSON.parse(localStorage.getItem(STORE) || "null"); return r && typeof r.key === "string" && r.key ? r : null; } catch (e) { return null; } }
  function writeRec(r) { try { if (r) localStorage.setItem(STORE, JSON.stringify(r)); else localStorage.removeItem(STORE); } catch (e) {} }

  /* strip ?license_key= right away so the key never lingers in the address bar / history */
  function takeKeyFromUrl() {
    try {
      var url = new URL(window.location.href);
      if (!url.searchParams.has("license_key")) return "";
      var key = (url.searchParams.get("license_key") || "").replace(/\s+/g, "");
      url.searchParams.delete("license_key");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
      return key;
    } catch (e) { return ""; }
  }
  var urlKey = takeKeyFromUrl();

  async function post(path, payload) {
    var res = await fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), cache: "no-store" });
    var data = await res.json().catch(function () { return {}; });
    return { http: res.status, data: data };
  }

  function active() { return !!(verified && verified.expiresAt > Date.now()); }
  function fmtUntil(ms) { return new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }); }

  /* ── UI ─────────────────────────────────────────────────────────────────────────────────────────── */
  var LABEL = { locked: "Demo · 20 second export", checking: "Checking license…", unlocked: "Unlimited · full export", invalid: "Demo · 20 second export", refunded: "Demo · 20 second export", cap: "Demo · 20 second export", network: "Demo · 20 second export" };
  function paint(state, msg, opts) {
    opts = opts || {};
    var root = el.root; if (!root) return;
    root.setAttribute("data-state", state);
    root.setAttribute("aria-busy", state === "checking" ? "true" : "false");
    var label = opts.label || LABEL[state] || LABEL.locked;
    if (state !== "unlocked" && state !== "checking" && typeof window.halfscrewRole === "function") {
      var who = window.halfscrewRole();   /* admin / legacy $19 pass holders keep their full export */
      if (who === "admin") label = "Admin · full export"; else if (who === "unlimited") label = "Unlimited · full export · legacy pass";
    }
    if (el.state) el.state.textContent = label;
    if (el.msg) { el.msg.textContent = msg || ""; el.msg.setAttribute("role", state === "locked" || state === "checking" || state === "unlocked" ? "status" : "alert"); }
    if (el.retry) el.retry.hidden = state !== "network";
    if (el.btn) el.btn.disabled = state === "checking";
    if (el.input) el.input.disabled = state === "checking";
    window.dispatchEvent(new CustomEvent("halfscrew-license-change", { detail: { active: active() } }));
  }
  function kindOf(status) {
    if (status === "refunded" || status === "chargebacked" || status === "disputed" || status === "subscription_inactive") return "refunded";
    if (status === "over_cap") return "cap";
    if (status === "outage" || status === "not_configured") return "network";
    return "invalid";
  }
  function support() { return CFG.supportEmail || "NoDAW@nodawlabs.com"; }

  function unlock(key, token, expiresAt, note) {
    writeRec({ key: key, token: token, expiresAt: expiresAt });
    verified = { token: token, expiresAt: expiresAt };
    pendingKey = ""; if (el.input) el.input.value = "";
    paint("unlocked", note);
  }
  function lock(state, msg, keepKey) {
    var stored = readRec();
    writeRec(keepKey && stored ? { key: stored.key } : null);
    verified = null;
    paint(state, msg);
  }

  async function activate(key) {
    pendingKey = key;
    paint("checking", "Checking your license key with Gumroad…");
    try {
      var r = await post("/api/license/activate", { licenseKey: key });
      if (r.data && r.data.valid && r.data.token) return unlock(key, r.data.token, r.data.expiresAt, "License verified. Unlimited exports are unlocked in this browser: full-length WAV, no 20 second cap.");
      var kind = r.http >= 500 ? "network" : kindOf(r.data && r.data.status);
      paint(kind, (r.data && r.data.error) || (kind === "network" ? "License check is temporarily unavailable. Please try again in a minute." : "That license key wasn't recognized."));
    } catch (e) {
      paint("network", "Network error while checking the key. Check your connection and retry.");
    }
  }

  /* silent re-check (never counts a browser). On an outage keep a still-valid token, but only after the server confirms it. */
  async function refresh(rec, quiet) {
    if (busy) return; busy = true;
    pendingKey = rec.key;
    if (!quiet) paint("checking", "Restoring your unlimited-export license…");
    try {
      var outage = false;
      try {
        var r = await post("/api/license/refresh", { licenseKey: rec.key });
        if (r.data && r.data.valid && r.data.token) return unlock(rec.key, r.data.token, r.data.expiresAt, "License active in this browser: unlimited full-length exports.");
        if (r.http >= 500) outage = true;
        else { var k = kindOf(r.data && r.data.status); return lock(k, (r.data && r.data.error) || "Your license key could not be re-verified, so unlimited exports were turned off in this browser.", k === "cap"); }
      } catch (e) { outage = true; }
      if (outage && rec.token && (rec.expiresAt || 0) > Date.now()) {
        try {
          var s = await post("/api/license/status", { token: rec.token });
          if (s.data && s.data.valid) {
            verified = { token: rec.token, expiresAt: Number(s.data.expiresAt) };
            return paint("unlocked", "Couldn't reach Gumroad just now, so we're using your verified session (valid until " + fmtUntil(verified.expiresAt) + ").");
          }
        } catch (e) { /* fall through */ }
      }
      verified = null;
      paint("network", "Couldn't verify your license right now. Demo mode is on; retry, or we'll try again next time you open the page.");
    } finally { busy = false; }
  }

  function submit(ev) {
    ev.preventDefault();
    var key = (el.input.value || "").replace(/\s+/g, "");
    if (!key) { paint("invalid", "Paste your license key first."); return; }
    var stored = readRec();
    if (stored && stored.key === key && stored.token) refresh(stored, false); else activate(key);
  }
  function retry() {
    var stored = readRec();
    if (stored && stored.key === pendingKey && stored.token) refresh(stored, false);
    else if (pendingKey) activate(pendingKey);
    else if (stored) refresh(stored, false);
  }
  function remove() { lock("locked", "Unlimited exports removed from this browser. Enter your license key any time to unlock again."); }

  /* Gumroad URL: built-in config, overridable from the license service (Vercel env GUMROAD_HALFSCREW_URL) */
  function setBuyUrl(url) { if (el.buy && /^https:\/\//.test(url || "")) el.buy.href = url; }
  async function loadConfig() {
    try {
      var res = await fetch(API + "/api/license/config", { cache: "default" });
      var cfg = await res.json();
      if (cfg && cfg.buyUrl) setBuyUrl(cfg.buyUrl);
    } catch (e) { /* keep the built-in URL */ }
  }

  function init() {
    el.root = $("pass"); el.state = $("passState"); el.msg = $("licenseMsg"); el.buy = $("buyBtn");
    el.form = $("licenseForm"); el.input = $("licenseKey"); el.btn = $("licenseBtn"); el.retry = $("licenseRetry"); el.remove = $("licenseRemove");
    if (!el.root) return;
    setBuyUrl(CFG.gumroadUrl);
    var priceEl = $("buyPrice"); if (priceEl && CFG.priceLabel) priceEl.textContent = CFG.priceLabel;
    el.form.addEventListener("submit", submit);
    el.retry.addEventListener("click", retry);
    el.remove.addEventListener("click", remove);
    paint("locked", "");
    loadConfig();
    var stored = readRec();
    if (urlKey && (!stored || stored.key !== urlKey)) activate(urlKey);
    else if (stored) refresh(stored, false);
    window.setInterval(function () {
      var s = readRec();
      if (s && verified && verified.expiresAt - Date.now() < REFRESH_MARGIN) refresh(s, true);
    }, 15 * 60 * 1000);
  }

  window.HSLicense = { active: active, state: function () { return el.root ? el.root.getAttribute("data-state") : "locked"; } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
