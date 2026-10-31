/* HALFSCREW — 8-band parametric EQ (shared by the page and the audio worklet).
   One piece of filter math drives everything: the live preview, the offline export render and the
   curve you see on the spectrum (the curve is drawn from the very same coefficients).
     band 1  LOW CUT    high-pass   12 / 24 dB per octave, Q = resonance
     band 2  LOW SHELF  +-18 dB, Q = shelf steepness (RBJ Q-form; Q .707 == the old fixed shelf)
     band 3-6 BELL      +-18 dB, Q .3 - 12
     band 7  HIGH SHELF +-18 dB, Q = shelf steepness
     band 8  HIGH CUT   low-pass    12 / 24 dB per octave, Q = resonance
   Loaded twice: as a normal script (UI, params, presets, analytic response) and inside the
   AudioWorkletGlobalScope (the processor). Biquads are Direct-Form-II-transposed in float64;
   freq / gain / Q / bypass are smoothed per 16-sample slice and the coefficients are recomputed
   from the smoothed values, so a move never zippers and nothing is rebuilt while playing. */
(function (root) {
  "use strict";
  const SQ2 = Math.SQRT1_2;                       /* .7071 = the old fixed shelf slope / Butterworth Q */
  const HPQ = [0.76537, 1.84776];                  /* 4th-order Butterworth Q multipliers (x Q/.7071) */

  const BANDS = [
    { n: 1, type: "hp", name: "LOW CUT",    short: "HP", fmin: 20,   fmax: 1000,  f: 30,    q: SQ2, qmin: 0.3, qmax: 12, s: 12 },
    { n: 2, type: "ls", name: "LOW SHELF",  short: "LS", fmin: 20,   fmax: 2000,  f: 400,   q: SQ2, qmin: 0.3, qmax: 4 },
    { n: 3, type: "pk", name: "BELL 1",     short: "B1", fmin: 20,   fmax: 20000, f: 200,   q: 1,   qmin: 0.3, qmax: 12 },
    { n: 4, type: "pk", name: "BELL 2",     short: "B2", fmin: 20,   fmax: 20000, f: 1000,  q: 1,   qmin: 0.3, qmax: 12 },
    { n: 5, type: "pk", name: "BELL 3",     short: "B3", fmin: 20,   fmax: 20000, f: 3200,  q: 1,   qmin: 0.3, qmax: 12 },
    { n: 6, type: "pk", name: "BELL 4",     short: "B4", fmin: 20,   fmax: 20000, f: 7500,  q: 1,   qmin: 0.3, qmax: 12 },
    { n: 7, type: "hs", name: "HIGH SHELF", short: "HS", fmin: 1000, fmax: 20000, f: 2500,  q: SQ2, qmin: 0.3, qmax: 4 },
    { n: 8, type: "lp", name: "HIGH CUT",   short: "LP", fmin: 1000, fmax: 20000, f: 18000, q: SQ2, qmin: 0.3, qmax: 12, s: 12 },
  ];
  const GMAX = 18;
  const isCut = (b) => b.type === "hp" || b.type === "lp";
  const key = (n, k) => "e" + n + k;               /* e2f, e2g, e2q, e2on, e1s */

  function bandDefaults() {
    const o = {};
    BANDS.forEach((b) => {
      o[key(b.n, "on")] = false; o[key(b.n, "f")] = b.f; o[key(b.n, "q")] = b.q;
      if (isCut(b)) o[key(b.n, "s")] = b.s; else o[key(b.n, "g")] = 0;
    });
    return o;
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* RBJ cookbook biquad -> [b0,b1,b2,a1,a2] (a0 normalised). Gain bands use Q-form shelves. */
  function coef(type, f, g, q, sr) {
    f = clamp(f, 5, sr * 0.46);
    const w0 = (2 * Math.PI * f) / sr, cs = Math.cos(w0), sn = Math.sin(w0), al = sn / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === "hp") { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else if (type === "lp") { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else {
      const A = Math.pow(10, g / 40);
      if (type === "pk") { b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; }
      else {
        const sq = 2 * Math.sqrt(A) * al;
        if (type === "ls") {
          b0 = A * ((A + 1) - (A - 1) * cs + sq); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - sq);
          a0 = (A + 1) + (A - 1) * cs + sq; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - sq;
        } else {
          b0 = A * ((A + 1) + (A - 1) * cs + sq); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - sq);
          a0 = (A + 1) - (A - 1) * cs + sq; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - sq;
        }
      }
    }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  /* the (up to two) sections of one band for settled / smoothed values. sl: 0 = 12 dB, 1 = 24 dB */
  function sections(type, f, g, q, sl, sr, out) {
    if (type === "hp" || type === "lp") {
      const qa = q * (1 - sl * (1 - HPQ[0]));
      const A = coef(type, f, 0, qa, sr);
      const Bc = coef(type, f, 0, q * HPQ[1], sr);
      /* section B fades to a unity pass-through as the slope falls to 12 dB (stable: the stability triangle is convex) */
      out[0] = A;
      out[1] = [Bc[0] * sl + (1 - sl), Bc[1] * sl, Bc[2] * sl, Bc[3] * sl, Bc[4] * sl];
      return 2;
    }
    out[0] = coef(type, f, g, q, sr);
    return 1;
  }
  const magSq = (c, w) => {
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = c[0] + c[1] * c1 + c[2] * c2, ni = -(c[1] * s1 + c[2] * s2);
    const dr = 1 + c[3] * c1 + c[4] * c2, di = -(c[3] * s1 + c[4] * s2);
    return (nr * nr + ni * ni) / (dr * dr + di * di);
  };

  /* is a band doing anything? (gain bands: on AND non-zero gain; cuts: on) */
  function bandActive(p, b) {
    if (!p[key(b.n, "on")]) return false;
    return isCut(b) ? true : Math.abs(p[key(b.n, "g")] || 0) > 0.005;
  }
  function isActive(p) { return p.eqOn !== false && BANDS.some((b) => bandActive(p, b)); }

  /* combined (or single-band) response in dB, analytic, from the same coefficients the audio uses */
  function responseDb(p, freqs, sr, only) {
    sr = sr || 48000;
    const secs = [];
    const list = [];
    BANDS.forEach((b) => {
      if (only && b.n !== only) return;
      if (!only && !bandActive(p, b)) return;
      const g = isCut(b) ? 0 : p[key(b.n, "g")] || 0;
      const sl = isCut(b) && p[key(b.n, "s")] === 24 ? 1 : 0;
      const k = sections(b.type, p[key(b.n, "f")], g, p[key(b.n, "q")], sl, sr, secs);
      list.push(secs.slice(0, k));
    });
    return freqs.map((f) => {
      const w = (2 * Math.PI * f) / sr;
      let db = 0;
      for (let i = 0; i < list.length; i++) for (let j = 0; j < list[i].length; j++) db += 10 * Math.log10(magSq(list[i][j], w));
      return db;
    });
  }
  /* one band, arbitrary (possibly mid-glide) values, fractional slope: used by the animated curve */
  function bandDb(type, f, g, q, sl, sr, freqs) {
    const secs = [], k = sections(type, f, g, q, sl, sr, secs);
    return freqs.map((fr) => {
      const w = (2 * Math.PI * fr) / sr;
      let db = 0;
      for (let j = 0; j < k; j++) db += 10 * Math.log10(magSq(secs[j], w));
      return db;
    });
  }

  /* ── migration of the old 3-band strain EQ (400 Hz low shelf / 1 kHz peak Q.8 / 2.5 kHz high shelf) ── */
  function strainBands(lo, mid, hi) {
    const o = bandDefaults();
    if (lo) { o.e2on = true; o.e2g = lo; }
    if (mid) { o.e4on = true; o.e4g = mid; o.e4q = 0.8; }
    if (hi) { o.e7on = true; o.e7g = hi; }
    return o;
  }

  /* ── presets (independent of strains) ──  [freq, gain, Q, slope?]  every unlisted band is flat / off */
  const PRESETS = [
    { id: "flat", name: "Flat", bands: {} },
    { id: "warm", name: "Warm Low End", bands: { 1: [30, 0, SQ2, 12], 2: [140, 3.5, 0.7], 3: [260, 2, 0.9], 7: [7000, -3, SQ2] } },
    { id: "sub", name: "Sub Boost", bands: { 1: [24, 0, 0.8, 24], 2: [60, 6, 0.8], 3: [95, 2, 1.2], 4: [400, -1.5, 1] } },
    { id: "mud", name: "Mud Cut", bands: { 1: [30, 0, SQ2, 12], 3: [280, -4.5, 1.4], 4: [480, -2.5, 1.8] } },
    { id: "vocal", name: "Vocal Presence", bands: { 1: [90, 0, SQ2, 12], 3: [220, -2, 1], 5: [3000, 3.5, 1.1], 6: [5500, 2, 1.4], 7: [11000, 1.5, SQ2] } },
    { id: "air", name: "Air", bands: { 1: [30, 0, SQ2, 12], 6: [14000, 2, 0.8], 7: [10000, 4.5, SQ2] } },
    { id: "tel", name: "Telephone", bands: { 1: [400, 0, 0.9, 24], 4: [1500, 4, 1.2], 8: [3400, 0, 0.9, 24] } },
    { id: "am", name: "AM Radio", bands: { 1: [300, 0, 0.9, 24], 4: [2000, 5, 0.9], 8: [5000, 0, 0.9, 24] } },
    { id: "lofi", name: "Lo-Fi Tape", bands: { 1: [50, 0, SQ2, 12], 2: [100, 2, SQ2], 5: [3500, 1.5, 0.8], 7: [7000, -4, SQ2], 8: [12000, 0, SQ2, 12] } },
    { id: "dark", name: "Dark Room", bands: { 6: [5000, -2, 0.8], 7: [3000, -6, SQ2], 8: [9000, 0, SQ2, 12] } },
    { id: "smile", name: "Smiley", bands: { 2: [100, 5, SQ2], 4: [800, -3.5, 0.9], 7: [6000, 5, SQ2] } },
    { id: "808", name: "808 Focus", bands: { 1: [28, 0, 0.8, 24], 2: [55, 5, 0.9], 3: [140, -3, 1.5], 5: [2500, 1.5, 1], 7: [9000, -3, SQ2] } },
  ];
  function presetBands(pr) {
    const o = bandDefaults();
    BANDS.forEach((b) => {
      const v = pr.bands[b.n]; if (!v) return;
      o[key(b.n, "on")] = true; o[key(b.n, "f")] = v[0]; o[key(b.n, "q")] = v[2];
      if (isCut(b)) o[key(b.n, "s")] = v[3] || 12; else o[key(b.n, "g")] = v[1];
    });
    return o;
  }
  /* same effective sound? (flat bands are all equal, whatever their stored f / q) */
  function sameBands(a, b) {
    const near = (x, y, r) => Math.abs(x - y) <= r;
    return BANDS.every((bd) => {
      const ea = bandActive(a, bd), eb = bandActive(b, bd);
      if (!ea || !eb) return ea === eb;
      return near(Math.log(a[key(bd.n, "f")] / b[key(bd.n, "f")]), 0, 0.004) && near(Math.log(a[key(bd.n, "q")] / b[key(bd.n, "q")]), 0, 0.006) &&
        (isCut(bd) ? a[key(bd.n, "s")] === b[key(bd.n, "s")] : near(a[key(bd.n, "g")], b[key(bd.n, "g")], 0.01));
    });
  }

  /* ── audio: the AudioWorklet node (with a native-biquad fallback for browsers without AudioWorklet) ── */
  const SRC = typeof document !== "undefined" && document.currentScript && document.currentScript.src;
  const loaded = new WeakMap();
  function load(ctx) {
    if (!ctx || !ctx.audioWorklet || !SRC) return Promise.resolve(false);
    if (!loaded.has(ctx)) {
      loaded.set(ctx, ctx.audioWorklet.addModule(SRC).then(() => { ctx.__hsEq = true; return true; }, () => false));
    }
    return loaded.get(ctx);
  }
  const PKEYS = [];
  BANDS.forEach((b) => { PKEYS.push("f" + b.n, "q" + b.n); if (isCut(b)) PKEYS.push("m" + b.n, "s" + b.n); else PKEYS.push("g" + b.n); });

  /* parameter targets for the processor from the app params */
  function targets(p) {
    const on = p.eqOn !== false, t = {};
    BANDS.forEach((b) => {
      const n = b.n, bon = on && !!p[key(n, "on")];
      t["f" + n] = clamp(p[key(n, "f")], b.fmin, b.fmax); t["q" + n] = clamp(p[key(n, "q")], b.qmin, b.qmax);
      if (isCut(b)) { t["m" + n] = bon ? 1 : 0; t["s" + n] = p[key(n, "s")] === 24 ? 1 : 0; }
      else t["g" + n] = bon ? clamp(p[key(n, "g")] || 0, -GMAX, GMAX) : 0;
    });
    return t;
  }

  function create(ctx) {
    const mkNum = (set) => (p, smooth) => { const t = targets(p); for (const k in t) set(k, t[k], smooth); };
    if (ctx.__hsEq && typeof AudioWorkletNode !== "undefined") {
      const node = new AudioWorkletNode(ctx, "halfscrew-eq", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit" });
      const last = {};
      const set = (k, v, smooth) => {
        const prm = node.parameters.get(k);
        if (!smooth) { prm.value = v; last[k] = v; return; }
        if (last[k] === v) return;
        last[k] = v;
        const t = ctx.currentTime;
        prm.cancelScheduledValues(t);
        prm.setTargetAtTime(v, t, smooth);
      };
      return { kind: "worklet", input: node, output: node, apply: mkNum(set) };
    }
    /* fallback: native biquads (shelf Q is fixed by the browser; cuts are 12 dB) */
    const mk = (type) => { const b = ctx.createBiquadFilter(); b.type = type; return b; };
    const nodes = BANDS.map((b) => mk({ hp: "highpass", lp: "lowpass", ls: "lowshelf", hs: "highshelf", pk: "peaking" }[b.type]));
    nodes.reduce((a, b) => { a.connect(b); return b; });
    const input = ctx.createGain(); input.connect(nodes[0]);
    const set = (k, v, smooth) => {
      const n = +k.slice(1), nd = nodes[n - 1], b = BANDS[n - 1], c = k[0];
      let prm = null, val = v;
      if (c === "f") { prm = nd.frequency; if (isCut(b)) val = null; }
      else if (c === "g") prm = nd.gain;
      else if (c === "q") { prm = nd.Q; if (b.type === "ls" || b.type === "hs") val = null; else if (isCut(b)) val = 20 * Math.log10(v); }
      else if (c === "m") { nd.__m = v; }
      if (!prm || val === null) return;
      if (smooth) { prm.cancelScheduledValues(ctx.currentTime); prm.setTargetAtTime(val, ctx.currentTime, smooth); } else prm.value = val;
    };
    const apply = (p, smooth) => {
      const t = targets(p);
      for (const k in t) set(k, t[k], smooth);
      [1, 8].forEach((n) => { /* cuts: bypass by parking the corner out of the way */
        const nd = nodes[n - 1], b = BANDS[n - 1], on = t["m" + n] > 0.5;
        const f = on ? t["f" + n] : (n === 1 ? 5 : ctx.sampleRate * 0.45);
        if (smooth) { nd.frequency.cancelScheduledValues(ctx.currentTime); nd.frequency.setTargetAtTime(f, ctx.currentTime, smooth); } else nd.frequency.value = f;
      });
    };
    return { kind: "native", input, output: nodes[nodes.length - 1], apply };
  }

  const api = { BANDS, BAND_KEYS: key, GMAX, SQ2, PRESETS, bandDefaults, coef, sections, responseDb, bandDb, isActive, bandActive, isCut, strainBands, presetBands, sameBands, targets, load, create, PKEYS };
  root.HSEQ = api;

  /* ── the processor (worklet scope only) ── */
  if (typeof registerProcessor === "function" && typeof AudioWorkletProcessor !== "undefined") {
    const NB = BANDS.length;
    const descriptors = [];
    BANDS.forEach((b) => {
      descriptors.push({ name: "f" + b.n, defaultValue: b.f, minValue: 5, maxValue: 24000, automationRate: "k-rate" });
      descriptors.push({ name: "q" + b.n, defaultValue: b.q, minValue: 0.1, maxValue: 40, automationRate: "k-rate" });
      if (isCut(b)) {
        descriptors.push({ name: "m" + b.n, defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" });
        descriptors.push({ name: "s" + b.n, defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" });
      } else descriptors.push({ name: "g" + b.n, defaultValue: 0, minValue: -40, maxValue: 40, automationRate: "k-rate" });
    });
    const SLICE = 16;
    class EQProcessor extends AudioWorkletProcessor {
      static get parameterDescriptors() { return descriptors; }
      constructor() {
        super();
        this.k = 1 - Math.exp(-SLICE / (0.006 * sampleRate));   /* extra 6 ms smoothing on top of the AudioParam glide */
        this.cur = null;                                          /* smoothed: lf, g, lq, m, sl per band */
        this.z = [new Float64Array(NB * 2 * 2), new Float64Array(NB * 2 * 2)];
        this.c = new Float64Array(NB * 2 * 5);                    /* coefficient table: band, section, 5 */
        this.nsec = new Uint8Array(NB);                           /* 0 = bypassed */
        this.tmp = [];
      }
      process(inputs, outputs, P) {
        const out = outputs[0], inp = inputs[0];
        if (!out || !out.length) return true;
        const sr = sampleRate, len = out[0].length, nch = out.length;
        while (this.z.length < nch) this.z.push(new Float64Array(NB * 2 * 2));
        const tg = [];                                            /* targets, read at the top of each quantum */
        for (let i = 0; i < NB; i++) {
          const b = BANDS[i], n = b.n, cut = isCut(b);
          tg.push([Math.log(P["f" + n][0]), cut ? 0 : P["g" + n][0], Math.log(P["q" + n][0]), cut ? P["m" + n][0] : 1, cut ? P["s" + n][0] : 0]);
        }
        if (!this.cur) this.cur = tg.map((a) => a.slice());       /* first block: snap (offline render starts settled) */
        const cur = this.cur, k = this.k, tmp = this.tmp, c = this.c, nsec = this.nsec;
        for (let s0 = 0; s0 < len; s0 += SLICE) {
          const s1 = Math.min(len, s0 + SLICE);
          for (let i = 0; i < NB; i++) {
            const a = cur[i], t = tg[i], b = BANDS[i], cut = isCut(b);
            for (let j = 0; j < 5; j++) a[j] += (t[j] - a[j]) * k;
            let live;
            if (cut) live = a[3] > 1e-4 || t[3] > 1e-4; else live = Math.abs(a[1]) > 1e-3 || Math.abs(t[1]) > 1e-3;
            if (!live) { if (nsec[i]) { nsec[i] = 0; for (let ch = 0; ch < nch; ch++) this.z[ch].fill(0, i * 4, i * 4 + 4); } continue; }
            const ns = sections(b.type, Math.exp(a[0]), a[1], Math.exp(a[2]), a[4], sr, tmp);
            nsec[i] = ns;
            for (let q = 0; q < ns; q++) for (let j = 0; j < 5; j++) c[(i * 2 + q) * 5 + j] = tmp[q][j];
          }
          for (let ch = 0; ch < nch; ch++) {
            const o = out[ch], x = inp && inp.length ? inp[Math.min(ch, inp.length - 1)] : null, z = this.z[ch];
            for (let s = s0; s < s1; s++) {
              let v = x ? x[s] : 0;
              for (let i = 0; i < NB; i++) {
                const ns = nsec[i]; if (!ns) continue;
                const x0 = v; let y = x0;
                for (let q = 0; q < ns; q++) {
                  const ci = (i * 2 + q) * 5, zi = i * 4 + q * 2;
                  const yy = c[ci] * y + z[zi];
                  z[zi] = c[ci + 1] * y - c[ci + 3] * yy + z[zi + 1];
                  z[zi + 1] = c[ci + 2] * y - c[ci + 4] * yy;
                  y = yy;
                }
                v = isCut(BANDS[i]) ? x0 + cur[i][3] * (y - x0) : y;
              }
              o[s] = v;
            }
          }
        }
        return true;
      }
    }
    registerProcessor("halfscrew-eq", EQProcessor);
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
