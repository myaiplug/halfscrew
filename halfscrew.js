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

window.params = { time: 100, pitch: 0, wow: 25, mix: 100 };
window.engine = {
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
  pct: (v) => `${Math.round(v)}%`,
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
  window.knobSet = window.knobSet || {};
  window.knobSet[key] = (next) => { val = Math.min(max, Math.max(min, next)); render(); };
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

function rampParam(audioParam, value, seconds) {
  const now = engine.ctx.currentTime;
  const cur = audioParam.value;
  audioParam.cancelScheduledValues(now);
  audioParam.setValueAtTime(cur, now);
  audioParam.linearRampToValueAtTime(value, now + seconds);
}
function screwRate() {
  return Math.max(0.5, Math.min(2, params.time / 100));
}
function applyParams() {
  if (!engine.playing) return;
  const rate = screwRate();
  const w = params.mix / 100;
  try {
    if (engine.worklet) {
      rampParam(engine.worklet.parameters.get("rate"), rate, 0.12);
      rampParam(engine.worklet.parameters.get("pitch"), params.pitch, 0.12);
      rampParam(engine.worklet.parameters.get("wow"), params.wow / 100, 0.08);
    } else if (engine.wet) {
      rampParam(engine.wet.playbackRate, rate, 0.12);
      rampParam(engine.wet.detune, Math.round(params.pitch) * 100, 0.12);
    }
    if (engine.wetGain) rampParam(engine.wetGain.gain, w, 0.08);
    if (engine.dryGain) rampParam(engine.dryGain.gain, 1 - w, 0.08);
  } catch (_) {}
}
async function ensureWorklet() {
  const ctx = ensureCtx();
  if (engine.worklet) return engine.worklet;
  await ctx.audioWorklet.addModule("halfscrew-worklet.js");
  engine.worklet = new AudioWorkletNode(ctx, "halfscrew-processor", { outputChannelCount: [2] });
  return engine.worklet;
}
function postFile(node, buffer, offset) {
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice());
  node.port.postMessage({ type: "file", channels });
  node.port.postMessage({ type: "seek", pos: Math.floor(offset * buffer.sampleRate) });
}

function stopPlayback() {
  [engine.dry, engine.wet].forEach((src) => {
    try { src && src.stop(); } catch (_) {}
  });
  if (engine.worklet) {
    try { engine.worklet.port.postMessage({ type: "stop" }); engine.worklet.disconnect(); } catch (_) {}
  }
  engine.dry = engine.wet = null;
  engine.playing = false;
}

async function startPlayback(offset = 0) {
  const ctx = ensureCtx();
  stopPlayback();
  if (!engine.buffer) return;
  try { await ensureWorklet(); } catch (_) { engine.worklet = null; }

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
  const w = params.mix / 100;
  engine.wetGain.gain.value = w;
  engine.dryGain.gain.value = 1 - w;
  const t = ctx.currentTime + 0.05;
  engine.dry.start(t, offset);
  if (engine.worklet) {
    postFile(engine.worklet, engine.buffer, offset);
    engine.worklet.parameters.get("rate").value = screwRate();
    engine.worklet.parameters.get("pitch").value = params.pitch;
    engine.worklet.parameters.get("wow").value = params.wow / 100;
    engine.worklet.connect(engine.wetGain).connect(comp).connect(engine.master);
    engine.worklet.port.postMessage({ type: "play" });
    engine.wet = null;
  } else {
    engine.wet.connect(engine.wetGain).connect(comp).connect(engine.master);
    engine.wet.playbackRate.value = screwRate();
    engine.wet.detune.value = Math.round(params.pitch) * 100;
    engine.wet.start(t, offset);
  }
  engine.startAt = t;
  engine.offset = offset;
  engine.playing = true;
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

function resample(src, ratio, wow = 0) {
  const outLen = Math.max(1, Math.ceil(src.length / ratio));
  const out = new AudioBuffer({ length: outLen, numberOfChannels: src.numberOfChannels, sampleRate: src.sampleRate });
  for (let c = 0; c < src.numberOfChannels; c++) {
    const a = src.getChannelData(c);
    const b = out.getChannelData(c);
    for (let i = 0; i < outLen; i++) {
      const wobble = Math.sin((i / src.sampleRate) * 2 * Math.PI * 0.35) * wow * 0.45;
      const x = i * ratio * Math.pow(2, wobble / 12);
      const i0 = Math.floor(x);
      const i1 = Math.min(a.length - 1, i0 + 1);
      const f = x - i0;
      b[i] = (a[i0] || 0) * (1 - f) + (a[i1] || 0) * f;
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
  let rendered = resample(src, ratio, params.wow / 100);
  const blob = encodeWav(rendered);
  const base = (engine.trackName || "track").split(" ·")[0].replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "track";
  const name = base + "-HalfScrew-t" + Math.round(params.time) + "-p" + Math.round(params.pitch) + "-w" + Math.round(params.wow) + "-mix" + Math.round(params.mix) + ".wav";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  $("#nowPlaying").textContent = "EXPORTED · " + name;
});
function reportFrame() {
  if (window.parent === window) return;
  const box = document.querySelector(".plugin");
  if (!box) return;
  parent.postMessage({ type: "halfscrew-h", h: Math.ceil(box.getBoundingClientRect().height + 16) }, "*");
}
window.addEventListener("load", reportFrame);
window.addEventListener("resize", reportFrame);
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
