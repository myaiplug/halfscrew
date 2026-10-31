/* HALFSCREW — EQ + FX chain.
   ONE graph builder is used for the live preview (AudioContext) and for the exported
   WAV (OfflineAudioContext), so what you hear is what you export.
   Chain (series, like the original HalfScrew tool):
     varispeed -> 3-band EQ -> reverb -> delay -> chorus -> drive -> [dry/wet] -> OUT trim -> limiter */
(function () {
  "use strict";

  const EQ_FREQ = { low: 400, mid: 1000, high: 2500 };      /* shelf / peak / shelf, +-12 dB */
  const EQ_Q = 0.8;
  const DELAY_TIME = 0.25, DELAY_FB = 0.5;                  /* old tool: 8n @120 bpm, feedback .5 */
  const REVERB_DECAY = 3;                                   /* old tool: 3 s */
  const CHORUS = { rate: 1.5, base: 0.0085, depth: 0.0035 };
  const TC = 0.025;                                         /* parameter smoothing time constant (s) */

  const FX_KEYS = ["rev", "del", "cho", "dis"];

  function defaults() {
    return {
      time: 100, pitch: 0, wow: 25, mix: 100,
      eqOn: true, eqLow: 0, eqMid: 0, eqHigh: 0, out: 0, hq: true,
      rev: 0, del: 0, cho: 0, dis: 0,
      revOn: false, delOn: false, choOn: false, disOn: false,
    };
  }

  /* ---- deterministic reverb impulse response ----------------------------- */
  const irCache = new Map();
  function reverbIR(ctx) {
    const sr = ctx.sampleRate;
    if (irCache.has(sr)) return irCache.get(sr);
    const len = Math.floor(sr * (REVERB_DECAY + 0.25));
    const buf = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let seed = 0x9e3779b1 ^ (c * 0x85ebca6b);
      let lp = 0;
      const pre = Math.floor(sr * 0.012);
      for (let i = 0; i < len; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const noise = seed / 2147483648 - 1;
        const t = i / sr;
        /* high frequencies die faster: one-pole low-pass that closes over time */
        const k = 0.9 - 0.82 * Math.exp(-t * 1.6);
        lp = lp * k + noise * (1 - k);
        const env = Math.exp((-6.9078 * t) / REVERB_DECAY);
        const ramp = Math.min(1, (i - pre) / (sr * 0.02));
        d[i] = i < pre ? 0 : lp * env * Math.max(0, ramp) * 2.2;
      }
    }
    irCache.set(sr, buf);
    return buf;
  }

  let driveCurve = null;
  function getDriveCurve() {
    if (driveCurve) return driveCurve;
    const N = 4097; driveCurve = new Float32Array(N);
    for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * 2 - 1; driveCurve[i] = Math.tanh(3.2 * x) * 0.82; }
    return driveCurve;
  }

  /* ---- graph ------------------------------------------------------------- */
  function xfade(ctx, input, makeWet) {
    const dry = ctx.createGain(), wet = ctx.createGain(), sum = ctx.createGain();
    dry.gain.value = 1; wet.gain.value = 0;
    input.connect(dry); dry.connect(sum);
    const wetIn = ctx.createGain();
    input.connect(wetIn);
    const wetOut = makeWet(wetIn);
    wetOut.connect(wet); wet.connect(sum);
    return { dry, wet, sum };
  }

  function buildChain(ctx) {
    const mk = (type, f, g, q) => {
      const b = ctx.createBiquad ? ctx.createBiquad() : ctx.createBiquadFilter();
      b.type = type; b.frequency.value = f; b.gain.value = g || 0; if (q) b.Q.value = q; return b;
    };
    const input = ctx.createGain();
    const eqLow = mk("lowshelf", EQ_FREQ.low, 0);
    const eqMid = mk("peaking", EQ_FREQ.mid, 0, EQ_Q);
    const eqHigh = mk("highshelf", EQ_FREQ.high, 0);
    input.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh);

    const rev = xfade(ctx, eqHigh, (i) => {
      const cv = ctx.createConvolver(); cv.normalize = true; cv.buffer = reverbIR(ctx); i.connect(cv); return cv;
    });
    const del = xfade(ctx, rev.sum, (i) => {
      const d = ctx.createDelay(1.0); d.delayTime.value = DELAY_TIME;
      const fb = ctx.createGain(); fb.gain.value = DELAY_FB;
      i.connect(d); d.connect(fb); fb.connect(d); return d;
    });
    const cho = xfade(ctx, del.sum, (i) => {
      const sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
      i.connect(sp);
      for (let c = 0; c < 2; c++) {
        const d = ctx.createDelay(0.05); d.delayTime.value = CHORUS.base;
        const lfo = ctx.createOscillator(); lfo.type = "sine"; lfo.frequency.value = CHORUS.rate;
        const depth = ctx.createGain(); depth.gain.value = c ? -CHORUS.depth : CHORUS.depth;
        lfo.connect(depth); depth.connect(d.delayTime); lfo.start(0);
        sp.connect(d, c, 0); d.connect(mg, 0, c);
      }
      return mg;
    });
    const dis = xfade(ctx, cho.sum, (i) => {
      const ws = ctx.createWaveShaper(); ws.curve = getDriveCurve(); ws.oversample = "4x"; i.connect(ws); return ws;
    });

    const mixDry = ctx.createGain(), mixWet = ctx.createGain(), trim = ctx.createGain();
    mixDry.gain.value = 0; mixWet.gain.value = 1;
    input.connect(mixDry); dis.sum.connect(mixWet);
    mixDry.connect(trim); mixWet.connect(trim);

    const nodes = { eqLow, eqMid, eqHigh, rev, del, cho, dis, mixDry, mixWet, trim };

    function set(param, v, smooth) {
      if (smooth) {
        const t = ctx.currentTime;
        param.cancelScheduledValues(t);
        param.setTargetAtTime(v, t, smooth);
      } else {
        param.value = v;
      }
    }
    /* smooth: time constant in seconds (live) or 0 (offline: set directly) */
    function apply(p, smooth) {
      const eq = p.eqOn !== false;
      set(eqLow.gain, eq ? p.eqLow : 0, smooth);
      set(eqMid.gain, eq ? p.eqMid : 0, smooth);
      set(eqHigh.gain, eq ? p.eqHigh : 0, smooth);
      const amt = { rev: 0, del: 0, cho: 0, dis: 0 };
      FX_KEYS.forEach((k) => { amt[k] = p[k + "On"] ? Math.min(1, Math.max(0, p[k] / 100)) : 0; });
      [["rev", rev], ["del", del], ["cho", cho], ["dis", dis]].forEach(([k, x]) => {
        set(x.wet.gain, amt[k], smooth);
        set(x.dry.gain, 1 - amt[k], smooth);
      });
      const m = Math.min(1, Math.max(0, p.mix / 100));
      set(mixWet.gain, m, smooth);
      set(mixDry.gain, 1 - m, smooth);
      set(trim.gain, Math.pow(10, (p.out || 0) / 20), smooth);
    }
    return { input, output: trim, nodes, apply };
  }

  /* is there anything for the offline graph to do? (EQ flat + FX off = skip it) */
  function needsChain(p) {
    const eq = p.eqOn !== false && (p.eqLow || p.eqMid || p.eqHigh);
    const fx = FX_KEYS.some((k) => p[k + "On"] && p[k] > 0);
    return !!((eq || fx) && p.mix > 0) || (p.out || 0) !== 0;
  }
  function tailSeconds(p) {
    let t = 0;
    if (p.revOn && p.rev > 1) t = Math.max(t, REVERB_DECAY);
    if (p.delOn && p.del > 1) t = Math.max(t, 2.5);
    return t;
  }

  /* offline render of the very same chain. Returns an AudioBuffer (length + FX tail). */
  async function renderOffline(src, p) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const tail = Math.ceil(tailSeconds(p) * src.sampleRate);
    const off = new OAC(Math.max(2, src.numberOfChannels), src.length + tail, src.sampleRate);
    const chain = buildChain(off);
    chain.apply(p, 0);
    const s = off.createBufferSource();
    s.buffer = src;
    s.connect(chain.input);
    chain.output.connect(off.destination);
    s.start(0);
    return off.startRendering();
  }

  /* safe output stage on a whole buffer (same limiter class as the live preview) */
  function limitBuffer(buf) {
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    const lim = new HSDSP.Limiter(buf.sampleRate, buf.numberOfChannels);
    const r = lim.processChannels(chans);
    if (r.minGain >= 1) return { buffer: buf, reduction: 0 };
    const out = new AudioBuffer({ length: buf.length, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
    r.channels.forEach((d, c) => out.getChannelData(c).set(d));
    return { buffer: out, reduction: -20 * Math.log10(r.minGain) };
  }

  /* analytic RBJ response of the 3-band EQ (for the drawing; no AudioContext needed) */
  function eqResponseDb(p, freqs, sr) {
    sr = sr || 48000;
    const bands = [["lowshelf", EQ_FREQ.low, p.eqLow, 0.707], ["peaking", EQ_FREQ.mid, p.eqMid, EQ_Q], ["highshelf", EQ_FREQ.high, p.eqHigh, 0.707]];
    return freqs.map((f) => {
      let db = 0;
      bands.forEach(([type, f0, g, q]) => {
        if (!g || p.eqOn === false) return;
        const A = Math.pow(10, g / 40), w0 = (2 * Math.PI * f0) / sr, cs = Math.cos(w0), sn = Math.sin(w0);
        const al = sn / (2 * q);
        let b0, b1, b2, a0, a1, a2;
        if (type === "peaking") {
          b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A;
        } else {
          const sq = 2 * Math.sqrt(A) * al;
          if (type === "lowshelf") {
            b0 = A * ((A + 1) - (A - 1) * cs + sq); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - sq);
            a0 = (A + 1) + (A - 1) * cs + sq; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - sq;
          } else {
            b0 = A * ((A + 1) + (A - 1) * cs + sq); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - sq);
            a0 = (A + 1) - (A - 1) * cs + sq; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - sq;
          }
        }
        const w = (2 * Math.PI * f) / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
        const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
        const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
        db += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
      });
      return db;
    });
  }

  /* ── STRAINS ─────────────────────────────────────────────────────────────
     A strain is a one-click preset: TIME / PITCH / WOW + EQ + FX + OUT.
     The 25 "Potion Recipes" are loadable as strains (same numbers), with a
     matching EQ/FX flavour per family. WOW uses the design values (the export
     bug that made WOW drift is fixed). */
  const FAMILIES = ["ORIGINAL", "CLASSIC HOUSTON", "SLOWED + REVERB", "LATE-NIGHT LO-FI", "TAPE WARBLE", "CLUB HALFTIME"];
  function S(id, fam, name, time, pitch, wow, eq, fx, out) {
    const f = fx || {};
    return {
      id, fam, name, time, pitch, wow, eqLow: eq[0], eqMid: eq[1], eqHigh: eq[2], out: out || 0,
      rev: f.rev || 0, del: f.del || 0, cho: f.cho || 0, dis: f.dis || 0,
    };
  }
  const STRAINS = [
    S(0, 0, "Original", 100, 0, 0, [0, 0, 0]),
    S(1, 1, "Wokkie Classic", 80, 0, 0, [2, 0, -2]),
    S(2, 1, "Tussy Pour", 78, 0, 10, [3, 0, -3], { dis: 8 }),
    S(3, 1, "Barrel Bottom", 72, 0, 0, [4, -1, -4], { dis: 10 }),
    S(4, 1, "Half Tris", 89, 0, 0, [2, 0, -2]),
    S(5, 1, "Double Akorny", 80, -1, 0, [4, 0, -3], { del: 12 }),
    S(6, 2, "Purple Rinse", 90, 0, 0, [1, 0, -2], { rev: 30 }),
    S(7, 2, "Holy Tuss", 85, 0, 0, [0, -1, -1], { rev: 55 }),
    S(8, 2, "Lavender Dreamz", 88, 0, 20, [1, 0, -1], { rev: 40, cho: 18 }),
    S(9, 2, "Echo Akt", 90, -1, 0, [0, 0, -2], { rev: 28, del: 30 }),
    S(10, 2, "Midnight Wokk", 92, 0, 6, [2, 1, -2], { rev: 35 }),
    S(11, 3, "Dusty Bottle", 94, 0, 15, [1, 2, -7], { dis: 14, cho: 10 }),
    S(12, 3, "Grape Rain", 90, 0, 12, [0, 1, -5], { rev: 25, cho: 12 }),
    S(13, 3, "Basement Barr", 96, 0, 20, [2, 2, -8], { dis: 20 }),
    S(14, 3, "Light Pour", 92, 1, 5, [0, 1, -4], { rev: 15 }),
    S(15, 3, "3AM Tris", 97, 0, 10, [-2, 4, -6], { dis: 18, rev: 12 }),
    S(16, 4, "Wobbly Wokk", 96, 0, 35, [0, 0, -2], { cho: 22 }),
    S(17, 4, "Sea-Sick Sip", 94, 0, 80, [1, 0, -3], { cho: 30, rev: 14 }),
    S(18, 4, "Old Roxxy", 93, 0, 50, [1, 1, -5], { dis: 12, cho: 15 }),
    S(19, 4, "Tuss Lite", 98, 0, 20, [0, 0, -1], { cho: 12 }),
    S(20, 4, "Melted Styro", 88, 0, 100, [-1, 2, -6], { dis: 14, cho: 28, rev: 15 }),
    S(21, 5, "Half Pint", 50, 0, 0, [3, 0, -1], { rev: 8 }),
    S(22, 5, "Full Pint", 50, -2, 0, [5, -1, -3], { dis: 12, rev: 10 }),
    S(23, 5, "¾ Cup Swing", 75, 0, 0, [2, 0, 0], { del: 14 }),
    S(24, 5, "Warehouse Barrel", 60, -1, 0, [4, 0, -2], { rev: 22, dis: 10 }),
    S(25, 5, "Akt Right", 65, 1, 0, [3, 1, 1], { del: 18, rev: 12 }),
  ];

  /* Each strain's syrup colour: drives the whole UI theme (see halfscrew-theme.js). Original stays the HalfScrew purple. */
  const STRAIN_HEX = [
    "#a855f7", // 00 Original
    "#b52bc4", // 01 Wokkie Classic
    "#ff9a1f", // 02 Tussy Pour
    "#b0304f", // 03 Barrel Bottom
    "#e8294b", // 04 Half Tris
    "#e3c04a", // 05 Double Akorny
    "#c9aef0", // 06 Purple Rinse
    "#3f6df2", // 07 Holy Tuss
    "#a99cff", // 08 Lavender Dreamz
    "#0fa5a0", // 09 Echo Akt
    "#4650d8", // 10 Midnight Wokk
    "#d08a9a", // 11 Dusty Bottle
    "#7b5ef0", // 12 Grape Rain
    "#4caf6a", // 13 Basement Barr
    "#ffc2dc", // 14 Light Pour
    "#4cb8ff", // 15 3AM Tris
    "#a8e03a", // 16 Wobbly Wokk
    "#7dd8a0", // 17 Sea-Sick Sip
    "#b8532c", // 18 Old Roxxy
    "#f5eb9c", // 19 Tuss Lite
    "#cfe3ff", // 20 Melted Styro
    "#ffb694", // 21 Half Pint
    "#ff5a2e", // 22 Full Pint
    "#5ef0f0", // 23 ¾ Cup Swing
    "#a9854f", // 24 Warehouse Barrel
    "#ff3d9a", // 25 Akt Right
  ];
  STRAINS.forEach((st, i) => { st.hex = STRAIN_HEX[i]; });

  window.HSFX = {
    EQ_FREQ, EQ_Q, FX_KEYS, FAMILIES, STRAINS, TC, defaults,
    buildChain, needsChain, tailSeconds, renderOffline, limitBuffer, eqResponseDb,
  };
})();
