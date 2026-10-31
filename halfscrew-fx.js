/* HALFSCREW — EQ + FX chain.
   ONE graph builder is used for the live preview (AudioContext) and for the exported
   WAV (OfflineAudioContext), so what you hear is what you export.
   Chain (series, like the original HalfScrew tool):
     varispeed -> 8-band EQ -> reverb -> delay -> chorus -> drive -> [dry/wet] -> OUT trim -> limiter */
(function () {
  "use strict";

  const DELAY_TIME = 0.25, DELAY_FB = 0.5;                  /* old tool: 8n @120 bpm, feedback .5 */
  const REVERB_DECAY = 3;                                   /* old tool: 3 s */
  const CHORUS = { rate: 1.5, base: 0.0085, depth: 0.0035 };
  const TC = 0.025;                                         /* parameter smoothing time constant (s) */

  const FX_KEYS = ["rev", "del", "cho", "dis"];

  function defaults() {
    return {
      time: 100, pitch: 0, wow: 25, mix: 100,
      eqOn: true, out: 0, hq: true,
      rev: 0, del: 0, cho: 0, dis: 0,
      revOn: false, delOn: false, choOn: false, disOn: false,
      ...HSEQ.bandDefaults(),          /* e1on, e1f, e1s, e1q ... e8q: the 8-band parametric EQ */
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
    const input = ctx.createGain();
    const eq = HSEQ.create(ctx);           /* AudioWorklet EQ (ctx.__hsEq) or native biquad fallback */
    input.connect(eq.input);

    const rev = xfade(ctx, eq.output, (i) => {
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

    const nodes = { eq, rev, del, cho, dis, mixDry, mixWet, trim };

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
      eq.apply(p, smooth);
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
    const eq = HSEQ.isActive(p);
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
    await HSEQ.load(off);                  /* same worklet EQ as the live graph (native fallback if unavailable) */
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

  /* analytic response of the 8-band EQ (same coefficients the audio uses; no AudioContext needed) */
  function eqResponseDb(p, freqs, sr, only) { return HSEQ.responseDb(p, freqs, sr, only); }

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
      /* the 3 legacy tone values live on the 8-band EQ: 400 Hz low shelf = band 2, 1 kHz bell Q.8 = band 4, 2.5 kHz high shelf = band 7 */
      eq8: HSEQ.strainBands(eq[0], eq[1], eq[2]),
    };
  }
  const STRAINS = [
    S(0, 0, "Original", 100, 0, 0, [0, 0, 0]),
    S(1, 1, "Wockk Classic", 80, 0, 0, [2, 0, -2]),
    S(2, 1, "Tussy Pour", 78, 0, 10, [3, 0, -3], { dis: 8 }),
    S(3, 1, "Barr Bottom", 72, 0, 0, [4, -1, -4], { dis: 10 }),
    S(4, 1, "Half Triss", 89, 0, 0, [2, 0, -2]),
    S(5, 1, "Double Akorne", 80, -1, 0, [4, 0, -3], { del: 12 }),
    S(6, 2, "Qualli Rinse", 90, 0, 0, [1, 0, -2], { rev: 30 }),
    S(7, 2, "Holy Tuss", 85, 0, 0, [0, -1, -1], { rev: 55 }),
    S(8, 2, "Hi-Tekk Purp Dreamz", 88, 0, 20, [1, 0, -1], { rev: 40, cho: 18 }),
    S(9, 2, "Echo Ackt", 90, -1, 0, [0, 0, -2], { rev: 28, del: 30 }),
    S(10, 2, "Midnight Wockk", 92, 0, 6, [2, 1, -2], { rev: 35 }),
    S(11, 3, "Dusty Qualli", 94, 0, 15, [1, 2, -7], { dis: 14, cho: 10 }),
    S(12, 3, "Roxx Grape Rain", 90, 0, 12, [0, 1, -5], { rev: 25, cho: 12 }),
    S(13, 3, "Basement Barr", 96, 0, 20, [2, 2, -8], { dis: 20 }),
    S(14, 3, "Triss Light", 92, 1, 5, [0, 1, -4], { rev: 15 }),
    S(15, 3, "3AM Triss", 97, 0, 10, [-2, 4, -6], { dis: 18, rev: 12 }),
    S(16, 4, "Wobbly Wockk", 96, 0, 35, [0, 0, -2], { cho: 22 }),
    S(17, 4, "Sea-Sick Hi-Tekk", 94, 0, 80, [1, 0, -3], { cho: 30, rev: 14 }),
    S(18, 4, "Old Roxx", 93, 0, 50, [1, 1, -5], { dis: 12, cho: 15 }),
    S(19, 4, "Tuss Lite", 98, 0, 20, [0, 0, -1], { cho: 12 }),
    S(20, 4, "Akorne Melt", 88, 0, 100, [-1, 2, -6], { dis: 14, cho: 28, rev: 15 }),
    S(21, 5, "Half Pint Ackt", 50, 0, 0, [3, 0, -1], { rev: 8 }),
    S(22, 5, "Full Pint Barr", 50, -2, 0, [5, -1, -3], { dis: 12, rev: 10 }),
    S(23, 5, "¾ Cup Qualli", 75, 0, 0, [2, 0, 0], { del: 14 }),
    S(24, 5, "Warehouse Roxx", 60, -1, 0, [4, 0, -2], { rev: 22, dis: 10 }),
    S(25, 5, "Ackt Right", 65, 1, 0, [3, 1, 1], { del: 18, rev: 12 }),
  ];

  /* Each strain's syrup colour: drives the whole UI theme (see halfscrew-theme.js). Original stays the HalfScrew purple. */
  const STRAIN_HEX = [
    "#a855f7", // 00 Original
    "#b52bc4", // 01 Wockk Classic
    "#ff9a1f", // 02 Tussy Pour
    "#b0304f", // 03 Barr Bottom
    "#e8294b", // 04 Half Triss
    "#e3c04a", // 05 Double Akorne
    "#c9aef0", // 06 Qualli Rinse
    "#3f6df2", // 07 Holy Tuss
    "#8a2be2", // 08 Hi-Tekk Purp Dreamz
    "#0fa5a0", // 09 Echo Ackt
    "#4650d8", // 10 Midnight Wockk
    "#d08a9a", // 11 Dusty Qualli
    "#8a4aae", // 12 Roxx Grape Rain
    "#4caf6a", // 13 Basement Barr
    "#ffc2dc", // 14 Triss Light
    "#4cb8ff", // 15 3AM Triss
    "#a8e03a", // 16 Wobbly Wockk
    "#7dd8a0", // 17 Sea-Sick Hi-Tekk
    "#b8532c", // 18 Old Roxx
    "#f5eb9c", // 19 Tuss Lite
    "#cfe3ff", // 20 Akorne Melt
    "#ffb694", // 21 Half Pint Ackt
    "#ff5a2e", // 22 Full Pint Barr
    "#5ef0f0", // 23 ¾ Cup Qualli
    "#8aa0b8", // 24 Warehouse Roxx
    "#ff3d9a", // 25 Ackt Right
  ];
  STRAINS.forEach((st, i) => { st.hex = STRAIN_HEX[i]; });

  window.HSFX = {
    FX_KEYS, FAMILIES, STRAINS, TC, defaults,
    buildChain, needsChain, tailSeconds, renderOffline, limitBuffer, eqResponseDb,
  };
})();
