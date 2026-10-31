/* HALFSCREW — EQ · FX · STRAINS drawer.
   Slides out from behind the chassis (desktop) / up as a bottom sheet (phones) and retracts again.
   Everything in here talks to the same knob system + the same audio graph as the main deck. */
(function () {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const drawer = $("#fxDrawer");
  if (!drawer || !window.HSKnobs || !window.HSFX) return;
  const rack = $("#rack");
  const lip = $("#fxLip");
  const hdrBtn = $("#fxBtn");
  const backdrop = $("#fxBackdrop");
  const reduced = window.matchMedia ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  const sheetMQ = window.matchMedia ? matchMedia("(max-width: 760px)") : { matches: false };
  const { STRAINS, FAMILIES } = HSFX;
  const E = window.HSEQ, BANDS = E.BANDS, ek = E.BAND_KEYS;
  let loading = false, currentId = null, isOpen = false, opener = null;

  const DIAL = '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="19" y="3" width="2.2" height="11" rx="1.1" fill="#f4ecff"/><rect x="19" y="3" width="2.2" height="11" rx="1.1" fill="#c9a7ff" opacity=".55"/></svg>';
  function knob(o) {
    return `<div class="knob-unit sm" data-fx-knob="${o.key}">
      <span class="knob-name">${o.name}</span>
      <div class="knob-wrap" data-knob="${o.key}" data-min="${o.min}" data-max="${o.max}" data-val="${o.val}" data-step="${o.step || 1}" data-fmt="${o.fmt}" data-label="${o.label}">
        <div class="led-ring"></div>
        <div class="knob"><div class="knob-face"><div class="knob-dial">${DIAL}</div></div></div>
      </div>
      <output class="knob-read" id="read-${o.key}"></output>
      ${o.sub ? `<span class="knob-sub">${o.sub}</span>` : ""}
    </div>`;
  }
  const FX = [
    { key: "rev", name: "REVERB", sub: "3.0 s HALL", def: 30 },
    { key: "del", name: "DELAY", sub: "1/8 · FB 50%", def: 25 },
    { key: "cho", name: "CHORUS", sub: "1.5 Hz", def: 30 },
    { key: "dis", name: "DRIVE", sub: "TANH 4x OS", def: 20 },
  ];

  drawer.innerHTML = `
    <div class="fx-shell">
      <div class="fx-grip" id="fxGrip" role="presentation"><i></i></div>
      <header class="fx-head">
        <div class="fx-title"><span class="fx-led on" aria-hidden="true"></span><h2>EQ <b>·</b> FX <b>·</b> STRAINS</h2></div>
        <div class="fx-strain-nav" role="group" aria-label="Strain">
          <button type="button" class="fx-nav" id="strainPrev" aria-label="Previous strain">‹</button>
          <button type="button" class="fx-strain-name" id="strainName" aria-live="polite">CUSTOM</button>
          <button type="button" class="fx-nav" id="strainNext" aria-label="Next strain">›</button>
          <span class="fx-edited" id="strainEdited" hidden>EDITED</span>
        </div>
        <button type="button" class="fx-close" id="fxClose" aria-label="Close EQ and FX drawer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
      </header>
      <div class="fx-body">
        <section class="fx-mod eq" style="--i:1" aria-label="Equalizer">
          <h3 class="mod-h"><i></i>8-BAND EQ<span class="mod-sub">±18 dB · EDITABLE Q · DRAG NODES · SCROLL / PINCH = Q</span>
            <button type="button" class="led-btn" id="eqOn" role="switch" aria-checked="true" aria-label="EQ on/off"><i></i></button></h3>
          <div class="eq-bar">
            <div class="pre-wrap">
              <button type="button" class="pre-btn" id="preBtn" aria-haspopup="listbox" aria-expanded="false" aria-controls="preList" aria-label="EQ presets"><span class="pre-k">PRESET</span><b id="preName">Flat</b><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
              <span class="fx-edited" id="preEdited" hidden>EDITED</span>
              <ul class="pre-list" id="preList" role="listbox" aria-label="EQ presets" hidden></ul>
            </div>
            <output class="eq-read" id="eqRead" aria-live="off"></output>
          </div>
          <div class="eq-view" id="eqView">
            <canvas id="eqSpec" aria-hidden="true"></canvas>
            <svg id="eqSvg" aria-label="EQ curve: drag a node for frequency and gain, scroll or pinch for Q" role="group"></svg>
          </div>
          <div class="band-tabs" id="bandTabs" role="tablist" aria-label="EQ band">
            ${BANDS.map((b) => `<button type="button" role="tab" class="bt" id="bt${b.n}" data-band="${b.n}" aria-selected="false" aria-controls="bandPanel" tabindex="-1" aria-label="Band ${b.n}, ${b.name.toLowerCase()}"><i aria-hidden="true"></i><b>${b.n}</b><em>${b.short}</em></button>`).join("")}
          </div>
          <div class="band-panel" id="bandPanel" role="tabpanel" aria-label="Selected band controls">
            <div class="band-head">
              <button type="button" class="led-btn" id="bandOn" role="switch" aria-checked="false" aria-label="Band on/off"><i></i></button>
              <span class="band-name" id="bandName">BELL 2</span><span class="band-type" id="bandType"></span>
            </div>
            <div class="knob-row band-knobs">
              ${knob({ key: "eqF", name: "FREQ", sub: "HZ", min: 20, max: 20000, val: 1000, step: 1, fmt: "hz", label: "Band frequency" })}
              ${knob({ key: "eqG", name: "GAIN", sub: "±18 dB", min: -18, max: 18, val: 0, step: 0.5, fmt: "db1", label: "Band gain" })}
              <div class="knob-unit sm slope-unit" id="slopeUnit" hidden>
                <span class="knob-name">SLOPE</span>
                <div class="slope" role="radiogroup" aria-label="Filter slope"><button type="button" role="radio" aria-checked="true" data-s="12">12</button><button type="button" role="radio" aria-checked="false" data-s="24">24</button></div>
                <span class="knob-sub">dB / OCT</span>
              </div>
              ${knob({ key: "eqQ", name: "Q", sub: "WIDTH", min: 0.3, max: 12, val: 1, step: 0.01, fmt: "q", label: "Band Q" })}
            </div>
          </div>
        </section>
        <section class="fx-mod strains" style="--i:0" aria-label="Strains">
          <h3 class="mod-h"><i></i>STRAINS<span class="mod-sub">ONE-CLICK TIME · PITCH · WOW · EQ · FX</span></h3>
          <div class="fam-tabs" role="tablist" aria-label="Strain family" id="famTabs"></div>
          <div class="strain-list" id="strainList" role="listbox" aria-label="Strains" aria-orientation="vertical"></div>
        </section>
        <section class="fx-mod fxs" style="--i:2" aria-label="Effects">
          <h3 class="mod-h"><i></i>EFFECTS<span class="mod-sub">SERIES · SAME CHAIN IN EXPORT</span></h3>
          <div class="fx-grid">
            ${FX.map((f) => `<div class="fx-unit" data-fx="${f.key}">
              <button type="button" class="led-btn" role="switch" aria-checked="false" aria-label="${f.name.toLowerCase()} on/off" data-led="${f.key}"><i></i></button>
              ${knob({ key: f.key, name: f.name, sub: f.sub, min: 0, max: 100, val: 0, step: 1, fmt: "pct", label: f.name.toLowerCase() + " amount" })}
            </div>`).join("")}
          </div>
          <div class="out-row">
            ${knob({ key: "mix", name: "DRY/WET", min: 0, max: 100, val: 100, step: 1, fmt: "pct", label: "Dry wet mix" })}
            ${knob({ key: "out", name: "OUT", sub: "TRIM", min: -12, max: 12, val: 0, step: 0.5, fmt: "db", label: "Output trim" })}
            <div class="lim" aria-label="Output limiter">
              <span class="knob-name">LIMITER</span>
              <div class="gr" id="grMeter" role="img" aria-label="Gain reduction meter">${"<i></i>".repeat(10)}</div>
              <output class="knob-read" id="grRead">−1 dBTP</output>
              <span class="knob-sub">CEILING · EXPORT SAFE</span>
            </div>
          </div>
        </section>
      </div>
    </div>`;

  /* ── knobs ────────────────────────────────────────────────────── */
  HSKnobs.initAll(drawer);
  const K = (key) => $(`.knob-wrap[data-knob="${key}"]`).__knob;
  $("#read-out").textContent = "+0.0 dB";

  /* ── LED toggles ──────────────────────────────────────────────── */
  function setLed(btn, on) { btn.setAttribute("aria-checked", on ? "true" : "false"); btn.classList.toggle("on", !!on); }
  function setFxOn(key, on) {
    params[key + "On"] = !!on;
    setLed($(`[data-led="${key}"]`), on);
    $(`.fx-unit[data-fx="${key}"]`).classList.toggle("off", !on);
    applyParams(); notify();
  }
  function setEqOn(on) {
    params.eqOn = !!on; setLed($("#eqOn"), on);
    $(".fx-mod.eq").classList.toggle("bypass", !on);
    applyParams(); notify();
  }
  HSFX.FX_KEYS.forEach((k) => {
    const btn = $(`[data-led="${k}"]`);
    btn.addEventListener("click", () => {
      const on = !params[k + "On"];
      if (on && !params[k]) K(k).set(FX.find((f) => f.key === k).def);
      setFxOn(k, on);
    });
    /* turning the amount knob up wakes the effect */
    window.addEventListener("hs-param", (e) => {
      if (e.detail.key === k && e.detail.value > 0 && !params[k + "On"] && !loading) setFxOn(k, true);
      if (e.detail.key === k) $(`.fx-unit[data-fx="${k}"]`).classList.toggle("off", !params[k + "On"]);
    });
    setFxOn(k, false);
  });
  $("#eqOn").addEventListener("click", () => setEqOn(!params.eqOn));
  setEqOn(true);

  /* ── strains ──────────────────────────────────────────────────── */
  var famFilter = "ALL";
  const tabs = $("#famTabs"), list = $("#strainList");
  const famNames = ["ALL"].concat(FAMILIES.filter((f) => f !== "ORIGINAL"));
  tabs.innerHTML = famNames.map((f, i) => `<button type="button" role="tab" class="fam" aria-selected="${i === 0}" data-fam="${f}" tabindex="${i === 0 ? 0 : -1}">${f}</button>`).join("");
  function renderList() {
    const rows = STRAINS.filter((s) => famFilter === "ALL" || FAMILIES[s.fam] === famFilter || s.id === 0);
    list.innerHTML = rows.map((s) => `<button type="button" role="option" class="strain" data-id="${s.id}" aria-selected="${s.id === currentId}" tabindex="${s.id === currentId || (currentId === null && s.id === 0) ? 0 : -1}">
      <span class="s-no">${s.id ? String(s.id).padStart(2, "0") : "—"}</span>
      <span class="s-name"><i class="s-sw" aria-hidden="true" style="--sw:${s.hex}"></i><span>${s.name}</span></span>
      <span class="s-meta"><em>T</em>${s.time}<em>P</em>${s.pitch > 0 ? "+" : ""}${s.pitch}<em>W</em>${s.wow}</span>
      <span class="s-fx">${["rev", "del", "cho", "dis"].filter((k) => s[k]).map((k) => `<i class="tag-${k}" title="${k}"></i>`).join("")}</span>
    </button>`).join("");
  }
  renderList();
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest(".fam"); if (!b) return;
    famFilter = b.dataset.fam;
    $$(".fam", tabs).forEach((x) => { const on = x === b; x.setAttribute("aria-selected", on); x.tabIndex = on ? 0 : -1; });
    renderList();
  });
  tabs.addEventListener("keydown", (e) => {
    const t = $$(".fam", tabs), i = t.indexOf(document.activeElement);
    if (i < 0) return;
    const n = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : -1;
    if (n >= 0) { e.preventDefault(); const x = t[(n + t.length) % t.length]; x.focus(); x.click(); }
  });

  function sameAs(s) {
    const eq = (a, b) => Math.abs(a - b) < 0.01;
    return eq(params.time, s.time) && eq(params.pitch, s.pitch) && eq(params.wow, s.wow) &&
      E.sameBands(params, s.eq8) && eq(params.out, s.out) &&
      HSFX.FX_KEYS.every((k) => eq(params[k], s[k]) && !!params[k + "On"] === (s[k] > 0));
  }
  function notify() {
    const s = STRAINS.find((x) => x.id === currentId);
    $("#strainEdited").hidden = !(s && !sameAs(s));
    $("#strainName").textContent = s ? s.name.toUpperCase() : "CUSTOM";
  }
  let notifyT = 0;
  window.addEventListener("hs-param", () => { if (!loading) { clearTimeout(notifyT); notifyT = setTimeout(notify, 30); } });

  let slewT = 0;
  function loadStrain(s, announce) {
    loading = true;
    engine.slew = 0.07;                       /* strain switch glides ~70 ms per stage: no zipper, no pop */
    clearTimeout(slewT); slewT = setTimeout(() => { engine.slew = 0; }, 700);
    ["time", "pitch", "wow", "out"].forEach((k) => K(k).set(s[k], { force: true }));
    Object.assign(params, s.eq8); lastPreset = null;          /* the strain's tone lives on bands 2 / 4 / 7 of the 8-band EQ */
    HSFX.FX_KEYS.forEach((k) => { K(k).set(s[k], { force: true }); setFxOn(k, s[k] > 0); });
    setEqOn(true);
    if (!bandOn(selBand)) { const a = BANDS.find((b) => bandOn(b.n)); if (a) selBand = a.n; }   /* land on a band that is actually doing something */
    syncBands(); paintPreset();
    loading = false;
    currentId = s.id;
    if (window.HSTheme && s.hex) HSTheme.set(s.hex);   /* whole UI eases to this strain's colour; knob edits afterwards keep it, Original = purple */
    $$(".strain", list).forEach((b) => { const on = +b.dataset.id === s.id; b.setAttribute("aria-selected", on); b.tabIndex = on ? 0 : -1; });
    notify();
    const np = document.getElementById("nowPlaying");
    if (announce !== false && np) np.textContent = "STRAIN · " + s.name.toUpperCase();
  }
  list.addEventListener("click", (e) => {
    const b = e.target.closest(".strain"); if (!b) return;
    loadStrain(STRAINS[+b.dataset.id]);
  });
  list.addEventListener("keydown", (e) => {
    const t = $$(".strain", list), i = t.indexOf(document.activeElement);
    if (i < 0) return;
    let n = -1;
    if (e.key === "ArrowDown") n = i + 1; else if (e.key === "ArrowUp") n = i - 1;
    else if (e.key === "Home") n = 0; else if (e.key === "End") n = t.length - 1;
    if (n >= 0) { e.preventDefault(); const x = t[Math.max(0, Math.min(t.length - 1, n))]; x.focus(); x.click(); x.focus(); }
  });
  function stepStrain(d) {
    const i = currentId === null ? (d > 0 ? 0 : STRAINS.length - 1) : (currentId + d + STRAINS.length) % STRAINS.length;
    loadStrain(STRAINS[i]);
    const b = $(`.strain[data-id="${i}"]`, list);
    if (!b) { famFilter = "ALL"; $$(".fam", tabs)[0].click(); }
    const bb = $(`.strain[data-id="${i}"]`, list);
    if (bb) bb.scrollIntoView({ block: "nearest" });
  }
  $("#strainPrev").addEventListener("click", () => stepStrain(-1));
  $("#strainNext").addEventListener("click", () => stepStrain(1));
  $("#strainName").addEventListener("click", () => { if (currentId !== null) loadStrain(STRAINS[currentId]); });  /* re-load = undo edits */
  window.HSStrains = { load: (id) => loadStrain(STRAINS[id]), get current() { return currentId; }, list: STRAINS };

  /* ── 8-band EQ: band tabs + one shared FREQ / GAIN / Q knob row bound to the selected band ── */
  const kF = K("eqF"), kG = K("eqG"), kQ = K("eqQ");
  const gp = (n, k) => params[ek(n, k)];
  const bandOn = (n) => !!params[ek(n, "on")];
  const bandCut = (n) => E.isCut(BANDS[n - 1]);
  const bandTabs = $("#bandTabs"), bandOnBtn = $("#bandOn"), slopeUnit = $("#slopeUnit"), gainUnit = $('[data-fx-knob="eqG"]'), eqRead = $("#eqRead");
  const SUBQ = { hp: "RESONANCE", lp: "RESONANCE", ls: "STEEPNESS", hs: "STEEPNESS", pk: "WIDTH" };
  const TYPE_TXT = { hp: "HIGH-PASS", lp: "LOW-PASS", ls: "LOW SHELF", hs: "HIGH SHELF", pk: "BELL" };
  let selBand = 4;
  const snapF = (v) => +v.toPrecision(3);
  const snapQ = (v) => Math.round(v * 100) / 100;
  const snapG = (v) => Math.round(v * 10) / 10;
  const parseHz = (t) => {
    const m = String(t).replace(",", ".").match(/(\d+(?:\.\d+)?)\s*(k|khz|hz)?/i); if (!m) return null;
    let v = parseFloat(m[1]); const u = (m[2] || "").toLowerCase();
    if (u === "k" || u === "khz") v *= 1000; else if (!u && v < 20) v *= 1000;
    return v;
  };
  const fmtHz = (v) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2).replace(/\.?0+$/, "") + " kHz" : (v < 100 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v))) + " Hz");
  const fmtDb = (v) => (v > 0.049 ? "+" : v < -0.049 ? "−" : "") + Math.abs(v).toFixed(1) + " dB";
  const fmtQ = (v) => "Q " + (v < 10 ? v.toFixed(2) : v.toFixed(1));
  function bandChanged() {                 /* params already written: push to audio, curve, strain/preset badges */
    applyParams();
    window.dispatchEvent(new CustomEvent("hs-param", { detail: { key: "eqBand", value: selBand } }));
  }
  function userEdit(n, k, v) {             /* any hands-on edit wakes a sleeping band, like grabbing its node */
    params[ek(n, k)] = v;
    if (!bandOn(n)) { params[ek(n, "on")] = true; paintBandUI(); }
  }
  function paintBandUI() {
    const n = selBand, b = BANDS[n - 1];
    $$(".bt", bandTabs).forEach((t) => { const i = +t.dataset.band, on = bandOn(i); t.classList.toggle("on", on); t.classList.toggle("sel", i === n); t.setAttribute("aria-selected", i === n); t.tabIndex = i === n ? 0 : -1; });
    setLed(bandOnBtn, bandOn(n));
    bandOnBtn.setAttribute("aria-label", `Band ${n} on/off`);
    $("#bandName").textContent = `BAND ${n} · ${b.name}`;
    $("#bandType").textContent = E.isCut(b) ? "· " + TYPE_TXT[b.type] + " · " + gp(n, "s") + " dB/OCT" : "· " + TYPE_TXT[b.type] + " · ±18 dB";
    $(".band-panel").classList.toggle("off", !bandOn(n));
    $$(".slope button", slopeUnit).forEach((x) => x.setAttribute("aria-checked", String(+x.dataset.s === gp(n, "s"))));
  }
  function bindKnobs() {
    const n = selBand, b = BANDS[n - 1], cut = E.isCut(b);
    kF.configure({ min: b.fmin, max: b.fmax, def: b.f, curve: "log", fmt: fmtHz, snap: snapF, stepMul: Math.pow(2, 1 / 12), parse: parseHz, edit: (v) => String(snapF(v)), hook: (v) => userEdit(selBand, "f", v), label: `Band ${n} frequency`, value: gp(n, "f"), jump: true });
    kG.configure({ min: -E.GMAX, max: E.GMAX, def: 0, curve: "lin", step: 0.5, fmt: fmtDb, snap: snapG, hook: (v) => userEdit(selBand, "g", v), label: `Band ${n} gain`, value: cut ? 0 : gp(n, "g"), jump: true });
    kQ.configure({ min: b.qmin, max: b.qmax, def: b.q, curve: "log", fmt: fmtQ, snap: snapQ, stepMul: Math.pow(2, 1 / 12), parse: (t) => parseFloat(String(t).replace(",", ".").replace(/[^\d.]/g, "")), edit: (v) => String(snapQ(v)), hook: (v) => userEdit(selBand, "q", v), label: `Band ${n} ${cut ? "resonance" : "Q"}`, value: gp(n, "q"), jump: true });
    gainUnit.hidden = cut; slopeUnit.hidden = !cut;
    $(".knob-sub", $('[data-fx-knob="eqQ"]')).textContent = SUBQ[b.type];
    $(".knob-name", $('[data-fx-knob="eqQ"]')).textContent = cut ? "RES" : "Q";
  }
  function selectBand(n, focusTab) {
    selBand = n; paintBandUI(); bindKnobs(); queueEq(); updateRead();
    if (focusTab) $(`#bt${n}`).focus();
  }
  function syncBands() { paintBandUI(); bindKnobs(); queueEq(); updateRead(); }   /* params changed from outside (strain / preset) */
  bandTabs.addEventListener("click", (e) => { const t = e.target.closest(".bt"); if (t) selectBand(+t.dataset.band); });
  bandTabs.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -99 : e.key === "End" ? 99 : 0;
    if (d) { e.preventDefault(); selectBand(d === -99 ? 1 : d === 99 ? 8 : (selBand - 1 + d + 8) % 8 + 1, true); }
  });
  bandOnBtn.addEventListener("click", () => { params[ek(selBand, "on")] = !bandOn(selBand); paintBandUI(); bandChanged(); });
  $(".slope", slopeUnit).addEventListener("click", (e) => { const x = e.target.closest("button[data-s]"); if (!x) return; userEdit(selBand, "s", +x.dataset.s); paintBandUI(); bandChanged(); });
  function updateRead() {
    const n = selBand, b = BANDS[n - 1], cut = E.isCut(b);
    eqRead.textContent = `${n} · ${fmtHz(gp(n, "f"))}${cut ? "" : " · " + fmtDb(gp(n, "g"))} · ${fmtQ(gp(n, "q"))}${bandOn(n) ? "" : " · OFF"}`;
  }
  window.addEventListener("hs-param", () => updateRead());

  /* ── presets (independent of strains) ─────────────────────────── */
  const preBtn = $("#preBtn"), preList = $("#preList");
  let lastPreset = null, preOpen = false;
  const SPARK_F = Array.from({ length: 40 }, (_, i) => 20 * Math.pow(1000, i / 39));
  function spark(p) {
    const r = E.responseDb(Object.assign({ eqOn: true }, E.presetBands(p)), SPARK_F, 48000);
    return `<svg viewBox="0 0 40 16" aria-hidden="true"><line x1="0" x2="40" y1="8" y2="8"/><path d="${r.map((db, i) => (i ? "L" : "M") + (i).toFixed(0) + " " + (8 - Math.max(-7, Math.min(7, db * 0.55))).toFixed(1)).join("")}"/></svg>`;
  }
  preList.innerHTML = E.PRESETS.map((p) => `<li role="option" id="pre-${p.id}" data-id="${p.id}" aria-selected="false" tabindex="-1"><span>${p.name}</span>${spark(p)}</li>`).join("");
  function presetState() {
    const match = E.PRESETS.find((p) => E.sameBands(params, E.presetBands(p)));
    const last = E.PRESETS.find((p) => p.id === lastPreset);
    const st = STRAINS.find((x) => x.id === currentId);
    let name, edited = false;
    if (match) name = match.name;
    else if (last) { name = last.name; edited = true; }
    else if (st && E.sameBands(params, st.eq8)) name = "Strain EQ";
    else name = "Custom";
    return { name, edited, id: match ? match.id : null };
  }
  function paintPreset() {
    const s = presetState();
    $("#preName").textContent = s.name; $("#preEdited").hidden = !s.edited;
    $$("li", preList).forEach((li) => li.setAttribute("aria-selected", String(li.dataset.id === s.id)));
  }
  function setPresetOpen(v, focus) {
    preOpen = v; preList.hidden = !v; preBtn.setAttribute("aria-expanded", String(v));
    $(".fx-mod.eq").classList.toggle("pre-open", v);
    if (v) { const li = $('li[aria-selected="true"]', preList) || $("li", preList); li.scrollIntoView({ block: "nearest" }); if (focus !== false) li.focus({ preventScroll: true }); }
    else if (focus) preBtn.focus({ preventScroll: true });
  }
  function applyPreset(p) {
    engine.slew = 0.12; clearTimeout(slewT); slewT = setTimeout(() => { engine.slew = 0; }, 900);   /* glide, no click */
    Object.assign(params, E.presetBands(p));
    lastPreset = p.id;
    if (!params.eqOn) setEqOn(true);
    syncBands(); bandChanged();
    const np = document.getElementById("nowPlaying"); if (np) np.textContent = "EQ PRESET · " + p.name.toUpperCase();
  }
  preBtn.addEventListener("click", () => setPresetOpen(!preOpen));
  preBtn.addEventListener("keydown", (e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setPresetOpen(true); } });
  preList.addEventListener("click", (e) => { const li = e.target.closest("li"); if (!li) return; applyPreset(E.PRESETS.find((p) => p.id === li.dataset.id)); setPresetOpen(false, true); });
  preList.addEventListener("keydown", (e) => {
    const t = $$("li", preList), i = t.indexOf(document.activeElement);
    let n = -1;
    if (e.key === "ArrowDown") n = i + 1; else if (e.key === "ArrowUp") n = i - 1; else if (e.key === "Home") n = 0; else if (e.key === "End") n = t.length - 1;
    if (n >= 0) { e.preventDefault(); const x = t[Math.max(0, Math.min(t.length - 1, n))]; x.focus(); x.scrollIntoView({ block: "nearest" }); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (i >= 0) t[i].click(); }
    else if (e.key === "Escape" || e.key === "Tab") { if (e.key === "Escape") e.preventDefault(); e.stopPropagation(); setPresetOpen(false, true); }
  });
  document.addEventListener("pointerdown", (e) => { if (preOpen && !e.target.closest(".pre-wrap")) setPresetOpen(false); }, true);
  window.addEventListener("hs-param", () => { clearTimeout(paintPreset.t); paintPreset.t = setTimeout(paintPreset, 30); });

  /* ── EQ curve: combined response + per-band nodes + live spectrum ── */
  const svg = $("#eqSvg"), specCv = $("#eqSpec"), eqView = $("#eqView");
  const FMIN = 20, FMAX = 20000, DBR = 18, PADY = 12, PADX = 10, NODE_R = 8.5;
  let VW = 360, VH = 150;
  const xOf = (f) => PADX + (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * (VW - 2 * PADX);
  const fOf = (x) => FMIN * Math.pow(FMAX / FMIN, Math.min(1, Math.max(0, (x - PADX) / (VW - 2 * PADX))));
  const yOf = (db) => PADY + ((DBR - db) / (2 * DBR)) * (VH - 2 * PADY);
  const dbOf = (y) => DBR - ((y - PADY) / (VH - 2 * PADY)) * 2 * DBR;
  const NP = 140, freqs = Array.from({ length: NP }, (_, i) => FMIN * Math.pow(FMAX / FMIN, i / (NP - 1)));
  svg.innerHTML = `<g id="eqGrid"></g><path id="eqArea" class="area"/><path id="eqSel" class="selc"/><path id="eqPath" class="curve"/><g id="eqNodes">${BANDS.map((b) => `<g class="node" data-band="${b.n}" role="slider" tabindex="-1"><circle class="hit" r="19"/><circle class="halo" r="${NODE_R + 6}"/><circle class="dot" r="${NODE_R}"/><text class="nl" y="3.4">${b.n}</text></g>`).join("")}</g>`;
  const nodeEls = {}; $$(".node", svg).forEach((n) => { nodeEls[+n.dataset.band] = n; });
  const shown = BANDS.map((b) => ({ f: b.f, g: 0, q: b.q, w: 0, s: b.s === 24 ? 1 : 0 }));
  function drawGrid() {
    let g = "";
    [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach((f) => { g += `<line x1="${xOf(f).toFixed(1)}" x2="${xOf(f).toFixed(1)}" y1="0" y2="${VH}" class="g"/><text x="${(xOf(f) + 2).toFixed(1)}" y="${VH - 3}" class="gt">${f >= 1000 ? f / 1000 + "k" : f}</text>`; });
    [-12, -6, 0, 6, 12].forEach((d) => { g += `<line x1="0" x2="${VW}" y1="${yOf(d).toFixed(1)}" y2="${yOf(d).toFixed(1)}" class="${d === 0 ? "g zero" : "g"}"/><text x="3" y="${(yOf(d) - 2).toFixed(1)}" class="gt">${d > 0 ? "+" + d : d}</text>`; });
    $("#eqGrid").innerHTML = g;
  }
  function fitSvg() {
    const r = eqView.getBoundingClientRect(); if (r.width < 20 || r.height < 20) return;
    VW = r.width; VH = r.height; svg.setAttribute("viewBox", `0 0 ${VW.toFixed(1)} ${VH.toFixed(1)}`);
    drawGrid(); queueEq();
  }
  const tgtOf = (n) => {                       /* what the audio is gliding to */
    const b = BANDS[n - 1], on = params.eqOn && bandOn(n), cut = E.isCut(b);
    return { f: gp(n, "f"), g: cut ? 0 : on ? gp(n, "g") : 0, q: gp(n, "q"), w: cut ? (on ? 1 : 0) : 1, s: cut && gp(n, "s") === 24 ? 1 : 0 };
  };
  let eqRaf = 0;
  const poly = (arr) => Array.from(arr, (db, i) => (i ? "L" : "M") + xOf(freqs[i]).toFixed(1) + " " + yOf(Math.max(-DBR - 4, Math.min(DBR + 4, db))).toFixed(1)).join("");
  function drawEq() {
    eqRaf = 0;
    let moving = false;
    const k = reduced.matches ? 1 : 0.3;
    const tot = new Array(NP).fill(0);
    let selArr = null;
    BANDS.forEach((b, i) => {
      const t = tgtOf(b.n), sh = shown[i];
      const lf = Math.log(sh.f), lt = Math.log(t.f), qf = Math.log(sh.q), qt = Math.log(t.q);
      if (Math.abs(lt - lf) > 0.0008) { sh.f = Math.exp(lf + (lt - lf) * k); moving = true; } else sh.f = t.f;
      if (Math.abs(qt - qf) > 0.001) { sh.q = Math.exp(qf + (qt - qf) * k); moving = true; } else sh.q = t.q;
      if (Math.abs(t.g - sh.g) > 0.004) { sh.g += (t.g - sh.g) * k; moving = true; } else sh.g = t.g;
      if (Math.abs(t.w - sh.w) > 0.004) { sh.w += (t.w - sh.w) * k; moving = true; } else sh.w = t.w;
      if (Math.abs(t.s - sh.s) > 0.004) { sh.s += (t.s - sh.s) * k; moving = true; } else sh.s = t.s;
      const act = E.isCut(b) ? sh.w > 0.002 : Math.abs(sh.g) > 0.004;
      if (act || b.n === selBand) {
        const arr = E.bandDb(b.type, sh.f, sh.g, sh.q, sh.s, 48000, freqs);
        const w = E.isCut(b) ? sh.w : 1;
        if (act) for (let j = 0; j < NP; j++) tot[j] += arr[j] * w;
        if (b.n === selBand) selArr = arr.map((v) => v * w);
      }
    });
    const d = poly(tot);
    $("#eqPath").setAttribute("d", d);
    $("#eqArea").setAttribute("d", d + `L${xOf(FMAX).toFixed(1)} ${yOf(0).toFixed(1)}L${xOf(FMIN).toFixed(1)} ${yOf(0).toFixed(1)}Z`);
    if (selArr) { const sd = poly(selArr); $("#eqSel").setAttribute("d", sd + `L${xOf(FMAX).toFixed(1)} ${yOf(0).toFixed(1)}L${xOf(FMIN).toFixed(1)} ${yOf(0).toFixed(1)}Z`); }
    BANDS.forEach((b, i) => {
      const sh = shown[i], el = nodeEls[b.n], on = bandOn(b.n) && params.eqOn;
      el.setAttribute("transform", `translate(${xOf(sh.f).toFixed(1)} ${yOf(E.isCut(b) ? 0 : sh.g).toFixed(1)})`);
      el.classList.toggle("sel", b.n === selBand); el.classList.toggle("off", !on);
      el.setAttribute("aria-label", `Band ${b.n} ${b.name.toLowerCase()}${bandOn(b.n) ? "" : " (off)"}`);
      el.setAttribute("aria-valuetext", `${fmtHz(gp(b.n, "f"))}${E.isCut(b) ? "" : ", " + fmtDb(gp(b.n, "g"))}, ${fmtQ(gp(b.n, "q"))}`);
      el.setAttribute("aria-valuenow", gp(b.n, "f")); el.setAttribute("aria-valuemin", b.fmin); el.setAttribute("aria-valuemax", b.fmax);
      el.tabIndex = b.n === selBand ? 0 : -1;
    });
    if (moving) eqRaf = requestAnimationFrame(drawEq);
  }
  function queueEq() { if (!eqRaf) eqRaf = requestAnimationFrame(drawEq); }
  window.addEventListener("hs-param", (e) => { if (/^eq/.test(e.detail.key)) queueEq(); });
  window.HSEqView = { nodePos: (n) => { const r = svg.getBoundingClientRect(), b = BANDS[n - 1], sh = shown[n - 1]; return { x: r.left + xOf(sh.f), y: r.top + yOf(E.isCut(b) ? 0 : sh.g) }; }, xy: (f, db) => { const r = svg.getBoundingClientRect(); return { x: r.left + xOf(f), y: r.top + yOf(db) }; }, get sel() { return selBand; } };

  /* drag nodes (freq / gain; alt-drag = Q), scroll or pinch = Q, arrow keys */
  const pts = new Map();
  let drag = null, pinch = null;
  const setQ = (n, q) => { const b = BANDS[n - 1]; userEdit(n, "q", snapQ(Math.min(b.qmax, Math.max(b.qmin, q)))); if (n === selBand) kQ.configure({ value: gp(n, "q") }); bandChanged(); };
  function setFG(n, f, g) {
    const b = BANDS[n - 1];
    userEdit(n, "f", snapF(Math.min(b.fmax, Math.max(b.fmin, f))));
    if (g !== null && !E.isCut(b)) userEdit(n, "g", snapG(Math.min(E.GMAX, Math.max(-E.GMAX, g))));
    if (n === selBand) { kF.configure({ value: gp(n, "f") }); if (!E.isCut(b)) kG.configure({ value: gp(n, "g") }); }
    bandChanged();
  }
  svg.addEventListener("pointerdown", (e) => {
    const g = e.target.closest(".node");
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!g) {
      if (pts.size === 2 && !drag) { const [a, b] = Array.from(pts.values()); pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, q0: gp(selBand, "q") }; }
      return;
    }
    const n = +g.dataset.band;
    if (n !== selBand) selectBand(n);
    if (!params.eqOn) setEqOn(true);
    const p = nodeEls[n].getBoundingClientRect();
    drag = { n, id: e.pointerId, ox: e.clientX - (p.left + p.width / 2), oy: e.clientY - (p.top + p.height / 2), alt: e.altKey, y0: e.clientY, q0: gp(n, "q"), moved: false };
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
    g.classList.add("drag"); e.preventDefault();
  });
  svg.addEventListener("pointermove", (e) => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) {
      const [a, b] = Array.from(pts.values());
      setQ(selBand, pinch.q0 / ((Math.hypot(a.x - b.x, a.y - b.y) || 1) / pinch.d0));      /* spread = wider (lower Q) */
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    drag.moved = true;
    if (e.altKey !== drag.alt) { drag.alt = e.altKey; drag.y0 = e.clientY; drag.q0 = gp(drag.n, "q"); }
    if (e.altKey) { setQ(drag.n, drag.q0 * Math.exp(((drag.y0 - e.clientY)) * 0.012)); return; }
    const r = svg.getBoundingClientRect();
    setFG(drag.n, fOf(e.clientX - drag.ox - r.left), dbOf(e.clientY - drag.oy - r.top));
  });
  const endPtr = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (drag && e.pointerId === drag.id) { nodeEls[drag.n].classList.remove("drag"); drag = null; }
  };
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((t) => svg.addEventListener(t, endPtr));
  svg.addEventListener("dblclick", (e) => { const g = e.target.closest(".node"); if (!g) return; const n = +g.dataset.band; params[ek(n, "on")] = !bandOn(n); paintBandUI(); bandChanged(); });
  eqView.addEventListener("wheel", (e) => {
    const g = e.target.closest(".node");
    if (!g && !e.ctrlKey && !e.altKey) return;                    /* never hijack page scroll */
    e.preventDefault();
    const n = g ? +g.dataset.band : selBand;
    if (n !== selBand) selectBand(n);
    if (!params.eqOn) setEqOn(true);
    setQ(n, gp(n, "q") * Math.exp((e.deltaY * (e.ctrlKey ? 0.012 : 0.0028)) * (e.deltaMode === 1 ? 14 : 1)));   /* scroll up / spread = wider */
  }, { passive: false });
  svg.addEventListener("keydown", (e) => {
    const g = e.target.closest(".node"); if (!g) return;
    const n = +g.dataset.band, b = BANDS[n - 1], big = e.shiftKey ? 4 : 1;
    let handled = true;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) setQ(n, gp(n, "q") * Math.pow(2, ((e.key === "ArrowUp" ? 1 : -1) * big) / 12));
    else if (e.key === "ArrowLeft") setFG(n, gp(n, "f") * Math.pow(2, -big / 12), null);
    else if (e.key === "ArrowRight") setFG(n, gp(n, "f") * Math.pow(2, big / 12), null);
    else if (e.key === "ArrowUp" && !E.isCut(b)) setFG(n, gp(n, "f"), gp(n, "g") + 0.5 * big);
    else if (e.key === "ArrowDown" && !E.isCut(b)) setFG(n, gp(n, "f"), gp(n, "g") - 0.5 * big);
    else if (e.key === "Enter" || e.key === " ") { params[ek(n, "on")] = !bandOn(n); paintBandUI(); bandChanged(); }
    else handled = false;
    if (handled) e.preventDefault();
  });
  if (window.ResizeObserver) new ResizeObserver(fitSvg).observe(eqView);
  fitSvg(); syncBands(); paintPreset();

  /* spectrum + limiter meter: only animate while the drawer is open */
  const sctx = specCv.getContext("2d");
  let spec = null, specBuf = null, loopId = 0, grShown = 0;
  const segs = $$("#grMeter i");
  function fitSpec() {
    const r = specCv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    specCv.width = Math.max(2, Math.round(r.width * dpr)); specCv.height = Math.max(2, Math.round(r.height * dpr));
  }
  function loop() {
    loopId = 0;
    if (!isOpen) return;
    /* spectrum */
    if (engine.ctx && !spec) {
      spec = engine.ctx.createAnalyser(); spec.fftSize = 2048; spec.smoothingTimeConstant = 0.82;
      (engine.master || engine.ctx.destination).connect(spec); specBuf = new Uint8Array(spec.frequencyBinCount);
    }
    const w = specCv.width, h = specCv.height;
    sctx.clearRect(0, 0, w, h);
    if (spec && engine.playing && engine.ctx.state === "running") {
      spec.getByteFrequencyData(specBuf);
      const sr = engine.ctx.sampleRate, bins = specBuf.length, B = 72;
      sctx.fillStyle = (window.HSTheme && HSTheme.cv.spec) || "rgba(168,85,247,.28)";
      for (let i = 0; i < B; i++) {
        const f0 = FMIN * Math.pow(FMAX / FMIN, i / B), f1 = FMIN * Math.pow(FMAX / FMIN, (i + 1) / B);
        const b0 = Math.max(1, Math.floor((f0 / (sr / 2)) * bins)), b1 = Math.max(b0 + 1, Math.ceil((f1 / (sr / 2)) * bins));
        let m = 0; for (let b = b0; b < b1 && b < bins; b++) if (specBuf[b] > m) m = specBuf[b];
        const bh = Math.pow(m / 255, 1.6) * h * 0.92;
        sctx.fillRect((i / B) * w + 0.5, h - bh, w / B - 1.5, bh);
      }
    }
    /* limiter gain-reduction meter */
    const gr = Math.max(0, -20 * Math.log10(Math.max(1e-4, engine.gr || 1)));
    engine.gr = Math.min(1, (engine.gr || 1) + 0.04);                       /* meter ballistics: instant attack, ~0.5 s release */
    grShown = gr > grShown ? gr : grShown * 0.9;
    const lit = Math.min(segs.length, Math.round(grShown * 1.6));
    segs.forEach((s, i) => s.classList.toggle("on", i < lit));
    $("#grRead").textContent = grShown > 0.2 ? "−" + grShown.toFixed(1) + " dB" : "−1 dBTP";
    loopId = requestAnimationFrame(loop);
  }

  /* ── open / close ─────────────────────────────────────────────── */
  const measure = () => rack.style.setProperty("--dh", drawer.offsetHeight + "px");
  function applyMode() {
    const sheet = sheetMQ.matches;
    drawer.classList.toggle("sheet", sheet);
    rack.classList.toggle("is-sheet", sheet);
    measure();
  }
  function setOpen(v, o) {
    o = o || {};
    if (v === isOpen && !o.force) return;
    isOpen = v;
    applyMode();
    drawer.style.removeProperty("--p");
    drawer.classList.remove("dragging");
    drawer.classList.toggle("open", v);
    rack.classList.toggle("fx-open", v);
    [lip, hdrBtn].forEach((b) => b && b.setAttribute("aria-expanded", String(v)));
    hdrBtn && hdrBtn.classList.toggle("on", v);
    if (v) { drawer.removeAttribute("inert"); drawer.setAttribute("aria-hidden", "false"); } else { drawer.setAttribute("inert", ""); drawer.setAttribute("aria-hidden", "true"); }
    document.documentElement.classList.toggle("fx-sheet-open", v && sheetMQ.matches);
    if (backdrop) backdrop.hidden = !(v && sheetMQ.matches);
    if (v) {
      opener = o.opener || document.activeElement;
      fitSpec(); queueEq(); if (!loopId) loopId = requestAnimationFrame(loop);
      if (o.focus) setTimeout(() => ($(".strain[aria-selected='true']", list) || $(".strain", list) || drawer).focus({ preventScroll: true }), reduced.matches ? 0 : 120);
      if (!sheetMQ.matches) [reduced.matches ? 30 : 300, reduced.matches ? 60 : 800].forEach((ms) => setTimeout(() => { if (isOpen) try { drawer.scrollIntoView({ block: "nearest", behavior: reduced.matches ? "auto" : "smooth" }); } catch (_) {} }, ms));
    } else if (o.restoreFocus !== false && opener && drawer.contains(document.activeElement)) {
      try { opener.focus({ preventScroll: true }); } catch (_) {}
    }
    window.dispatchEvent(new CustomEvent("hs-drawer", { detail: { open: v } }));
    setTimeout(() => window.dispatchEvent(new CustomEvent("hs-drawer", { detail: { open: v } })), 700);
  }
  const toggle = (e) => setOpen(!isOpen, { focus: !e || e.detail === 0, opener: e && e.currentTarget });
  hdrBtn && hdrBtn.addEventListener("click", toggle);
  $("#fxClose").addEventListener("click", () => setOpen(false, { opener: lip }));
  backdrop && backdrop.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen && !(document.activeElement && document.activeElement.classList.contains("knob-edit"))) setOpen(false);
  });

  /* drag the lip (desktop: pull the tray down) or the grip (phone: pull the sheet down) like a real drawer */
  let lipPtrAt = -1e9;
  function dragHandle(el, sheetMode) {
    let st = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.button > 0 && e.pointerType === "mouse") return;
      if ((sheetMQ.matches) !== sheetMode) return;
      measure();
      st = { y: e.clientY, p0: isOpen ? 1 : 0, p: isOpen ? 1 : 0, moved: false, last: e.clientY, lt: performance.now(), v: 0 };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!st) return;
      const dy = e.clientY - st.y;
      if (!st.moved && Math.abs(dy) < 6) return;
      if (!st.moved) { st.moved = true; applyMode(); drawer.classList.add("dragging"); drawer.removeAttribute("inert"); }
      const H = Math.max(80, drawer.offsetHeight);
      const p = Math.min(1, Math.max(0, st.p0 + (sheetMode ? -dy : dy) / H));
      const now = performance.now();
      st.v = (p - st.p) / Math.max(1, now - st.lt) * 1000 * 0.6 + st.v * 0.4;
      st.p = p; st.lt = now;
      drawer.style.setProperty("--p", p.toFixed(4));
    });
    const end = (e) => {
      if (!st) return;
      const s = st; st = null;
      if (el === lip) lipPtrAt = performance.now();
      if (!s.moved) { if (e.type === "pointerup" && el === lip) toggle({ detail: 1, currentTarget: lip }); return; }
      const target = s.p + s.v * 0.18 > 0.5;
      isOpen = !target;                       /* force a state change so classes/aria update */
      setOpen(target, { force: true });
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }
  dragHandle(lip, false);
  dragHandle($("#fxGrip"), true);
  $("#fxGrip").addEventListener("click", () => { /* tap on the grip also closes */ });
  /* click without a pointer sequence (assistive tech, voice control, el.click()) */
  lip.addEventListener("click", (e) => { if (performance.now() - lipPtrAt < 700) return; setOpen(!isOpen, { focus: e.detail === 0, opener: lip }); });
  lip.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!isOpen, { focus: true, opener: lip }); } });

  /* the lip also acts as the phone's floating "EQ·FX" tab; keep layout metrics fresh */
  if (window.ResizeObserver) new ResizeObserver(() => { measure(); if (isOpen) fitSpec(); }).observe(drawer);
  (sheetMQ.addEventListener ? sheetMQ.addEventListener.bind(sheetMQ, "change") : sheetMQ.addListener.bind(sheetMQ))(() => { applyMode(); if (isOpen) setOpen(true, { force: true }); });
  window.addEventListener("resize", () => { measure(); if (isOpen) fitSpec(); });
  applyMode();
  drawer.setAttribute("inert", ""); drawer.setAttribute("aria-hidden", "true");
  window.HSDrawer = { open: () => setOpen(true, { focus: true }), close: () => setOpen(false), toggle: () => setOpen(!isOpen), get isOpen() { return isOpen; } };
})();
