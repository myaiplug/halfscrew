/* HALFSCREW — shared DSP (runs in the page AND inside the AudioWorklet).
   One source of truth so the live preview and the exported WAV use the
   exact same interpolation and the same output limiter. */
(function (root) {
  "use strict";

  /* 4-point Catmull-Rom (Hermite) interpolation. f in [0,1) between y1 and y2.
     At f = 0 it returns y1 exactly, so unity-speed audio passes through bit-exact. */
  function hermite(y0, y1, y2, y3, f) {
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * f + c2) * f + c1) * f + y1;
  }

  /* ITU-R BS.1770-style true-peak detector: 4x oversampling with a 32-tap windowed-sinc
     (Kaiser) interpolator per phase. TP_C[k-1][m] weights x[j+m-15], m = 0..31, for the
     point k/4 of the way from x[j] to x[j+1]. Peak of the whole interval = max |x|, |phase 1..3|. */
  const TP_TAPS = 32, TP_HALF = 16, TP_DET = 17;
  function bessel0(x) { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; } return s; }
  const TP_C = [1, 2, 3].map((k) => {
    const f = k / 4, c = new Float64Array(TP_TAPS), beta = 9, i0b = bessel0(beta);
    for (let m = 0; m < TP_TAPS; m++) {
      const d = m - (TP_HALF - 1) - f;                                   /* distance in samples from the output point */
      const sinc = Math.abs(d) < 1e-9 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const r = d / TP_HALF, w = Math.abs(r) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - r * r)) / i0b;
      c[m] = sinc * w;
    }
    return c;
  });

  /* Look-ahead brick-wall limiter with an inter-sample (true-peak) estimate.
     ceilingDb is the *internal* ceiling; it sits slightly under the -1 dBTP target
     so the estimate error of the cubic peak detector stays inside -1 dBTP.
     Latency: LOOKAHEAD_MS + 1 samples. Unity gain (bit-exact) whenever the
     signal is under the ceiling. */
  class Limiter {
    constructor(sampleRate, channels, opts) {
      opts = opts || {};
      this.sr = sampleRate;
      this.ch = channels;
      this.ceil = Math.pow(10, (opts.ceilingDb == null ? -1.3 : opts.ceilingDb) / 20);
      this.L = Math.max(8, Math.round(((opts.lookaheadMs || 5) / 1000) * sampleRate));
      this.W = 2 * this.L - 1;
      this.D = this.L + TP_DET - 1;              /* audio delay (samples): lookahead + detector latency */
      this.rel = 1 - Math.exp(-1 / ((opts.releaseMs || 90) / 1000 * sampleRate));
      this.latency = this.D;
      this.reset();
    }
    reset() {
      const ch = this.ch;
      this.hist = []; this.delay = [];
      for (let c = 0; c < ch; c++) {
        this.hist.push(new Float64Array(TP_TAPS));
        this.delay.push(new Float32Array(this.D));
      }
      this.dpos = 0;
      this.dqCap = this.W + 2;
      this.dqVal = new Float64Array(this.dqCap);
      this.dqIdx = new Float64Array(this.dqCap);
      this.dqHead = 0; this.dqLen = 0;
      this.avg = new Float64Array(this.L).fill(1);
      this.avgPos = 0; this.avgSum = this.L;
      this.n = 0;                                /* t-stream index */
      this.gr = 1;
      this.minGain = 1;
    }
    /* ins/outs: arrays of Float32Array (same length n). In-place is fine. */
    process(ins, outs, n) {
      const ch = this.ch, D = this.D, L = this.L, W = this.W, cap = this.dqCap;
      const ceil = this.ceil, rel = this.rel;
      let blockMin = 1;
      for (let i = 0; i < n; i++) {
        /* 1) push input; true-peak (4x oversampled) estimate of the interval (j, j+1), j = newest-(TP_DET-1) */
        let peak = 0;
        const th = ceil * 0.3;
        for (let c = 0; c < ch; c++) {
          const h = this.hist[c];
          for (let k = 0; k < TP_TAPS - 1; k++) h[k] = h[k + 1];
          h[TP_TAPS - 1] = ins[c < ins.length ? c : 0][i];
          const a = Math.abs(h[TP_HALF - 1]);
          if (a > peak) peak = a;
          /* cheap early-out: only oversample when the neighbourhood is already loud */
          let loud = 0;
          for (let k = TP_HALF - 4; k < TP_HALF + 4; k++) { const v = h[k] < 0 ? -h[k] : h[k]; if (v > loud) loud = v; }
          if (loud > th) {
            for (let k = 0; k < 3; k++) {
              const cf = TP_C[k];
              let y = 0;
              for (let m = 0; m < TP_TAPS; m++) y += cf[m] * h[m];
              if (y < 0) y = -y;
              if (y > peak) peak = y;
            }
          }
        }
        const t = peak > ceil ? ceil / peak : 1;
        /* 2) sliding minimum over W samples (monotonic deque) */
        const s = this.n++;
        while (this.dqLen > 0) {
          const last = (this.dqHead + this.dqLen - 1) % cap;
          if (this.dqVal[last] >= t) this.dqLen--; else break;
        }
        const tail = (this.dqHead + this.dqLen) % cap;
        this.dqVal[tail] = t; this.dqIdx[tail] = s; this.dqLen++;
        while (this.dqIdx[this.dqHead] <= s - W) { this.dqHead = (this.dqHead + 1) % cap; this.dqLen--; }
        const m = this.dqVal[this.dqHead];
        /* 3) moving average of the minimum (smooth attack, finishes before the peak) */
        this.avgSum += m - this.avg[this.avgPos];
        this.avg[this.avgPos] = m;
        this.avgPos = (this.avgPos + 1) % L;
        let g = this.avgSum / L;
        if (g > 1) g = 1;
        /* 4) release: never above g (instant follow down, slow recovery) */
        const r = this.gr + (1 - this.gr) * rel;
        this.gr = g < r ? g : r;
        if (this.gr < blockMin) blockMin = this.gr;
        /* 5) delayed audio * gain */
        const dp = this.dpos;
        for (let c = 0; c < ch; c++) {
          const d = this.delay[c];
          const x = d[dp];
          d[dp] = ins[c < ins.length ? c : 0][i];
          outs[c][i] = this.gr === 1 ? x : x * this.gr;
        }
        this.dpos = dp + 1 === D ? 0 : dp + 1;
      }
      this.minGain = blockMin;
      return blockMin;
    }
    /* Whole-buffer helper for export. Returns new Float32Arrays, same length. */
    processChannels(chans) {
      const n = chans[0].length, D = this.D, total = n + D;
      this.reset();
      const outs = chans.map(() => new Float32Array(n));
      const BLK = 4096;
      const inBlk = chans.map(() => new Float32Array(BLK));
      const outBlk = chans.map(() => new Float32Array(BLK));
      let w = 0, minG = 1;
      for (let p = 0; p < total; p += BLK) {
        const len = Math.min(BLK, total - p);
        for (let c = 0; c < chans.length; c++) {
          const ib = inBlk[c];
          for (let i = 0; i < len; i++) { const k = p + i; ib[i] = k < n ? chans[c][k] : 0; }
        }
        minG = Math.min(minG, this.process(inBlk, outBlk, len));
        for (let i = 0; i < len; i++) {
          const k = p + i - D;
          if (k >= 0 && k < n) for (let c = 0; c < chans.length; c++) outs[c][k] = outBlk[c][i];
        }
      }
      return { channels: outs, minGain: minG };
    }
  }

  const api = { hermite, Limiter };
  root.HSDSP = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
