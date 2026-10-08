class HalfScrewProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = [];
    this.length = 0;
    this.pos = 0;
    this.playing = false;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === "file") {
        this.channels = d.channels.map((c) => new Float32Array(c));
        this.length = this.channels[0] ? this.channels[0].length : 0;
      }
      if (d.type === "seek") this.pos = d.pos || 0;
      if (d.type === "play") this.playing = true;
      if (d.type === "stop") this.playing = false;
    };
  }
  static get parameterDescriptors() {
    return [
      { name: "rate", defaultValue: 0.5, minValue: 0.5, maxValue: 2 },
      { name: "pitch", defaultValue: 0, minValue: -12, maxValue: 12 },
      { name: "wow", defaultValue: 0.25, minValue: 0, maxValue: 1 },
    ];
  }
  process(inputs, outputs, parameters) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const n = out[0].length;
    if (!this.playing || !this.length) {
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      return true;
    }
    const rate = parameters.rate[0];
    const pitch = parameters.pitch[0];
    const wow = parameters.wow[0];
    const depth = wow * 0.45;
    for (let i = 0; i < n; i++) {
      const wobble = Math.sin(this.phase || 0) * depth;
      const step = rate * Math.pow(2, (pitch + wobble) / 12);
      const x = this.pos;
      const i0 = Math.floor(x);
      const f = x - i0;
      for (let c = 0; c < out.length; c++) {
        const ch = this.channels[Math.min(c, this.channels.length - 1)];
        const a = ch[((i0 % this.length) + this.length) % this.length] || 0;
        const b = ch[(((i0 + 1) % this.length) + this.length) % this.length] || 0;
        out[c][i] = a * (1 - f) + b * f;
      }
      this.pos += step;
      if (this.pos >= this.length) this.pos -= this.length;
      this.phase = (this.phase || 0) + (2 * Math.PI * 0.35) / sampleRate;
    }
    return true;
  }
}
registerProcessor("halfscrew-processor", HalfScrewProcessor);
