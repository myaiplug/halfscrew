/* HALFSCREW audio worklets.
   Requires halfscrew-dsp.js to be added to the same worklet scope first (shared DSP). */
const DSP = globalThis.HSDSP;

class HalfScrewProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = [];
    this.length = 0;
    this.pos = 0;
    this.playing = false;
    this.phase = 0;
    this.hq = true;
    this.fade = 0;            /* declick gain 0..1 */
    this.fadeTarget = 0;
    this.pendingSeek = null;
    this.ready = false;       /* smoothed params initialised */
    this.sRate = 1; this.sPitch = 0; this.sWow = 0;
    this.smoothCoef = 1 - Math.exp(-1 / (0.012 * sampleRate));
    this.fadeStep = 1 / Math.round(0.006 * sampleRate);
    this.reportIn = 0;
    this.stepAcc = 0; this.stepN = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === "file") {
        /* swap the audio only while silent (fade-out first) so a new track never clicks */
        if (!this.playing || this.fade <= 0) this.applyFile(d);
        else { this.pendingFile = d; this.fadeTarget = 0; }
      }
      if (d.type === "seek") {
        /* fade out, jump while silent, fade back in: no click on scrub / restart */
        this.pendingSeek = d.pos || 0;
        this.fadeTarget = 0;
        if (!this.playing) { this.pos = this.pendingSeek; this.pendingSeek = null; }
      }
      if (d.type === "play") {
        this.playing = true; this.stopping = false;
        if (this.pendingSeek === null && !this.pendingFile) this.fadeTarget = 1;
      }
      if (d.type === "stop") { this.fadeTarget = 0; this.stopping = true; }
      if (d.type === "hq") this.hq = !!d.on;
    };
  }
  applyFile(d) {
    this.channels = d.channels.map((c) => new Float32Array(c));
    this.length = this.channels[0] ? this.channels[0].length : 0;
    this.pos = 0;
  }
  static get parameterDescriptors() {
    return [
      { name: "rate", defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: "a-rate" },
      { name: "pitch", defaultValue: 0, minValue: -12, maxValue: 12, automationRate: "a-rate" },
      { name: "wow", defaultValue: 0.25, minValue: 0, maxValue: 1, automationRate: "a-rate" },
    ];
  }
  process(inputs, outputs, parameters) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const n = out[0].length;
    let len = this.length;
    if (!len && this.pendingFile && !this.playing) { this.applyFile(this.pendingFile); this.pendingFile = null; len = this.length; }
    if (!len || (!this.playing && this.fade <= 0)) {
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      return true;
    }
    const pr = parameters.rate, pp = parameters.pitch, pw = parameters.wow;
    let nch = this.channels.length;
    let ch0 = this.channels[0], ch1 = this.channels[Math.min(1, nch - 1)];
    const sm = this.smoothCoef;
    const w2 = (2 * Math.PI * 0.35) / sampleRate;
    if (!this.ready) {
      this.sRate = pr[0]; this.sPitch = pp[0]; this.sWow = pw[0]; this.ready = true;
    }
    for (let i = 0; i < n; i++) {
      /* per-sample smoothing of every control: no zipper / stair-steps */
      const tr = pr.length > 1 ? pr[i] : pr[0];
      const tp = pp.length > 1 ? pp[i] : pp[0];
      const tw = pw.length > 1 ? pw[i] : pw[0];
      this.sRate += (tr - this.sRate) * sm;
      this.sPitch += (tp - this.sPitch) * sm;
      this.sWow += (tw - this.sWow) * sm;

      /* declick fade (6 ms) */
      if (this.fade < this.fadeTarget) this.fade = Math.min(this.fadeTarget, this.fade + this.fadeStep);
      else if (this.fade > this.fadeTarget) this.fade = Math.max(this.fadeTarget, this.fade - this.fadeStep);
      if ((this.pendingSeek !== null || this.pendingFile) && this.fade <= 0) {
        if (this.pendingFile) {
          this.applyFile(this.pendingFile); this.pendingFile = null;
          len = this.length; nch = this.channels.length; ch0 = this.channels[0]; ch1 = this.channels[Math.min(1, nch - 1)];
        }
        if (this.pendingSeek !== null) { this.pos = this.pendingSeek; this.pendingSeek = null; }
        if (this.playing && !this.stopping) this.fadeTarget = 1;
      }
      if (this.stopping && this.fade <= 0) { this.playing = false; this.stopping = false; }

      const wobble = Math.sin(this.phase) * this.sWow * 0.45;
      const step = this.sRate * Math.pow(2, (this.sPitch + wobble) / 12);
      const i0 = Math.floor(this.pos);
      const f = this.pos - i0;
      const a = ((i0 % len) + len) % len;
      const b = (a + 1) % len;
      let l, r;
      if (this.hq) {
        const pm = (a - 1 + len) % len, nn = (a + 2) % len;
        l = DSP.hermite(ch0[pm], ch0[a], ch0[b], ch0[nn], f);
        r = nch > 1 ? DSP.hermite(ch1[pm], ch1[a], ch1[b], ch1[nn], f) : l;
      } else {
        l = ch0[a] * (1 - f) + ch0[b] * f;
        r = nch > 1 ? ch1[a] * (1 - f) + ch1[b] * f : l;
      }
      const g = this.fade;
      out[0][i] = l * g;
      if (out.length > 1) out[1][i] = r * g;
      for (let c = 2; c < out.length; c++) out[c][i] = (nch > c ? this.channels[c][a] : l) * g;

      if (this.playing) {
        this.pos += step;
        if (this.pos >= len) this.pos -= len;
        this.phase += w2;
        if (this.phase > 6.283185307179586) this.phase -= 6.283185307179586;
      }
      this.stepAcc += step; this.stepN++;
    }
    this.reportIn -= n;
    if (this.reportIn <= 0) {
      this.reportIn = 2048;
      this.port.postMessage({ type: "pos", pos: this.pos, step: this.stepAcc / Math.max(1, this.stepN), t: currentTime });
      this.stepAcc = 0; this.stepN = 0;
    }
    return true;
  }
}
registerProcessor("halfscrew-processor", HalfScrewProcessor);

/* safe output stage: look-ahead true-peak limiter, same class the export uses */
class HalfScrewLimiter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.lim = new DSP.Limiter(sampleRate, 2);
    this.rep = 0; this.minG = 1;
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!out || !out[0]) return true;
    const n = out[0].length;
    if (!inp || !inp[0]) { for (let c = 0; c < out.length; c++) out[c].fill(0); return true; }
    const g = this.lim.process(inp, out, n);
    if (g < this.minG) this.minG = g;
    this.rep += n;
    if (this.rep >= 2048) {
      this.port.postMessage({ type: "gr", gain: this.minG });
      this.rep = 0; this.minG = 1;
    }
    return true;
  }
}
registerProcessor("halfscrew-limiter", HalfScrewLimiter);
