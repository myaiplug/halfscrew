/* HALFSCREW — live knob / scope / meter logic */

const $ = (s, el = document) => el.querySelector(s);

/* ── knobs ────────────────────────────────────────────────────── */

const FMT = {
  time: (v) => `${Math.round(v)}% ${v === 100 ? "HALFTIME" : "SCREW"}`,
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
  const ring = $(".led-ring", wrap);
  const face = $(".knob-face", wrap);
  const read = $(`#read-${wrap.dataset.knob}`);

  let val = +wrap.dataset.val;

  function render() {
    const pct = (val - min) / (max - min);
    ring.style.setProperty("--arc", `${pct * 288}deg`);
    face.style.transform = `rotate(${-144 + pct * 288}deg)`;
    if (read) read.textContent = fmt(val);
  }

  function setFromPointer(startY, startY2, prevVal) {
    const delta = (startY - startY2) / 140; // up = increase
    let v = prevVal + delta * (max - min);
    v = Math.min(max, Math.max(min, v));
    val = v;
    render();
  }

  let startY = 0;
  let prevVal = 0;
  let active = false;

  wrap.addEventListener("pointerdown", (e) => {
    active = true;
    startY = e.clientY;
    prevVal = val;
    wrap.classList.add("dragging");
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener("pointermove", (e) => {
    if (!active) return;
    setFromPointer(startY, e.clientY, prevVal);
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

/* ── waveform scope ────────────────────────────────────────────── */

const canvas = $("#scope");
const ctx = canvas.getContext("2d");
const W = (canvas.width = 1120);
const H = (canvas.height = 150);

function wave(seed, x, density) {
  // deterministic pseudo-wave, denser & higher near center
  const t = x * 0.02 + seed;
  const a =
    Math.sin(t) * 0.35 +
    Math.sin(t * 2.3 + 1.7) * 0.25 +
    Math.sin(t * 4.7 + 0.4) * 0.18 +
    Math.sin(t * 9.1 + 2.2) * 0.09;
  const env = Math.pow(Math.sin(x / W * Math.PI), 0.35) * (0.75 + density * 0.45);
  return Math.abs(a) * env;
}

let offset = 0;
let powered = true;

function drawScope() {
  ctx.clearRect(0, 0, W, H);

  const mid = W / 2;

  // left: original — dim white
  for (let x = 0; x < mid; x += 3) {
    const h = wave(0, x + offset, 0.4) * H * 0.42;
    ctx.fillStyle = "rgba(190,185,205,0.32)";
    ctx.fillRect(x, mid - h / 2 > 0 ? mid - h / 2 : 0, 1.6, h);
  }

  // right: slowed — purple, stretched
  for (let x = mid; x < W; x += 3) {
    const sx = (x - mid) / 1.6; // stretched = slowed
    const h = wave(0, sx + offset, 1) * H * 0.6;
    const g = ctx.createLinearGradient(0, mid - h / 2, 0, mid + h / 2);
    g.addColorStop(0, "rgba(201,167,255,0.95)");
    g.addColorStop(0.5, "rgba(168,85,247,0.9)");
    g.addColorStop(1, "rgba(201,167,255,0.95)");
    ctx.fillStyle = g;
    ctx.fillRect(x, mid - h / 2, 1.6, h);
  }

  if (powered) offset += 2.2;
  requestAnimationFrame(drawScope);
}
drawScope();

/* playhead sweep */
const playhead = $("#playhead");
let px = 0;
(function sweep() {
  px = (px + 2.4) % (W + 60);
  playhead.style.left = `${px}px`;
  requestAnimationFrame(sweep);
})();

/* ── output meter ──────────────────────────────────────────────── */

const meterFill = $("#meterFill");
(function bounceMeter() {
  const base = powered ? 46 + Math.random() * 40 : 2;
  meterFill.style.height = `${base}%`;
  setTimeout(bounceMeter, 160 + Math.random() * 220);
})();

/* ── power ────────────────────────────────────────────────────── */

$("#powerBtn").addEventListener("click", function () {
  powered = !powered;
  this.classList.toggle("on", powered);
  document.getElementById("plugin").style.filter = powered ? "" : "saturate(0.35) brightness(0.65)";
});

/* ── dry/wet ──────────────────────────────────────────────────── */

const mix = $("#mix");
const mixRead = $("#mix-read");
function renderMix() {
  mixRead.textContent = mix.value;
  mix.style.setProperty("--fill", `${mix.value}%`);
}
mix.addEventListener("input", renderMix);
renderMix();

/* ── export ───────────────────────────────────────────────────── */

$("#exportBtn").addEventListener("click", function () {
  this.classList.remove("flash");
  void this.offsetWidth;
  this.classList.add("flash");
});
