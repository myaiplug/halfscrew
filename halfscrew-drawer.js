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
        <section class="fx-mod strains" style="--i:0" aria-label="Strains">
          <h3 class="mod-h"><i></i>STRAINS<span class="mod-sub">ONE-CLICK TIME · PITCH · WOW · EQ · FX</span></h3>
          <div class="fam-tabs" role="tablist" aria-label="Strain family" id="famTabs"></div>
          <div class="strain-list" id="strainList" role="listbox" aria-label="Strains" aria-orientation="vertical"></div>
        </section>
        <section class="fx-mod eq" style="--i:1" aria-label="Equalizer">
          <h3 class="mod-h"><i></i>3-BAND EQ<span class="mod-sub">±12 dB</span>
            <button type="button" class="led-btn" id="eqOn" role="switch" aria-checked="true" aria-label="EQ on/off"><i></i></button></h3>
          <div class="eq-view" id="eqView">
            <canvas id="eqSpec" aria-hidden="true"></canvas>
            <svg id="eqSvg" viewBox="0 0 360 150" preserveAspectRatio="none" aria-hidden="true"></svg>
          </div>
          <div class="knob-row three">
            ${knob({ key: "eqLow", name: "LOW", sub: "SHELF 400 Hz", min: -12, max: 12, val: 0, step: 0.5, fmt: "db", label: "Low shelf gain" })}
            ${knob({ key: "eqMid", name: "MID", sub: "PEAK 1 kHz", min: -12, max: 12, val: 0, step: 0.5, fmt: "db", label: "Mid peak gain" })}
            ${knob({ key: "eqHigh", name: "HIGH", sub: "SHELF 2.5 kHz", min: -12, max: 12, val: 0, step: 0.5, fmt: "db", label: "High shelf gain" })}
          </div>
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
      eq(params.eqLow, s.eqLow) && eq(params.eqMid, s.eqMid) && eq(params.eqHigh, s.eqHigh) && eq(params.out, s.out) &&
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
    ["time", "pitch", "wow", "eqLow", "eqMid", "eqHigh", "out"].forEach((k) => K(k).set(s[k], { force: true }));
    HSFX.FX_KEYS.forEach((k) => { K(k).set(s[k], { force: true }); setFxOn(k, s[k] > 0); });
    setEqOn(true);
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

  /* ── EQ curve (response + draggable nodes + live spectrum) ────── */
  const svg = $("#eqSvg"), specCv = $("#eqSpec"), eqView = $("#eqView");
  const VW = 360, VH = 150, FMIN = 20, FMAX = 20000, DBR = 12, PAD = 14;
  const xOf = (f) => (Math.log10(f / FMIN) / Math.log10(FMAX / FMIN)) * VW;
  const yOf = (db) => VH / 2 - (db / DBR) * (VH / 2 - PAD);
  const dbOf = (y) => ((VH / 2 - y) / (VH / 2 - PAD)) * DBR;
  const NP = 96, freqs = Array.from({ length: NP }, (_, i) => FMIN * Math.pow(FMAX / FMIN, i / (NP - 1)));
  let grid = "";
  [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach((f) => {
    grid += `<line x1="${xOf(f)}" x2="${xOf(f)}" y1="0" y2="${VH}" class="g"/><text x="${xOf(f) + 2}" y="${VH - 3}" class="gt">${f >= 1000 ? f / 1000 + "k" : f}</text>`;
  });
  [-12, -6, 0, 6, 12].forEach((d) => { grid += `<line x1="0" x2="${VW}" y1="${yOf(d)}" y2="${yOf(d)}" class="${d === 0 ? "g zero" : "g"}"/>`; });
  svg.innerHTML = `<defs><linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9a7ff" stop-opacity=".45"/><stop offset="1" stop-color="#7c3aed" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path id="eqArea" class="area"/><path id="eqPath" class="curve"/>
    ${[["eqLow", 400, "L"], ["eqMid", 1000, "M"], ["eqHigh", 2500, "H"]].map(([k, f, l]) => `<g class="node" data-key="${k}" tabindex="-1"><circle class="halo" r="13"/><circle class="dot" r="6"/><text class="nl" y="-12">${l}</text></g>`).join("")}`;
  const shown = { eqLow: 0, eqMid: 0, eqHigh: 0 };
  const nodeEls = {}; $$(".node", svg).forEach((n) => { nodeEls[n.dataset.key] = n; });
  const NODEF = { eqLow: 400, eqMid: 1000, eqHigh: 2500 };
  let eqDirty = true, eqRaf = 0;
  function drawEq() {
    eqRaf = 0;
    let moving = false;
    for (const k in shown) {
      const target = params.eqOn ? params[k] : 0;
      const d = target - shown[k];
      if (Math.abs(d) > 0.005) { shown[k] += d * (reduced.matches ? 1 : 0.28); moving = true; } else shown[k] = target;
    }
    const resp = HSFX.eqResponseDb({ eqOn: true, eqLow: shown.eqLow, eqMid: shown.eqMid, eqHigh: shown.eqHigh }, freqs, 48000);
    let d = "";
    resp.forEach((db, i) => { d += (i ? "L" : "M") + xOf(freqs[i]).toFixed(1) + " " + yOf(db).toFixed(1); });
    $("#eqPath").setAttribute("d", d);
    $("#eqArea").setAttribute("d", d + `L${VW} ${yOf(0)}L0 ${yOf(0)}Z`);
    for (const k in nodeEls) nodeEls[k].setAttribute("transform", `translate(${xOf(NODEF[k]).toFixed(1)} ${yOf(shown[k]).toFixed(1)})`);
    if (moving) eqRaf = requestAnimationFrame(drawEq);
  }
  function queueEq() { if (!eqRaf) eqRaf = requestAnimationFrame(drawEq); }
  window.addEventListener("hs-param", (e) => { if (/^eq/.test(e.detail.key)) queueEq(); });
  queueEq();
  /* drag the nodes directly */
  let dragNode = null;
  svg.addEventListener("pointerdown", (e) => {
    const g = e.target.closest(".node"); if (!g) return;
    dragNode = g.dataset.key; svg.setPointerCapture(e.pointerId); g.classList.add("drag"); e.preventDefault();
    if (!params.eqOn) setEqOn(true);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!dragNode) return;
    const r = svg.getBoundingClientRect();
    const y = ((e.clientY - r.top) / r.height) * VH;
    const snap = e.shiftKey ? 0.1 : 0.5;
    K(dragNode).set(Math.round(dbOf(y) / snap) * snap);
  });
  ["pointerup", "pointercancel"].forEach((t) => svg.addEventListener(t, () => { if (dragNode) nodeEls[dragNode].classList.remove("drag"); dragNode = null; }));
  svg.addEventListener("dblclick", (e) => { const g = e.target.closest(".node"); if (g) K(g.dataset.key).reset(); });

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
