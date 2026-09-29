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

const params = { time: 100, pitch: 0, lookahead: 5, mix: 100 };
const engine = {
  ctx: null, buffer: null, trackName: "",
  dry: null, wet: null, dryGain: null, wetGain: null,
  master: null, analyser: null, playing: false, paused: false, startAt: 0,
  offset: 0, loopEnd: 0, wake: null,
};


const FMT = {
  time: (v) => `${Math.round(v)}% ${Math.round(v) === 100 ? "HALFTIME" : "SCREW"}`,
  pitch: (v) => {
    const n = Math.round(v);
    return `${n > 0 ? "+" : ""}${n} SEMITONE${Math.abs(n) === 1 ? "" : "S"}`;
  },
  ms: (v) => `${Math.round(v)} MS`,
};

document.querySelectorAll(".knob-wrap").forEach((wrap) => {
  const min = +wrap.dataset.min;
  const max = +wrap.dataset.max;
  const fmt = FMT[wrap.dataset.fmt];
  const key = wrap.dataset.knob;
  const ring = $(".led-ring", wrap);
  const dial = $(".knob-dial", wrap);
  const read = $(`#read-${key}`);

  let val = +wrap.dataset.val;
  let startY = 0, prevVal = 0, active = false;

  function render() {
    const pct = (val - min) / (max - min);
    ring.style.setProperty("--arc", `${pct * 288}deg`);
    dial.style.transform = `rotate(${-144 + pct * 288}deg)`;
    if (read) read.textContent = fmt(val);
    params[key] = val;
    applyParams();
  }

  wrap.addEventListener("pointerdown", (e) => {
    active = true;
    startY = e.clientY;
    prevVal = val;
    wrap.classList.add("dragging");
    try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
  });
  wrap.addEventListener("pointermove", (e) => {
    if (!active) return;
    const delta = (startY - e.clientY) / 140;
    val = Math.min(max, Math.max(min, prevVal + delta * (max - min)));
    render();
  });
  wrap.addEventListener("pointerup", () => {
    active = false;
    wrap.classList.remove("dragging");
  });
  wrap.addEventListener("dblclick", () => {
    val = +wrap.dataset.val;
    render();
  });

  render();
});

/* ── audio engine ──────────────────────────────────────────────── */

function ensureCtx() {
  if (!engine.ctx) {
    engine.ctx = new (window.AudioContext || window.webkitAudioContext)();
    engine.master = engine.ctx.createGain();
    engine.master.gain.value = 0.9;
    engine.analyser = engine.ctx.createAnalyser();
    engine.analyser.fftSize = 512;
    engine.master.connect(engine.analyser);
    engine.analyser.connect(engine.ctx.destination);
  }
  if (engine.ctx.state === "suspended") engine.ctx.resume();
  return engine.ctx;
}

function applyParams() {
  if (!engine.playing) return;
  const rate = params.time / 100;
  const cents = Math.round(params.pitch) * 100;
  try {
    engine.wet.playbackRate.setTargetAtTime(rate, engine.ctx.currentTime, 0.05);
    engine.wet.detune.setTargetAtTime(cents, engine.ctx.currentTime, 0.05);
    const w = params.mix / 100;
    engine.wetGain.gain.setTargetAtTime(w, engine.ctx.currentTime, 0.05);
    engine.dryGain.gain.setTargetAtTime(1 - w, engine.ctx.currentTime, 0.05);
  } catch (_) {}
}

function stopPlayback() {
  [engine.dry, engine.wet].forEach((src) => {
    try { src && src.stop(); } catch (_) {}
  });
  engine.dry = engine.wet = null;
  engine.playing = false;
}

function startPlayback(offset = 0) {
  const ctx = ensureCtx();
  stopPlayback();
  if (!engine.buffer) return;

  engine.loopEnd = engine.buffer.__loopEnd || engine.buffer.duration;
  offset = Math.max(0, Math.min(offset, engine.loopEnd - 0.01));

  engine.dry = ctx.createBufferSource();
  engine.wet = ctx.createBufferSource();
  engine.dry.buffer = engine.buffer;
  engine.wet.buffer = engine.buffer;
  engine.dry.loop = engine.wet.loop = true;
  engine.dry.loopStart = engine.wet.loopStart = 0;
  engine.dry.loopEnd = engine.wet.loopEnd = engine.loopEnd;

  engine.dryGain = ctx.createGain();
  engine.wetGain = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;

  engine.dry.connect(engine.dryGain).connect(engine.master);
  engine.wet.connect(engine.wetGain).connect(comp).connect(engine.master);

  engine.wet.playbackRate.value = params.time / 100;
  engine.wet.detune.value = Math.round(params.pitch) * 100;
  const w = params.mix / 100;
  engine.wetGain.gain.value = w;
  engine.dryGain.gain.value = 1 - w;

  const t = ctx.currentTime + 0.05;
  engine.dry.start(t, offset);
  engine.wet.start(t, offset);
  engine.startAt = t;
  engine.offset = offset;
  engine.playing = true;
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

/* ── demo beats — synthesized in-browser, Prod. TheBeatMob ──────── */

const DEMO_CACHE = {};

const DEMOS = {
  frostbite: { name: "FROSTBITE", bpm: 140, root: 43.65, kind: "dark" },
  latenight: { name: "LATE NIGHT", bpm: 142, root: 49.0, kind: "drill" },
};

const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;

function renderDemo(spec) {
  const sr = 44100;
  const stepDur = 60 / spec.bpm / 4;
  const REPS = 4; // 16 bars ≈ 28 s — a real track, not a clip
  const steps = 64 * REPS;
  const dur = steps * stepDur + 0.6;
  const off = new OAC(2, Math.ceil(dur * sr), sr);

  const master = off.createGain();
  master.gain.value = 0.85;
  const comp = off.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.ratio.value = 5;
  master.connect(comp).connect(off.destination);

  // shared noise
  const noiseBuf = off.createBuffer(1, sr, sr);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  const t = (step) => step * stepDur;
  const F = spec.root;
  const minor = [1, F * Math.pow(2, 3 / 12), F * 2]; // i - III - V

  function kick(step) {
    const o = off.createOscillator(), g = off.createGain();
    o.frequency.setValueAtTime(150, t(step));
    o.frequency.exponentialRampToValueAtTime(42, t(step) + 0.09);
    g.gain.setValueAtTime(1, t(step));
    g.gain.exponentialRampToValueAtTime(0.001, t(step) + 0.3);
    o.connect(g).connect(master);
    o.start(t(step)); o.stop(t(step) + 0.32);
  }
  function sub(step, f, len, glide) {
    const o = off.createOscillator(), g = off.createGain();
    o.frequency.setValueAtTime(f * 2, t(step));
    o.frequency.exponentialRampToValueAtTime(f, t(step) + 0.03);
    if (glide) o.frequency.exponentialRampToValueAtTime(glide, t(step) + len * 0.85);
    g.gain.setValueAtTime(0.9, t(step));
    g.gain.setTargetAtTime(0.0001, t(step) + len * 0.55, len * 0.3);
    o.connect(g).connect(master);
    o.start(t(step)); o.stop(t(step) + len);
  }
  function snare(step) {
    const n = off.createBufferSource(); n.buffer = noiseBuf;
    const bp = off.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1800; bp.Q.value = 0.8;
    const g = off.createGain();
    g.gain.setValueAtTime(0.5, t(step));
    g.gain.exponentialRampToValueAtTime(0.001, t(step) + 0.16);
    n.connect(bp).connect(g).connect(master);
    n.start(t(step), Math.random() * 0.4); n.stop(t(step) + 0.18);
    const o = off.createOscillator(), og = off.createGain();
    o.frequency.value = 190;
    og.gain.setValueAtTime(0.25, t(step));
    og.gain.exponentialRampToValueAtTime(0.001, t(step) + 0.08);
    o.connect(og).connect(master);
    o.start(t(step)); o.stop(t(step) + 0.1);
  }
  function hat(step, open) {
    const n = off.createBufferSource(); n.buffer = noiseBuf;
    const hp = off.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 8000;
    const g = off.createGain();
    const d = open ? 0.09 : 0.03;
    g.gain.setValueAtTime(open ? 0.12 : 0.08, t(step));
    g.gain.exponentialRampToValueAtTime(0.001, t(step) + d);
    n.connect(hp).connect(g).connect(master);
    n.start(t(step), Math.random() * 0.4); n.stop(t(step) + d);
  }
  function bell(step, f) {
    const o = off.createOscillator(), g = off.createGain();
    o.type = "sine"; o.frequency.value = f;
    const o2 = off.createOscillator(); o2.type = "triangle"; o2.frequency.value = f * 2.005;
    const g2 = off.createGain(); g2.gain.value = 0.12;
    g.gain.setValueAtTime(0.28, t(step));
    g.gain.exponentialRampToValueAtTime(0.001, t(step) + stepDur * 14);
    o.connect(g).connect(master);
    o2.connect(g2).connect(g);
    o.start(t(step)); o.stop(t(step) + stepDur * 14);
    o2.start(t(step)); o2.stop(t(step) + stepDur * 14);
  }

  if (spec.kind === "dark") {
    // FROSTBITE — creeping dark trap, F minor
    for (let r = 0; r < REPS; r++) {
      const o = r * 64;
      [0, 10, 16, 26, 32, 42, 48, 58].forEach((st) => kick(o + st));
      [8, 24, 40, 56].forEach((st) => snare(o + st));
      for (let st = 0; st < 64; st += 2) hat(o + st, st % 16 === 14);
      sub(o + 0, F, stepDur * 4); sub(o + 6, F, stepDur * 3);
      sub(o + 12, minor[1], stepDur * 4);
      sub(o + 16, F, stepDur * 3); sub(o + 22, minor[2] * 2, stepDur * 2, minor[1]);
      sub(o + 32, F, stepDur * 4); sub(o + 38, F, stepDur * 3, minor[2]);
      sub(o + 44, minor[1], stepDur * 4);
      sub(o + 48, F, stepDur * 4); sub(o + 54, minor[1], stepDur * 2, F);
      if (r % 2 === 1) {
        [0, 16, 32, 48].forEach((b) => {
          bell(o + b, F * 4);
          bell(o + b + 5, minor[1] * 4);
          bell(o + b + 10, minor[2] * 4);
        });
      }
      if (r === REPS - 1) [60, 61, 62, 63].forEach((st) => snare(o + st)); // loop fill
    }
  } else {
    // LATE NIGHT — sliding drill, G minor
    for (let r = 0; r < REPS; r++) {
      const o = r * 64;
      [0, 8, 16, 20, 24, 32, 40, 48, 52, 56].forEach((st) => kick(o + st));
      [12, 28, 44, 60].forEach((st) => snare(o + st));
      for (let st = 0; st < 64; st += 2) hat(o + st, st % 32 === 30);
      sub(o + 0, F, stepDur * 6, F * 0.75); sub(o + 10, F, stepDur * 4);
      sub(o + 16, minor[1], stepDur * 4, F);
      sub(o + 24, F, stepDur * 5, minor[1]);
      sub(o + 32, F, stepDur * 6, F * 0.75); sub(o + 42, F, stepDur * 3, minor[2]);
      sub(o + 48, minor[1], stepDur * 4, F);
      sub(o + 56, F, stepDur * 6, F * 1.33);
      if (r % 2 === 0) [0, 16, 32, 48].forEach((b) => bell(o + b, F * 4 * 1.19)); // slightly sour bell
      if (r === REPS - 1) [58, 60, 62, 63].forEach((st) => snare(o + st)); // loop fill
    }
  }

  return off.startRendering().then((b) => { b.__loopEnd = steps * stepDur; return b; });
}

async function loadDemo(key) {
  const spec = DEMOS[key];
  const chip = $(`#demo-${key}`);
  chip.classList.add("active");
  $("#nowPlaying").textContent = `RENDERING · ${spec.name}…`;
  ensureCtx(); // inside the click gesture — keeps autoplay legal on mobile
  try {
    if (!DEMO_CACHE[key]) DEMO_CACHE[key] = await renderDemo(spec);
    setTrack(DEMO_CACHE[key], `${spec.name} · Prod.TheBeatMob`);
    chip.classList.add("active");
  } catch (err) {
    chip.classList.remove("active");
    showErr(err);
  }
}

$("#demo-frostbite").addEventListener("click", () => loadDemo("frostbite"));
$("#demo-latenight").addEventListener("click", () => loadDemo("latenight"));

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
  const r = canvas.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  const wasPlaying = engine.playing;
  startPlayback(f * (engine.buffer.__loopEnd || engine.buffer.duration));
  if (!wasPlaying) playBtn.innerHTML = engine.playing ? ICON_PAUSE : ICON_PLAY;
}

let scrubbing = false, lastScrub = 0;
canvas.addEventListener("pointerdown", (e) => {
  if (!engine.buffer) return;
  scrubbing = true;
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  seekAt(e.clientX);
  scrubHint();
});
canvas.addEventListener("pointermove", (e) => {
  if (!scrubbing) return;
  const now = performance.now();
  if (now - lastScrub < 90) return;
  lastScrub = now;
  seekAt(e.clientX);
  scrubHint();
});
["pointerup", "pointercancel"].forEach((ev) =>
  canvas.addEventListener(ev, (e) => {
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

$("#exportBtn").addEventListener("click", async function () {
  this.classList.remove("flash"); void this.offsetWidth; this.classList.add("flash");
  if (!engine.buffer) {
    $("#nowPlaying").textContent = "LOAD A TRACK FIRST · THEN EXPORT THE SCREWED WAV";
    return;
  }
  const rate = params.time / 100;
  const src = engine.buffer;
  const outLen = Math.ceil(src.length / rate);
  const off = new OAC(src.numberOfChannels, outLen, src.sampleRate);
  const s = off.createBufferSource();
  s.buffer = src;
  s.playbackRate.value = rate;
  s.detune.value = Math.round(params.pitch) * 100;
  s.connect(off.destination);
  s.start();
  const rendered = await off.startRendering();
  const blob = encodeWav(rendered);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `halfscrew-${engine.trackName.split(" ·")[0].toLowerCase()}-slowed.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

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
  const env = Math.pow(Math.sin(x / W * Math.PI), 0.35) * (0.75 + density * 0.45);
  return Math.abs(a) * env;
}

let offset = 0;
let powered = true;

function trackPos() {
  if (!engine.playing || !engine.buffer || !engine.loopEnd) return 0;
  const rate = params.time / 100;
  const elapsed = Math.max(0, engine.ctx.currentTime - engine.startAt);
  return (engine.offset + elapsed * rate) % engine.loopEnd;
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
        ctx.fillRect(x, midY - h / 2, 1.7, h);
        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(178, 108, 255, 0.12)";
        ctx.fillRect(x, midY + 4, 1.7, h * 0.3);
      } else {
        ctx.fillStyle = "rgba(178, 108, 255, 0.35)";
        ctx.fillRect(x, midY - h / 2, 1.7, h);
        ctx.fillStyle = "rgba(178, 108, 255, 0.07)";
        ctx.fillRect(x, midY + 4, 1.7, h * 0.3);
      }
    }
  } else {
    // idle sweep — full width, colored
    for (let x = 0; x < W; x += 3) {
      const h = synthWave(0, x + offset, 0.8) * H * 0.55;
      const g = ctx.createLinearGradient(0, midY - h / 2, 0, midY + h / 2);
      g.addColorStop(0, "rgba(238, 224, 255, 0.98)");
      g.addColorStop(0.5, "rgba(178, 108, 255, 0.92)");
      g.addColorStop(1, "rgba(238, 224, 255, 0.98)");
      ctx.fillStyle = g;
      ctx.shadowColor = "rgba(168, 85, 247, 0.85)";
      ctx.shadowBlur = 9;
      ctx.fillRect(x, midY - h / 2, 1.7, h);
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
  if (engine.playing && engine.ctx.state === "running") {
    engine.ctx.suspend();
    engine.paused = true;
    playBtn.innerHTML = ICON_PLAY;
    $("#nowPlaying").textContent = `PAUSED · ${engine.trackName}`;
  } else if (engine.ctx.state === "suspended") {
    engine.ctx.resume();
    engine.paused = false;
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

const mix = $("#mix");
const mixRead = $("#mix-read");
function renderMix() {
  mixRead.textContent = mix.value;
  mix.style.setProperty("--fill", `${mix.value}%`);
  params.mix = +mix.value;
  applyParams();
}
mix.addEventListener("input", renderMix);
renderMix();
