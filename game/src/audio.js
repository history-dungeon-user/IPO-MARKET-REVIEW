// Fully procedural WebAudio: pentatonic step tones that climb with the combo,
// a soft turn blip, a warm landing thump, a fail sweep, and a gentle ambient pad.
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

export class Audio {
  constructor() {
    this.ctx = null; this.master = null; this.ready = false;
    this.muted = false;
    this.comboIdx = 0;
  }
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    this.ready = true;
    this._startPad();
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  _env(type, freq, t0, dur, gain, dest) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(dest || this.master);
    o.start(t0); o.stop(t0 + dur + 0.02);
    return o;
  }

  step(combo) {
    if (!this.ready || this.muted) return;
    const t = this.ctx.now = this.ctx.currentTime;
    const idx = Math.min(PENTA.length - 1, combo);
    const semi = PENTA[idx];
    const base = 330 * Math.pow(2, semi / 12);
    this._env('triangle', base, t, 0.22, 0.28);
    this._env('sine', base * 2, t, 0.16, 0.10);
  }
  land() {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.14);
    g.gain.setValueAtTime(0.24, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.2);
  }
  turn() {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    this._env('sine', 880, t, 0.09, 0.09);
  }
  milestone() {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    [0, 4, 7, 12].forEach((s, k) => this._env('triangle', 440 * Math.pow(2, s/12), t + k*0.05, 0.3, 0.18));
  }
  fail() {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(380, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.5);
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1200;
    g.gain.setValueAtTime(0.22, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    o.connect(f); f.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.6);
  }

  _startPad() {
    // slow, breathing two-oscillator pad for atmosphere
    const t = this.ctx.currentTime;
    this.padGain = this.ctx.createGain(); this.padGain.gain.value = 0.0;
    this.padGain.connect(this.master);
    const filt = this.ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 700;
    filt.connect(this.padGain);
    const lfo = this.ctx.createOscillator(); const lfoG = this.ctx.createGain();
    lfo.frequency.value = 0.07; lfoG.gain.value = 260; lfo.connect(lfoG); lfoG.connect(filt.frequency); lfo.start(t);
    [110, 164.81, 220].forEach((f, i) => {
      const o = this.ctx.createOscillator(); o.type = i === 2 ? 'triangle' : 'sine';
      o.frequency.value = f; const g = this.ctx.createGain(); g.gain.value = i === 2 ? 0.05 : 0.12;
      o.connect(g); g.connect(filt); o.start(t);
    });
  }
  setPad(on) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.padGain.gain.cancelScheduledValues(t);
    this.padGain.gain.linearRampToValueAtTime(on ? 0.5 : 0.12, t + 1.2);
  }
  toggleMute() { this.muted = !this.muted; if (this.master) this.master.gain.value = this.muted ? 0 : 0.5; return this.muted; }
}
