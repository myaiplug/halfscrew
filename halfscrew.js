
const ADMINS = ["myaiplug", "nodaw", "nodaw@nodawlabs.com", "bz", "bthirtthreezy", "thebeatmob", "beez"];
function role() {
  try {
    const saved = JSON.parse(localStorage.getItem("halfscrew-pass") || "{}");
    const mail = String(saved.email || "").toLowerCase();
    if (saved.admin || ADMINS.some((a) => mail.includes(a))) return "admin";
    if (saved.paid) return "unlimited";
  } catch (_) {}
  return "demo";
}
function clipDemo(buffer) {
  if (role() !== "demo") return buffer;
  const frames = Math.min(buffer.length, Math.floor(buffer.sampleRate * 20));
  const out = new AudioBuffer({ length: frames, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
  for (let c = 0; c < buffer.numberOfChannels; c++) out.getChannelData(c).set(buffer.getChannelData(c).subarray(0, frames));
  return out;
}
window.halfscrewRole = role;
window.OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
/* HALFSCREW — live knobs, real audio engine, scope */

const $ = (s, el = document) => el.querySelector(s);

/* ── surface any runtime error on the display ────────────────────── */

function showErr(err) {
  const np = document.getElementById("nowPlaying");
  if (np) np.textContent = "ERROR · " + ((err && (err.message || err)) || "unknown").toString().slice(0, 60);
}
window.addEventListener("error", (e) => showErr(e.message || e.error));
window.addEventListener("unhandledrejection", (e) => showErr(e.reason));

/* ── shared parameter state ───────────────────────────────────── */

window.params = HSFX.defaults();
window.engine = {
  ctx: null, buffer: null, trackName: "",
  chain: null, worklet: null, limiter: null, fallbackSrc: null, graph: null, fallback: false,
  master: null, analyser: null, playing: false, paused: false, startAt: 0,
  offset: 0, loopEnd: 0, wake: null,
  pos: 0, posT: 0, step: 1, sentBuffer: null, gr: 1,
};

const FMT = {
  time: (v) => `${Math.round(v)}% ${Math.round(v) === 100 ? "HALFTIME" : "SCREW"}`,
  pitch: (v) => {
    const n = Math.round(v);
    return `${n > 0 ? "+" : ""}${n} SEMITONE${Math.abs(n) === 1 ? "" : "S"}`;
  },
  pct: (v) => `${Math.round(v)}%`,
  db: (v) => `${v > 0 ? "+" : ""}${(Math.round(v * 2) / 2).toFixed(1)} dB`,
};

/* ── knobs: pointer-event drag with inertia, fine-adjust, keyboard, type-in ──
   - drag up/down (140 px = full travel); hold Shift/Ctrl/Alt, or add a second finger, for 10x fine
   - the dial and LED ring glide to the target (critically damped); audio is smoothed separately
   - double-click / double-tap resets, arrow keys / PageUp/PageDown / Home / End, tap the value to type */

const REDUCED_MOTION = window.matchMedia ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
const knobAnim = new Set();
let knobRaf = 0, knobLast = 0;
function knobPump(now) {
  const dt = Math.min(0.05, Math.max(0.001, (now - knobLast) / 1000));
  knobLast = now;
  knobAnim.forEach((k) => { if (!k.tick(dt)) knobAnim.delete(k); });
  knobRaf = knobAnim.size ? requestAnimationFrame(knobPump) : 0;
}
function knobWake(k) {
  knobAnim.add(k);
  if (!knobRaf) { knobLast = performance.now(); knobRaf = requestAnimationFrame(knobPump); }
}

window.knobSet = window.knobSet || {};
function initKnob(wrap) {
  if (wrap.__knob) return wrap.__knob;
  const min = +wrap.dataset.min;
  const max = +wrap.dataset.max;
  const step = +wrap.dataset.step || 1;
  const def = +wrap.dataset.val;
  const fmt = FMT[wrap.dataset.fmt];
  const key = wrap.dataset.knob;
  const ring = $(".led-ring", wrap);
  const dial = $(".knob-dial", wrap);
  const read = document.getElementById(`read-${key}`);
  const label = wrap.dataset.label || (wrap.closest(".knob-unit") && $(".knob-name", wrap.closest(".knob-unit")) ? $(".knob-name", wrap.closest(".knob-unit")).textContent : key);
  const q = (v) => {
    const n = Math.round((Math.min(max, Math.max(min, v)) - min) / step) * step + min;
    return +Math.min(max, Math.max(min, n)).toFixed(4);
  };

  let val = q(def), raw = val, shown = val, editing = false;
  const ids = new Set();
  let primary = null, lastY = 0, downAt = 0, downX = 0, downY = 0, moved = 0, lastTapAt = 0, lastTapX = 0, lastTapY = 0, fine = false;

  wrap.setAttribute("role", "slider");
  wrap.tabIndex = 0;
  wrap.setAttribute("aria-label", label);
  wrap.setAttribute("aria-valuemin", min);
  wrap.setAttribute("aria-valuemax", max);

  function paint(v) {
    const pct = (v - min) / (max - min);
    ring.style.setProperty("--arc", `${pct * 288}deg`);
    dial.style.transform = `rotate(${-144 + pct * 288}deg)`;
  }
  function commit() {
    params[key] = val;
    wrap.setAttribute("aria-valuenow", val);
    const txt = fmt(val);
    wrap.setAttribute("aria-valuetext", txt);
    if (read && !editing) read.textContent = txt;
    if (key === "mix") {
      const s = document.getElementById("mix");
      if (s && +s.value !== val) { s.value = val; s.style.setProperty("--fill", `${val}%`); }
      const r = document.getElementById("mix-read"); if (r) r.textContent = Math.round(val);
    }
    applyParams();
    window.dispatchEvent(new CustomEvent("hs-param", { detail: { key, value: val } }));
  }
  const api = {
    key,
    get value() { return val; },
    set(next, opts) {
      const nv = q(next);
      raw = Math.min(max, Math.max(min, next));
      const changed = nv !== val;
      val = nv;
      if (opts && opts.snap) shown = val;
      if (changed || (opts && opts.force)) commit();
      if (REDUCED_MOTION.matches) { shown = val; paint(shown); } else knobWake(api);
    },
    reset() { api.set(def); },
    tick(dt) {
      if (shown === val) return false;
      const d = val - shown;
      if (Math.abs(d) < (max - min) * 0.0004) { shown = val; paint(shown); return false; }
      shown += d * (1 - Math.exp(-dt / 0.065));
      paint(shown);
      return true;
    },
  };
  wrap.__knob = api;

  function pointerDown(e) {
    if (e.button > 0 && e.pointerType === "mouse") return;
    if (editing) return;
    ids.add(e.pointerId);
    if (ids.size === 1) {
      primary = e.pointerId; lastY = e.clientY; downAt = performance.now(); downX = e.clientX; downY = e.clientY; moved = 0;
      wrap.classList.add("dragging");
      try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
      wrap.focus({ preventScroll: true });
    } else {
      fine = true;                                   /* second finger = fine adjust */
      wrap.classList.add("fine");
    }
    e.preventDefault();
  }
  /* a second finger anywhere on screen while one finger drags this knob also means fine-adjust */
  document.addEventListener("pointerdown", (e) => {
    if (primary === null || e.pointerId === primary || e.pointerType === "mouse") return;
    fine = true; wrap.classList.add("fine");
  }, true);
  function pointerMove(e) {
    if (e.pointerId !== primary || !ids.has(primary)) return;
    const dy = lastY - e.clientY;
    lastY = e.clientY;
    moved = Math.max(moved, Math.hypot(e.clientX - downX, e.clientY - downY));
    const mod = e.shiftKey || e.ctrlKey || e.altKey || fine;
    wrap.classList.toggle("fine", mod);
    raw = Math.min(max, Math.max(min, raw + (dy / 140) * (max - min) * (mod ? 0.1 : 1)));
    const nv = q(raw);
    if (nv !== val) { val = nv; commit(); }
    if (REDUCED_MOTION.matches) { shown = val; paint(shown); } else knobWake(api);
  }
  function pointerUp(e) {
    if (!ids.has(e.pointerId)) return;
    ids.delete(e.pointerId);
    if (e.pointerId === primary) {
      const now = performance.now();
      const tap = e.type === "pointerup" && moved < 6 && now - downAt < 350;
      if (tap) {                                     /* double-tap / double-click => reset */
        if (now - lastTapAt < 330 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 32) { api.reset(); lastTapAt = 0; }
        else { lastTapAt = now; lastTapX = e.clientX; lastTapY = e.clientY; }
      }
      primary = null;
      ids.clear();
      fine = false;
      wrap.classList.remove("dragging", "fine");
      raw = val;
    }
  }
  wrap.addEventListener("pointerdown", pointerDown);
  wrap.addEventListener("pointermove", pointerMove);
  wrap.addEventListener("pointerup", pointerUp);
  wrap.addEventListener("pointercancel", pointerUp);
  wrap.addEventListener("lostpointercapture", pointerUp);
  wrap.addEventListener("keydown", (e) => {
    const big = e.shiftKey ? 10 : 1;
    let nv = null;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") nv = val + step * big;
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") nv = val - step * big;
    else if (e.key === "PageUp") nv = val + step * 10;
    else if (e.key === "PageDown") nv = val - step * 10;
    else if (e.key === "Home") nv = min;
    else if (e.key === "End") nv = max;
    else if (e.key === "Enter" && read) { e.preventDefault(); startEdit(); return; }
    else if (e.key === "Backspace" || e.key === "Delete") { api.reset(); e.preventDefault(); return; }
    if (nv !== null) { e.preventDefault(); api.set(nv); }
  });
  wrap.addEventListener("wheel", (e) => {
    if (document.activeElement !== wrap) return;       /* only when focused: never hijack page scroll */
    e.preventDefault();
    api.set(val + (e.deltaY < 0 ? 1 : -1) * step * (e.shiftKey ? 1 : 2));
  }, { passive: false });

  /* tap the value to type it in */
  function startEdit() {
    if (!read || editing) return;
    editing = true;
    const inp = document.createElement("input");
    inp.className = "knob-edit";
    inp.type = "text";
    inp.inputMode = "decimal";
    inp.value = String(val);
    inp.setAttribute("aria-label", `${label} value`);
    read.textContent = "";
    read.appendChild(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = (apply) => {
      if (done) return; done = true;
      editing = false;
      if (apply) {
        const m = String(inp.value).replace(/[−–]/g, "-").replace(",", ".").match(/-?\d+(?:\.\d+)?/);
        if (m) api.set(parseFloat(m[0]), { snap: true, force: true });
      }
      if (inp.parentNode === read) read.removeChild(inp);
      read.textContent = fmt(val);
      if (!apply || true) wrap.focus({ preventScroll: true });
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
      e.stopPropagation();
    });
    inp.addEventListener("blur", () => finish(true));
  }
  if (read) {
    read.tabIndex = 0;
    read.setAttribute("role", "button");
    read.setAttribute("aria-label", `${label}: tap to type a value`);
    read.classList.add("editable");
    read.addEventListener("click", (e) => { if (e.target === read) startEdit(); });
    read.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); startEdit(); } });
  }

  window.knobSet[key] = (next) => api.set(next, { force: true });
  paint(shown);
  commit();
  return api;
}
window.HSKnobs = { init: initKnob, initAll: (root = document) => root.querySelectorAll(".knob-wrap[data-knob]").forEach(initKnob) };
HSKnobs.initAll();

/* ── audio engine ──────────────────────────────────────────────── */

function ensureCtx() {
  if (!engine.ctx) {
    engine.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    engine.master = engine.ctx.createGain();
    engine.master.gain.value = 1;
    engine.analyser = engine.ctx.createAnalyser();
    engine.analyser.fftSize = 512;
    engine.master.connect(engine.analyser);
    engine.analyser.connect(engine.ctx.destination);
  }
  if (engine.ctx.state === "suspended" && !engine.paused) engine.ctx.resume();
  return engine.ctx;
}

function screwRate() {
  return Math.max(0.5, Math.min(2, params.time / 100));
}
/* every control change glides (AudioParam setTargetAtTime + per-sample smoothing in the worklet) */
function applyParams(tc) {
  if (!engine.chain) return;
  const ctx = engine.ctx, t = ctx.currentTime, k = tc || engine.slew || HSFX.TC;
  try {
    engine.chain.apply(params, k);
    if (engine.worklet) {
      [["rate", screwRate()], ["pitch", Math.round(params.pitch)], ["wow", params.wow / 100]].forEach(([n, v]) => {
        const p = engine.worklet.parameters.get(n);
        p.cancelScheduledValues(t);
        p.setTargetAtTime(v, t, k);
      });
    } else if (engine.fallbackSrc) {
      const s = engine.fallbackSrc;
      /* keep the position readout continuous when speed changes (no worklet reports it here) */
      engine.pos = trackPos(); engine.posT = t; engine.step = screwRate() * Math.pow(2, Math.round(params.pitch) / 12);
      s.playbackRate.cancelScheduledValues(t); s.playbackRate.setTargetAtTime(screwRate(), t, k);
      s.detune.cancelScheduledValues(t); s.detune.setTargetAtTime(Math.round(params.pitch) * 100, t, k);
    }
  } catch (_) {}
}

/* one persistent graph:  varispeed -> EQ/FX chain -> limiter -> master -> analyser -> out */
function ensureGraph() {
  if (engine.graph) return engine.graph;
  const ctx = ensureCtx();
  engine.graph = (async () => {
    engine.chain = HSFX.buildChain(ctx);
    try {
      await ctx.audioWorklet.addModule("halfscrew-dsp.js?v=3");
      await ctx.audioWorklet.addModule("halfscrew-worklet.js?v=2");
      engine.worklet = new AudioWorkletNode(ctx, "halfscrew-processor", { outputChannelCount: [2] });
      engine.limiter = new AudioWorkletNode(ctx, "halfscrew-limiter", { outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit" });
      engine.worklet.port.onmessage = (e) => {
        const d = e.data;
        if (d && d.type === "pos") { engine.pos = d.pos / engine.buffer.sampleRate; engine.step = d.step; engine.posT = d.t; }
      };
      engine.limiter.port.onmessage = (e) => { if (e.data && e.data.type === "gr") engine.gr = e.data.gain; };
      engine.worklet.connect(engine.chain.input);
      engine.chain.output.connect(engine.limiter);
      engine.limiter.connect(engine.master);
      engine.worklet.port.postMessage({ type: "hq", on: params.hq });
    } catch (err) {
      /* no AudioWorklet: plain varispeed source + compressor as safety net (no WOW in preview) */
      engine.worklet = null; engine.limiter = null; engine.fallback = true;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -3; comp.knee.value = 0; comp.ratio.value = 20; comp.attack.value = 0.002;
      engine.chain.output.connect(comp); comp.connect(engine.master);
    }
    applyParams(0.001);
    return true;
  })();
  return engine.graph;
}

function postFile(node, buffer) {
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice());
  node.port.postMessage({ type: "file", channels }, channels.map((c) => c.buffer));
}

function stopPlayback() {
  if (engine.worklet) {
    try { engine.worklet.port.postMessage({ type: "stop" }); } catch (_) {}
  }
  if (engine.fallbackSrc) {
    const s = engine.fallbackSrc; engine.fallbackSrc = null;
    try { s.stop(engine.ctx.currentTime + 0.02); } catch (_) {}
  }
  engine.playing = false;
  engine.playTok = (engine.playTok || 0) + 1;
}

async function startPlayback(offset = 0) {
  const ctx = ensureCtx();
  if (!engine.buffer) return;
  engine.loopEnd = engine.buffer.__loopEnd || engine.buffer.duration;
  offset = Math.max(0, Math.min(offset, engine.loopEnd - 0.01));
  engine.pos = offset; engine.posT = ctx.currentTime; engine.step = screwRate();
  engine.startAt = ctx.currentTime;
  engine.offset = offset;
  engine.playing = true;
  const tok = engine.playTok = (engine.playTok || 0) + 1;
  engine.step = screwRate() * (engine.fallback ? Math.pow(2, Math.round(params.pitch) / 12) : 1);
  await ensureGraph();
  if (!engine.buffer || tok !== engine.playTok || !engine.playing) return;   /* stopped / restarted while the graph was loading */
  if (engine.worklet) {
    if (engine.sentBuffer !== engine.buffer) { postFile(engine.worklet, engine.buffer); engine.sentBuffer = engine.buffer; }
    engine.worklet.port.postMessage({ type: "seek", pos: Math.floor(offset * engine.buffer.sampleRate) });
    engine.worklet.port.postMessage({ type: "play" });
  } else {
    if (engine.fallbackSrc) { try { engine.fallbackSrc.stop(); } catch (_) {} }
    const s = ctx.createBufferSource();
    s.buffer = engine.buffer; s.loop = true; s.loopStart = 0; s.loopEnd = engine.loopEnd;
    s.connect(engine.chain.input);
    s.playbackRate.value = screwRate();
    s.detune.value = Math.round(params.pitch) * 100;
    s.start(ctx.currentTime + 0.02, offset);
    engine.fallbackSrc = s;
  }
  engine.posT = ctx.currentTime;
  if (window.parent !== window) parent.postMessage({ type: "halfscrew-play" }, "*");
  try { new BroadcastChannel("nodaw-transport").postMessage({ type: "play", who: "halfscrew" }); } catch (_) {}
}

function nowPlayingText() {
  if (engine.playing && $("#nowPlaying").textContent.indexOf("NOW PLAYING") < 0)
    $("#nowPlaying").textContent = `NOW PLAYING · ${engine.trackName}`;
}

function armWake() {
  if (!engine.ctx || engine.ctx.state !== "suspended") return;
  if (engine.wake) document.removeEventListener("pointerdown", engine.wake);
  engine.wake = () => {
    document.removeEventListener("pointerdown", engine.wake);
    engine.wake = null;
    if (engine.ctx && engine.ctx.state === "suspended") {
      engine.ctx.resume().then(() => { if (engine.ctx.state === "running") nowPlayingText(); });
    }
  };
  document.addEventListener("pointerdown", engine.wake);
}

function setTrack(buffer, name) {
  engine.buffer = buffer;
  engine.trackName = name;
  engine.paused = false;
  peaks = null;
  $("#nowPlaying").textContent = `NOW PLAYING · ${name}`;
  document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  startPlayback();
  playBtn.innerHTML = engine.playing ? ICON_PAUSE : ICON_PLAY;
  armWake();
  setTimeout(() => {
    if (!engine.playing) return;
    if (engine.ctx.state === "running") nowPlayingText();
    else $("#nowPlaying").textContent = "AUDIO ON HOLD · TAP THE PANEL TO START";
  }, 600);
}

/* ── user's own song ────────────────────────────────────────────── */

async function loadUserFile(file) {
  const ctx = ensureCtx();
  $("#nowPlaying").textContent = `DECODING · ${file.name.replace(/\.[^.]+$/, "").toUpperCase().slice(0, 20)}…`;
  const data = await file.arrayBuffer();
  try {
    const buf = await ctx.decodeAudioData(data);
    setTrack(buf, file.name.replace(/\.[^.]+$/, "").toUpperCase().slice(0, 28));
    $("#loadChip").classList.add("active");
    armWake();
  } catch (_) {
    $("#nowPlaying").textContent = "COULDN'T DECODE THAT FILE · TRY MP3 / WAV / M4A";
  }
}

$("#fileInput").addEventListener("change", (e) => {
  if (e.target.files[0]) loadUserFile(e.target.files[0]);
  e.target.value = "";
});

const scopeEl = $(".scope");
["dragenter", "dragover"].forEach((ev) =>
  scopeEl.addEventListener(ev, (e) => { e.preventDefault(); scopeEl.classList.add("drop-hover"); }));
["dragleave", "drop"].forEach((ev) =>
  scopeEl.addEventListener(ev, (e) => { e.preventDefault(); scopeEl.classList.remove("drop-hover"); }));
scopeEl.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadUserFile(f);
});

/* ── scrub: tap the wave to jump, drag to scan ───────────────────── */

function seekAt(clientX) {
  if (!engine.buffer) return;
  const r = scopeEl.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  const wasPlaying = engine.playing;
  startPlayback(f * (engine.buffer.__loopEnd || engine.buffer.duration));
  if (!wasPlaying) playBtn.innerHTML = engine.playing ? ICON_PAUSE : ICON_PLAY;
}

let scrubbing = false, lastScrub = 0;
scopeEl.addEventListener("pointerdown", (e) => {
  if (!engine.buffer) return;
  scrubbing = true;
  try { scopeEl.setPointerCapture(e.pointerId); } catch (_) {}
  seekAt(e.clientX);
  scrubHint();
});
scopeEl.addEventListener("pointermove", (e) => {
  if (!scrubbing) return;
  const now = performance.now();
  if (now - lastScrub < 90) return;
  lastScrub = now;
  seekAt(e.clientX);
  scrubHint();
});
["pointerup", "pointercancel"].forEach((ev) =>
  scopeEl.addEventListener(ev, (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    seekAt(e.clientX);
    nowPlayingText();
  }));

function scrubHint() {
  if (engine.buffer)
    $("#nowPlaying").textContent = `SCAN · ${fmtTime(trackPos())} / ${fmtTime(engine.loopEnd || engine.buffer.duration)}`;
}

/* ── EXPORT — render the slowed version to a WAV ───────────────── */

function encodeWav(buffer) {
  const ch = buffer.numberOfChannels, sr = buffer.sampleRate, len = buffer.length;
  const out = new ArrayBuffer(44 + len * ch * 2);
  const v = new DataView(out);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF"); v.setUint32(4, 36 + len * ch * 2, true); wstr(8, "WAVE");
  wstr(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, ch, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true); wstr(36, "data"); v.setUint32(40, len * ch * 2, true);
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      let x = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([out], { type: "audio/wav" });
}

function resample(src, ratio, wow = 0, hq = false) {
  const outLen = Math.max(1, Math.ceil(src.length / ratio));
  const out = new AudioBuffer({ length: outLen, numberOfChannels: src.numberOfChannels, sampleRate: src.sampleRate });
  for (let c = 0; c < src.numberOfChannels; c++) {
    const a = src.getChannelData(c);
    const b = out.getChannelData(c);
    let pos = 0;
    for (let i = 0; i < outLen; i++) {
      const wobble = Math.sin((i / src.sampleRate) * 2 * Math.PI * 0.35) * wow * 0.45;
      const x = pos; pos += ratio * Math.pow(2, wobble / 12);
      const i0 = Math.floor(x);
      const f = x - i0;
      if (hq) {            /* HQ: 4-point Hermite, same interpolator as the live engine */
        const n = a.length;
        const g = (k) => (k >= 0 && k < n ? a[k] : 0);
        b[i] = HSDSP.hermite(g(i0 - 1), g(i0), g(i0 + 1), g(i0 + 2), f);
      } else {
        const i1 = Math.min(a.length - 1, i0 + 1);
        b[i] = (a[i0] || 0) * (1 - f) + (a[i1] || 0) * f;
      }
    }
  }
  return out;
}
$("#exportBtn").addEventListener("click", async function () {
  this.classList.remove("flash"); void this.offsetWidth; this.classList.add("flash");
  if (!engine.buffer) {
    $("#nowPlaying").textContent = "LOAD A TRACK FIRST · THEN EXPORT THE SCREWED WAV";
    return;
  }
  $("#nowPlaying").textContent = "RENDERING SCREWED WAV…";
  const rate = Math.max(0.5, Math.min(2, params.time / 100));
  const cents = Math.round(params.pitch) * 100;
  const src = engine.buffer;
  const ratio = rate * Math.pow(2, cents / 1200);
  const snap = Object.assign({}, params);              /* the export is the settings at the click */
  let rendered = resample(src, ratio, snap.wow / 100, snap.hq);
  const fxOn = HSFX.needsChain(snap);
  if (fxOn) {
    /* EQ + FX + dry/wet: the SAME graph the preview uses, rendered offline */
    try { rendered = await HSFX.renderOffline(rendered, snap); }
    catch (err) { $("#nowPlaying").textContent = "EXPORT FAILED · " + ((err && err.message) || err); return; }
  }
  /* safe output stage: -1 dBTP look-ahead limiter (identical to the preview's), then the demo cap */
  const limited = HSFX.limitBuffer(rendered);
  rendered = limited.buffer;
  const clipped = clipDemo(rendered);
  const blob = encodeWav(clipped);
  const base = (engine.trackName || "track").split(" ·")[0].replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "track";
  const name = base + "-HalfScrew-t" + Math.round(params.time) + "-p" + Math.round(params.pitch) + "-w" + Math.round(params.wow) + "-mix" + Math.round(params.mix) + (fxOn ? "-fx" : "") + ".wav";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  const who = role();
  $("#nowPlaying").textContent = who === "demo" ? "DEMO EXPORT · 20s · " + name : "EXPORTED · " + name;
});
function reportFrame() {
  if (window.parent === window) return;
  const box = document.querySelector(".plugin");
  if (!box) return;
  const dr = document.getElementById("fxDrawer");
  const extra = dr && dr.classList.contains("open") && !dr.classList.contains("sheet") ? dr.offsetHeight * 0.92 : 0;
  parent.postMessage({ type: "halfscrew-h", h: Math.ceil(box.getBoundingClientRect().height + 16 + extra) }, "*");
}
window.addEventListener("load", reportFrame);
window.addEventListener("resize", reportFrame);
window.addEventListener("hs-drawer", reportFrame);
setTimeout(reportFrame, 400);

/* ── waveform scope ────────────────────────────────────────────── */

const canvas = $("#scope");
const ctx = canvas.getContext("2d");
let W = 0, H = 0;
let peaks = null;

function fit() {
  W = canvas.width = canvas.clientWidth || 600;
  H = canvas.height = canvas.clientHeight || 104;
  peaks = null;
}
fit();
addEventListener("resize", fit);

function computePeaks(buffer, cols) {
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  const per = Math.floor(ch0.length / cols) || 1;
  const out = new Float32Array(cols);
  for (let i = 0; i < cols; i++) {
    let m = 0;
    const s = i * per;
    for (let j = 0; j < per; j += Math.max(1, per >> 8)) {
      const x = Math.max(Math.abs(ch0[s + j] || 0), Math.abs(ch1[s + j] || 0));
      if (x > m) m = x;
    }
    out[i] = m;
  }
  const top = Math.max(...out) || 1;
  for (let i = 0; i < cols; i++) out[i] = Math.pow(out[i] / top, 0.75);
  return out;
}

function synthWave(seed, x, density) {
  const tt = x * 0.02 + seed;
  const a =
    Math.sin(tt) * 0.35 + Math.sin(tt * 2.3 + 1.7) * 0.25 +
    Math.sin(tt * 4.7 + 0.4) * 0.18 + Math.sin(tt * 9.1 + 2.2) * 0.09;
  const env = Math.pow(Math.max(0, Math.sin(x / W * Math.PI)), 0.35) * (0.75 + density * 0.45);
  return Math.abs(a) * env;
}

let offset = 0;
let powered = true;

function trackPos() {
  if (!engine.playing || !engine.buffer || !engine.loopEnd) return 0;
  /* position is reported by the audio thread (exact, follows TIME/WOW changes) and
     extrapolated at the current speed between reports: no jump when TIME moves */
  const dt = Math.max(0, engine.ctx.currentTime - engine.posT);
  return Math.max(0, (engine.pos + dt * engine.step) % engine.loopEnd);
}

function fmtTime(t) {
  const m = Math.floor(t / 60);
  const sec = Math.floor(t % 60);
  return `${m}:${sec < 10 ? "0" : ""}${sec}`;
}

function drawScope() {
  ctx.clearRect(0, 0, W, H);
  const midY = H / 2 - 4;

  // grid
  ctx.strokeStyle = "rgba(124, 58, 237, 0.12)";
  ctx.lineWidth = 1;
  for (let gx = 20; gx < W; gx += 56) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
  for (let gy = 12; gy < H; gy += 22) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }
  ctx.strokeStyle = "rgba(190, 185, 205, 0.18)";
  ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(W, midY); ctx.stroke();

  if (engine.buffer) {
    if (!peaks) peaks = computePeaks(engine.buffer, Math.floor(W / 3));
    const cols = peaks.length;
    const frac = engine.loopEnd ? trackPos() / engine.loopEnd : 0;
    const lit = Math.floor(frac * cols);
    for (let i = 0; i < cols; i++) {
      const h = peaks[i] * H * 0.78;
      const x = i * 3;
      if (i <= lit) {
        const g = ctx.createLinearGradient(0, midY - h / 2, 0, midY + h / 2);
        g.addColorStop(0, "rgba(238, 224, 255, 0.98)");
        g.addColorStop(0.5, "rgba(178, 108, 255, 0.92)");
        g.addColorStop(1, "rgba(238, 224, 255, 0.98)");
        ctx.fillStyle = g;
        ctx.shadowColor = "rgba(168, 85, 247, 0.85)";
        ctx.shadowBlur = 9;
        const bw = window.scopeBars ? 2.6 : 1.7;
    ctx.fillRect(x, midY - h / 2, bw, h);
        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(178, 108, 255, 0.12)";
        ctx.fillRect(x, midY + 4, 1.7, h * 0.3);
      } else {
        ctx.fillStyle = "rgba(178, 108, 255, 0.35)";
        const bw = window.scopeBars ? 2.6 : 1.7;
    ctx.fillRect(x, midY - h / 2, bw, h);
        ctx.fillStyle = "rgba(178, 108, 255, 0.07)";
        ctx.fillRect(x, midY + 4, 1.7, h * 0.3);
      }
    }
  } else {
    // idle sweep — full width, colored
    for (let x = 0; x < W; x += 3) {
      const h = synthWave(0, x + offset, 0.8) * H * 0.55;
      if (!(h > 0.4)) continue;
      const g = ctx.createLinearGradient(0, midY - h / 2, 0, midY + h / 2);
      g.addColorStop(0, "rgba(238, 224, 255, 0.98)");
      g.addColorStop(0.5, "rgba(178, 108, 255, 0.92)");
      g.addColorStop(1, "rgba(238, 224, 255, 0.98)");
      ctx.fillStyle = g;
      ctx.shadowColor = "rgba(168, 85, 247, 0.85)";
      ctx.shadowBlur = 9;
      const bw = window.scopeBars ? 2.6 : 1.7;
    ctx.fillRect(x, midY - h / 2, bw, h);
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(178, 108, 255, 0.12)";
      ctx.fillRect(x, midY + 4, 1.7, h * 0.3);
    }
  }

  if (powered && !engine.playing) offset += 2.2;
  requestAnimationFrame(drawScope);
}
drawScope();

/* playhead — real progress when playing, idle sweep otherwise */
const playhead = $("#playhead");
let px = 0;
(function tick() {
  if (engine.playing && engine.buffer && engine.loopEnd) {
    px = (trackPos() / engine.loopEnd) * W;
  } else if (!engine.playing) {
    px = (px + 2.4) % (W + 60);
  }
  playhead.style.left = `${px}px`;
  requestAnimationFrame(tick);
})();


/* ── play/pause ─────────────────────────────────────────────────── */

const playBtn = document.querySelector('.tool[title="Play preview"]');
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M7 5v14l12-7z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>';

playBtn.addEventListener("click", () => {
  if (!engine.ctx || !engine.buffer) {
    $("#nowPlaying").textContent = "PICK A TRACK FIRST · FROSTBITE, LATE NIGHT, OR LOAD YOUR OWN";
    return;
  }
  if (engine.playing && engine.ctx.state === "running" && !engine.paused) {
    engine.paused = true;
    const c = engine.ctx;                          /* 15 ms fade-out, then suspend: no click on pause */
    engine.master.gain.cancelScheduledValues(c.currentTime);
    engine.master.gain.setTargetAtTime(0, c.currentTime, 0.008);
    setTimeout(() => { if (engine.paused) c.suspend(); }, 70);
    playBtn.innerHTML = ICON_PLAY;
    $("#nowPlaying").textContent = `PAUSED · ${engine.trackName}`;
  } else if (engine.ctx.state === "suspended") {
    engine.paused = false;
    engine.ctx.resume().then(() => {
      const c = engine.ctx;
      engine.master.gain.cancelScheduledValues(c.currentTime);
      engine.master.gain.setTargetAtTime(1, c.currentTime, 0.008);
    });
    playBtn.innerHTML = ICON_PAUSE;
    $("#nowPlaying").textContent = `NOW PLAYING · ${engine.trackName}`;
  } else if (!engine.playing) {
    startPlayback();
    playBtn.innerHTML = ICON_PAUSE;
  }
  armWake();
});

/* ── power ─────────────────────────────────────────────────────── */

$("#powerBtn").addEventListener("click", function () {
  powered = !powered;
  this.classList.toggle("on", powered);
  if (!powered) playBtn.innerHTML = ICON_PLAY;
  else if (engine.playing) playBtn.innerHTML = ICON_PAUSE;
  document.getElementById("plugin").style.filter = powered ? "" : "saturate(0.35) brightness(0.65)";
  if (!powered && engine.playing) {
    stopPlayback();
    $("#nowPlaying").textContent = "STANDBY · HIT POWER TO RESUME";
  } else if (powered && engine.buffer) {
    startPlayback();
  }
});

/* ── dry/wet ───────────────────────────────────────────────────── */

/* HQ = 4-point Hermite interpolation (preview + export). Off = plain linear. */
const hqSw = $("#sw-hq");
if (hqSw) {
  params.hq = hqSw.checked;
  hqSw.addEventListener("change", () => {
    params.hq = hqSw.checked;
    if (engine.worklet) engine.worklet.port.postMessage({ type: "hq", on: params.hq });
    $("#nowPlaying").textContent = params.hq ? "HQ · HERMITE RESAMPLING (PREVIEW + EXPORT)" : "HQ OFF · LINEAR RESAMPLING";
  });
}

const mix = $("#mix");
const mixRead = $("#mix-read");
function renderMix() {
  mixRead.textContent = mix.value;
  mix.style.setProperty("--fill", `${mix.value}%`);
  if (window.knobSet && knobSet.mix) { knobSet.mix(+mix.value); return; }   /* drawer knob owns the value */
  params.mix = +mix.value;
  applyParams();
}
mix.addEventListener("input", renderMix);
renderMix();

window.addEventListener("message", (e) => {
  if (!e.data || e.data.type !== "halfscrew-stop") return;
  if (engine.playing) stopPlayback();
  const btn = document.getElementById("playBtn");
  if (btn) btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 5v14l12-7z" fill="currentColor"/></svg>';
});

try {
  new BroadcastChannel("nodaw-transport").onmessage = (e) => {
    if (!e.data || e.data.who === "halfscrew") return;
    if (e.data.type === "play" && engine.playing) stopPlayback();
  };
} catch (_) {}

const PRESETS = [
  { name: "STRAIGHT", time: 100, pitch: 0, wow: 0 },
  { name: "POTION", time: 100, pitch: -2, wow: 40 },
  { name: "DEEP", time: 70, pitch: -4, wow: 60 },
];
let presetIx = 0;
$("#waveBtn").addEventListener("click", () => {
  window.scopeBars = !window.scopeBars;
  $("#waveBtn").classList.toggle("on", window.scopeBars);
  $("#nowPlaying").textContent = window.scopeBars ? "SCOPE · BARS" : "SCOPE · WAVE";
});
$("#gearBtn").addEventListener("click", () => {
  presetIx = (presetIx + 1) % PRESETS.length;
  const p = PRESETS[presetIx];
  if (window.knobSet) {
    window.knobSet.time && window.knobSet.time(p.time);
    window.knobSet.pitch && window.knobSet.pitch(p.pitch);
    window.knobSet.wow && window.knobSet.wow(p.wow);
  }
  $("#gearBtn").classList.add("on");
  $("#nowPlaying").textContent = "PRESET · " + p.name;
});
