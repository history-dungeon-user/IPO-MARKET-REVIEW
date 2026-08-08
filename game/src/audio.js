// SKYWARD — fully procedural WebAudio. Climbing the stairs *performs* music:
// each step advances a looping pentatonic melody, turns become accented beats,
// and the arrangement (bass, hats, shimmer) builds with the combo. No files.

// C-major pentatonic phrase (semitone offsets from a root), a 24-note motif with
// a rising/falling contour that resolves back home so any tap-sequence loops nicely.
// Notes: C D E G A  across ~2 octaves. No 4th/7th => nothing ever clashes.
const PENTA = [0, 2, 4, 7, 9, 12, 14, 12, 9, 7, 9, 12,
               16, 14, 12, 9, 7, 4, 2, 4, 7, 9, 4, 0];
// Slow chord progression (root semitone offsets): I - vi - IV - V, advances by step.
const PROG = [0, 9, 5, 7];
const ROOT = 130.81; // C3

export class Audio {
  constructor() {
    this.ctx = null; this.master = null; this.ready = false;
    this.muted = false;
    this.melIdx = 0;   // position in the melodic phrase
    this.harmIdx = 0;  // position in the chord progression
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();

    // Master chain: bus -> soft-clip (waveshaper) -> master gain -> destination.
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.shaper = this.ctx.createWaveShaper();
    this.shaper.curve = this._softClipCurve();
    this.shaper.oversample = '2x';
    this.bus = this.ctx.createGain();
    this.bus.gain.value = 1.0;
    this.bus.connect(this.shaper); this.shaper.connect(this.master);
    this.master.connect(this.ctx.destination);

    // Shared reverb/space send: feedback delay -> lowpass -> into the bus.
    this.spaceSend = this.ctx.createGain(); this.spaceSend.gain.value = 0.0;
    const delay = this.ctx.createDelay(1.0); delay.delayTime.value = 0.26;
    const fb = this.ctx.createGain(); fb.gain.value = 0.42;
    const damp = this.ctx.createBiquadFilter(); damp.type = 'lowpass'; damp.frequency.value = 2600;
    this.spaceSend.connect(delay); delay.connect(damp); damp.connect(fb);
    fb.connect(delay); damp.connect(this.bus);

    this.ready = true;
    this._startPad();
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  // Gentle tanh-ish soft clip so heavy stacking never harshly clips.
  _softClipCurve() {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * 1.6); }
    return c;
  }

  // One plucked voice: osc -> gain (fast attack, exp decay) -> dest (+ space send).
  _voice(type, freq, t0, dur, gain, dest, detune = 0, space = 0) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type; o.frequency.value = freq; o.detune.value = detune;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(dest || this.bus);
    if (space > 0) { const s = this.ctx.createGain(); s.gain.value = space; g.connect(s); s.connect(this.spaceSend); }
    o.start(t0); o.stop(t0 + dur + 0.03);
    return o;
  }

  // Duck the pad a touch on each note so the melody sits on top, then recover.
  _duckPad(t) {
    if (!this.padGain) return;
    const base = this._padLevel;
    this.padGain.gain.cancelScheduledValues(t);
    this.padGain.gain.setValueAtTime(this.padGain.gain.value, t);
    this.padGain.gain.linearRampToValueAtTime(base * 0.6, t + 0.04);
    this.padGain.gain.linearRampToValueAtTime(base, t + 0.5);
  }

  // Main musical driver — one note per step, accented on turns, layered by combo.
  step(combo, info = {}) {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    const turned = !!info.turned;
    const score = info.score || 0;

    // Melody note from the looping phrase.
    const semi = PENTA[this.melIdx % PENTA.length];
    this.melIdx++;
    // Current chord root (progression advances slowly with score).
    this.harmIdx = Math.floor(score / 4) % PROG.length;
    const chordRoot = PROG[this.harmIdx];
    const freq = ROOT * Math.pow(2, (semi + 12) / 12); // melody an octave up over the bass

    // Turn = emphasized beat: longer, louder, richer (add a fifth + octave), more space.
    // Straight step = short, light pluck.
    if (turned) {
      const g = 0.30, dur = 0.55, sp = 0.35;
      this._voice('triangle', freq, t, dur, g, this.bus, -6, sp);
      this._voice('triangle', freq, t, dur, g * 0.9, this.bus, +7, sp);
      this._voice('sine', freq * 1.5, t, dur * 0.8, g * 0.5, this.bus, 0, sp); // fifth
      this._voice('sine', freq * 2, t, dur * 0.6, g * 0.35, this.bus, 0, sp);  // octave
    } else {
      const g = 0.20, dur = 0.26, sp = combo > 8 ? 0.18 : 0.08;
      this._voice('triangle', freq, t, dur, g, this.bus, -4, sp);
      this._voice('sine', freq * 2, t, dur * 0.7, g * 0.4, this.bus, 0, sp * 0.5);
    }
    this._duckPad(t);

    // --- Progressive arrangement, gated on combo ---
    // Soft bass note every 4 steps: the current chord's root, low and mellow.
    if (score % 4 === 0) {
      this._voice('sine', ROOT * Math.pow(2, chordRoot / 12) * 0.5, t, 0.7,
                  0.22, this.bus, 0, 0.05);
    }
    // Gentle percussion pulse once combo climbs: a filtered-noise hat.
    if (combo >= 6) this._hat(t, combo >= 16 ? 0.10 : 0.06);
    // Soft kick on the beat at higher combos to anchor the groove.
    if (combo >= 12 && score % 2 === 0) this._kick(t, 0.16);
    // More reverb space as the combo grows.
    if (combo >= 20) this.spaceSend.gain.setTargetAtTime(0.28, t, 0.5);
  }

  // Filtered white-noise hat, very short — sits under the melody.
  _hat(t, gain) {
    const src = this.ctx.createBufferSource();
    const buf = this.ctx.createBuffer(1, 0.05 * this.ctx.sampleRate, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    src.buffer = buf;
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(hp); hp.connect(g); g.connect(this.bus);
    src.start(t); src.stop(t + 0.06);
  }

  // Soft sine kick.
  _kick(t, gain) {
    const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g); g.connect(this.bus); o.start(t); o.stop(t + 0.18);
  }

  // Subtle footstep tick on landing — kept quiet so it doesn't fight the melody.
  land() {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(65, t + 0.1);
    g.gain.setValueAtTime(0.1, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g); g.connect(this.bus); o.start(t); o.stop(t + 0.14);
  }

  // Kept for backward-compat; real turn emphasis now flows through step(info.turned).
  // Tiny bright accent, harmless if called directly.
  turn() {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    this._voice('sine', ROOT * 8, t, 0.08, 0.06, this.bus, 0, 0.2);
  }

  // Every 10 combo — a satisfying ascending pentatonic arpeggio swell with space.
  milestone() {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    [0, 4, 7, 9, 12, 16].forEach((s, k) => {
      const f = ROOT * 2 * Math.pow(2, s / 12);
      this._voice('triangle', f, t + k * 0.06, 0.5, 0.16, this.bus, 0, 0.4);
      this._voice('sine', f * 2, t + k * 0.06, 0.35, 0.06, this.bus, 0, 0.3);
    });
    this.spaceSend.gain.setTargetAtTime(0.3, t, 0.2);
  }

  // "You fell" — descending sweep; duck & stop the music bed.
  fail() {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(380, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.6);
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1400;
    f.frequency.exponentialRampToValueAtTime(200, t + 0.6);
    g.gain.setValueAtTime(0.24, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
    o.connect(f); f.connect(g); g.connect(this.bus); o.start(t); o.stop(t + 0.7);
    // Reset the performance and duck the bed.
    this.melIdx = 0; this.harmIdx = 0;
    if (this.padGain) {
      this.padGain.gain.cancelScheduledValues(t);
      this.padGain.gain.setValueAtTime(this.padGain.gain.value, t);
      this.padGain.gain.linearRampToValueAtTime(0.03, t + 0.5);
      this._padLevel = 0.03;
    }
    this.spaceSend.gain.setTargetAtTime(0.0, t, 0.3);
  }

  // Warm, slow, breathing pad bed under everything.
  _startPad() {
    const t = this.ctx.currentTime;
    this._padLevel = 0.0;
    this.padGain = this.ctx.createGain(); this.padGain.gain.value = 0.0;
    this.padGain.connect(this.bus);
    const filt = this.ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 700;
    filt.connect(this.padGain);
    // Slow filter LFO => the pad "breathes".
    const lfo = this.ctx.createOscillator(); const lfoG = this.ctx.createGain();
    lfo.frequency.value = 0.06; lfoG.gain.value = 280;
    lfo.connect(lfoG); lfoG.connect(filt.frequency); lfo.start(t);
    // Root-chord voicing (C - E - G - C) with a slightly detuned pair for warmth.
    [ROOT, ROOT * Math.pow(2, 4 / 12), ROOT * Math.pow(2, 7 / 12), ROOT * 2].forEach((f, i) => {
      const o = this.ctx.createOscillator(); o.type = i === 3 ? 'triangle' : 'sine';
      o.frequency.value = f; o.detune.value = (i % 2 ? 5 : -5);
      const g = this.ctx.createGain(); g.gain.value = i === 3 ? 0.05 : 0.11;
      o.connect(g); g.connect(filt); o.start(t);
    });
  }

  // Fade the ambient bed in (true) / down (false).
  setPad(on) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._padLevel = on ? 0.5 : 0.12;
    this.padGain.gain.cancelScheduledValues(t);
    this.padGain.gain.setValueAtTime(this.padGain.gain.value, t);
    this.padGain.gain.linearRampToValueAtTime(this._padLevel, t + 1.2);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }
}
