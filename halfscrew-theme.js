/* HALFSCREW — strain colour theme.
   One accent colour drives the whole UI through CSS custom properties (--accent, --accent-2, --accent-hot,
   rgb triplets for alpha usage, ...). Picking a strain eases every variable to that strain's colour (~520 ms).
   Pure main-thread / CSS work: nothing in here touches the audio graph, layout or the audio thread.
   Canvas drawing (waveform, spectrum) reads HSTheme.cv, a set of ready-made colour strings that is
   rebuilt only while a transition is running (no per-frame string building, no getComputedStyle). */
(function () {
  "use strict";
  const DURATION = 520;
  const PANEL = [11, 9, 18], PANEL_HI = [23, 19, 31], INK = [26, 11, 38], WHITE = [255, 255, 255], BLACK = [0, 0, 0];

  /* ── colour maths ─────────────────────────────────────────────── */
  const rgbOf = (hex) => { const h = hex.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const hexOf = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const contrast = (a, b) => { let x = lum(a), y = lum(b); if (x < y) { const t = x; x = y; y = t; } return (x + 0.05) / (y + 0.05); };
  function lift(c, bg, min) {                       /* lighten toward white until `c` reaches `min`:1 against `bg` */
    for (let t = 0; t <= 1.0001; t += 0.02) { const m = mix(c, WHITE, t); if (contrast(m, bg) >= min) return m; }
    return WHITE;
  }
  function toHsl(c) {
    const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, s, l];
  }
  function fromHsl(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }

  /* The original purple, kept byte-for-byte so "Original" looks exactly like before. */
  const ORIGINAL = {
    accent: "#a855f7", "accent-2": "#7c3aed", "accent-hot": "#c9a7ff", "accent-soft": "#e6d6ff", "accent-pale": "#f4ecff",
    "accent-bright": "#b26cff", "accent-dark": "#5b21a8", "accent-edge": "#3a2c58", "accent-edge-2": "#5b3fa0", "accent-well": "#17102a",
    "accent-fill": "#a855f7", "btn-1": "#a855f7", "btn-2": "#7c3aed", "btn-3": "#5b21a8", "on-accent": "#f8f2ff",
  };

  /* Derive the whole UI palette from one strain colour.
     accent      the strain colour itself (lifted if needed so it keeps >= 3:1 against the dark panels: UI-component contrast)
     accent-hot  text / highlight tint, guaranteed >= 7:1 on the lightest dark panel (AAA, small text safe)
     accent-fill fill that carries dark ink text at >= 4.5:1
     on-accent   text colour for the gradient buttons (>= 4.5:1 against every stop it sits on) */
  function derive(hex) {
    const base = rgbOf(hex);
    const acc = lift(base, PANEL, 3);
    let hot = mix(acc, WHITE, 0.4);
    if (contrast(hot, PANEL_HI) < 7) hot = lift(hot, PANEL_HI, 7);
    const [h, s, l] = toHsl(acc);
    const deep = fromHsl(h - 8, Math.min(1, s * 0.95), l * 0.8);
    const fill = lift(acc, INK, 4.5);
    const o = {
      accent: acc, "accent-2": deep, "accent-hot": hot,
      "accent-soft": mix(acc, WHITE, 0.72), "accent-pale": mix(acc, WHITE, 0.9), "accent-bright": mix(acc, WHITE, 0.12),
      "accent-dark": mix(acc, BLACK, 0.55),
      "accent-edge": mix([16, 12, 24], acc, 0.28), "accent-edge-2": mix([16, 12, 24], acc, 0.5),
      "accent-well": mix([8, 6, 13], deep, 0.13), "accent-fill": fill,
    };
    if (contrast(acc, [248, 242, 255]) >= 4.5) {            /* dark accents: light text on the classic acc -> deep -> dark gradient */
      o["btn-1"] = acc; o["btn-2"] = deep; o["btn-3"] = o["accent-dark"]; o["on-accent"] = [248, 242, 255];
    } else {                                      /* light accents: dark ink on a lit gradient */
      o["btn-1"] = mix(fill, WHITE, 0.32); o["btn-2"] = fill; o["btn-3"] = fill; o["on-accent"] = INK;
    }
    return o;
  }
  const paletteFor = (hex) => {
    if (hex.toLowerCase() === ORIGINAL.accent) { const o = {}; for (const k in ORIGINAL) o[k] = rgbOf(ORIGINAL[k]); return o; }
    return derive(hex);
  };

  /* ── state + tween ────────────────────────────────────────────── */
  const KEYS = Object.keys(ORIGINAL);
  const root = document.documentElement;
  const reduced = window.matchMedia ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  let cur = paletteFor(ORIGINAL.accent), from = null, to = cur, t0 = 0, raf = 0, curHex = ORIGINAL.accent, lastW = 0;
  const listeners = [];
  const written = {};
  const cv = {};                                     /* canvas colour strings, see build() */
  const rgb = (c, a) => a === undefined ? `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})` : `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

  function build(p) {
    cv.grid = rgb(p["accent-2"], 0.12);
    cv.barA = rgb(mix(p["accent-pale"], p["accent-soft"], 0.5), 0.98);    /* waveform bar edges  (~#eee0ff for the purple) */
    cv.barB = rgb(p["accent-bright"], 0.92);                              /* waveform bar core */
    cv.glow = rgb(p.accent, 0.85);
    cv.dim = rgb(p["accent-bright"], 0.12);
    cv.rest = rgb(p["accent-bright"], 0.35);
    cv.rest2 = rgb(p["accent-bright"], 0.07);
    cv.spec = rgb(p.accent, 0.28);
  }
  function write(p) {
    for (const k of KEYS) {
      const c = p[k], v = `${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}`;
      if (written[k] !== v) { root.style.setProperty("--" + k + "-rgb", v); written[k] = v; }
    }
    build(p);
  }
  function frame(now) {
    raf = 0;
    if (now - t0 < DURATION && now - lastW < 30) { raf = requestAnimationFrame(frame); return; }   /* ~30 fps colour steps: half the repaint cost, still silky for a fade */
    lastW = now;
    const k = Math.min(1, (now - t0) / DURATION);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;     /* easeInOutCubic */
    const p = {};
    for (const key of KEYS) p[key] = mix(from[key], to[key], e);
    cur = p; write(p);
    if (k < 1) raf = requestAnimationFrame(frame); else { cur = to; root.classList.remove("hs-theming"); listeners.forEach((f) => f(curHex)); }
  }
  function set(hex, opts) {
    hex = String(hex).toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex)) return;
    if (hex === curHex && !raf) return;
    curHex = hex;
    from = cur; to = paletteFor(hex);
    root.dataset.strainColor = hex;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (reduced.matches || (opts && opts.instant)) { cur = to; write(to); root.classList.remove("hs-theming"); listeners.forEach((f) => f(hex)); return; }
    root.classList.add("hs-theming");
    t0 = performance.now(); raf = requestAnimationFrame(frame);
  }
  write(cur);

  window.HSTheme = {
    set, derive, paletteFor, contrast, lum, rgbOf, hexOf, mix, cv,
    DURATION, PANEL, PANEL_HI, INK, ORIGINAL,
    reset: (o) => set(ORIGINAL.accent, o),
    onChange: (f) => listeners.push(f),
    get hex() { return curHex; },
    get palette() { return cur; },
  };
})();
