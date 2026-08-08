// SKYWARD — fully procedural WebAudio, now a RHYTHM GAME. A continuous fixed-tempo
// SONG plays on its own clock (a lookahead scheduler running the backing track), and
// the player's taps become melodic ACCENTS layered on top. The staircase is laid out
// on the same beat grid (see config.RHYTHM / rhythmFlip), so this module also exposes
// the beat clock the rest of the game syncs to. No files — all synthesized.
import { RHYTHM, rhythmFlip } from './config.js';

// C-major pentatonic phrase (semitone offsets from a root), a 24-note motif with a
// rising/falling contour. Notes: C D E G A across ~2 octaves. No 4th/7th => never clashes.
const PENTA = [0, 2, 4, 7, 9, 12, 14, 12, 9, 7, 9, 12,
               16, 14, 12, 9, 7, 4, 2, 4, 7, 9, 4, 0];
// A gentle pentatonic arp line for the song's lead (one note per 8th note).
const LEAD = [12, 16, 19, 16, 14, 12, 9, 12, 16, 14, 12, 9, 7, 9, 12, 9];
// Slow chord progression (root semitone offsets): I - vi - IV - V. Advances per bar.
const PROG = [0, 9, 5, 7];
const ROOT = 130.81; // C3

export class Audio {
  constructor() {
    this.ctx = null; this.master = null; this.ready = false;
    this.muted = false;
    this.melIdx = 0;    // position in the player's tap-accent phrase

    // --- Transport / beat clock ---
    this.running = false;       // is the song playing?
    this.transportStart = 0;    // ctx time the transport was stamped at
    this.stepCounter = 0;       // running 16th-note index since start
    this.nextStepTime = 0;      // ctx time of the next 16th to schedule
    this._sched = null;         // setInterval handle for the lookahead loop
    this.beatDur = 60 / RHYTHM.bpm;
    this.stepDur = this.beatDur / 4; // one 16th note
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
    this.spaceSend = this.ctx.createGain(); this.spaceSend.gain.value = 0.18;
    const delay = this.ctx.createDelay(1.0); delay.delayTime.value = 0.26;
    const fb = this.ctx.createGain(); fb.gain.value = 0.42;
    const damp = this.ctx.createBiquadFilter(); damp.type = 'lowpass'; damp.frequency.value = 2600;
    this.spaceSend.connect(delay); delay.connect(damp); damp.connect(fb);
    fb.connect(delay); damp.connect(this.bus);

    // Song bus: the whole backing track fades in/out here (silent until setPad(true)).
    this.songGain = this.ctx.createGain(); this.songGain.gain.value = 0.0001;
    this.songGain.connect(this.bus);
    this._songLevel = 0.0;

    // Warm, slow, breathing pad bed — a layer of the song, lives under songGain.
    this._startPad();

    this.ready = true;
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

  // ======================= TRANSPORT + BEAT CLOCK =========================

  // Start the song's own clock (independent of taps). Aligned to a small lookahead.
  _startTransport() {
    if (this.running || !this.ready) return;
    const t0 = this.ctx.currentTime + 0.1; // small lookahead so the first hit isn't late
    this.transportStart = t0;
    this.stepCounter = 0;
    this.nextStepTime = t0;
    this.running = true;
    this._sched = setInterval(() => this._scheduler(), 25); // ~25ms lookahead loop
  }

  _stopTransport() {
    this.running = false;
    if (this._sched) { clearInterval(this._sched); this._sched = null; }
  }

  // Lookahead scheduler: queue every 16th-note event up to ~120ms ahead of the clock.
  _scheduler() {
    if (!this.running) return;
    const horizon = this.ctx.currentTime + 0.12;
    while (this.nextStepTime < horizon) {
      this._scheduleStep(this.stepCounter, this.nextStepTime);
      this.stepCounter++;
      this.nextStepTime += this.stepDur;
    }
  }

  // The arrangement, evaluated per 16th note. Section (motif) advances every
  // RHYTHM.sectionSteps steps; accents land on that section pattern's `1` positions.
  _scheduleStep(step, t) {
    const secLen = RHYTHM.sectionSteps;
    const bar = Math.floor(step / secLen);
    const sec = bar % RHYTHM.patterns.length;      // which motif is playing now
    const pos = step % secLen;                     // 0..15 within the bar
    const accent = RHYTHM.patterns[sec][pos] === 1; // "turn" grid position
    const song = this.songGain;

    // Chord for this bar (progression walks I - vi - IV - V, one chord per bar).
    const chordSemi = PROG[bar % PROG.length];
    const chordF = ROOT * Math.pow(2, chordSemi / 12);

    // --- Drums: four-on-the-floor kick, backbeat snare, running hats ---
    if (pos % 4 === 0) this._kick(t, 0.17, song);        // beats 1..4
    if (pos === 4 || pos === 12) this._snare(t, 0.12, song); // backbeat
    if (pos % 2 === 0) this._hat(t, accent ? 0.07 : 0.045, accent, song); // 8th-note hats, open on accents

    // --- Bass: low root on the downbeats, a pentatonic passing note before the bar turns ---
    if (pos === 0 || pos === 8) this._voice('sine', chordF * 0.5, t, 0.5, 0.22, song, 0, 0.04);
    if (pos === 14) {
      const nextSemi = PROG[(bar + 1) % PROG.length];
      this._voice('sine', ROOT * Math.pow(2, nextSemi / 12) * 0.5, t, 0.22, 0.16, song, 0, 0.03);
    }

    // --- Chord-pad stabs (root + fifth + octave => neutral, never a wrong 3rd) on beats 1 & 3 ---
    if (pos === 0 || pos === 8) {
      this._voice('triangle', chordF, t, 0.32, 0.10, song, -6, 0.12);
      this._voice('sine', chordF * 1.5, t, 0.30, 0.06, song, 0, 0.12);
      this._voice('sine', chordF * 2, t, 0.26, 0.05, song, 0, 0.12);
    }

    // --- Gentle lead arp: one pentatonic note per 8th, brighter/longer on accents (the "fills") ---
    if (pos % 2 === 0) {
      const semi = LEAD[(step / 2) % LEAD.length | 0] ?? 12;
      const f = ROOT * Math.pow(2, semi / 12);
      if (accent) {
        this._voice('triangle', f, t, 0.42, 0.14, song, -4, 0.4);
        this._voice('sine', f * 2, t, 0.30, 0.06, song, 0, 0.32); // shimmer octave on the turn
      } else {
        this._voice('triangle', f, t, 0.20, 0.07, song, -3, 0.14);
      }
    }
  }

  // beatPhase — fractional position within the current beat, in [0,1). 0 = on a beat.
  beatPhase() {
    if (!this.running) return 0;
    const e = this.ctx.currentTime - this.transportStart;
    if (e <= 0) return 0;
    return ((e % this.beatDur) + this.beatDur) % this.beatDur / this.beatDur;
  }

  // nearestBeatError — signed seconds from now to the nearest beat (0 = dead on).
  nearestBeatError() {
    if (!this.running) return 999;
    const e = this.ctx.currentTime - this.transportStart;
    const beats = e / this.beatDur;
    return (beats - Math.round(beats)) * this.beatDur;
  }

  // beatCount — whole beats elapsed since the transport started.
  beatCount() {
    if (!this.running) return 0;
    const e = this.ctx.currentTime - this.transportStart;
    return e <= 0 ? 0 : Math.floor(e / this.beatDur);
  }

  // ======================= PLAYER TAP ACCENT ==============================

  // step() is the per-tap ACCENT — a melodic pluck layered over the self-playing song.
  // It does NOT advance the song (the transport owns tempo). info.grade shapes it.
  step(combo, info = {}) {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    const turned = !!info.turned;
    const grade = info.grade || 'good';

    // Accent note from the looping pentatonic phrase, an octave over the bass.
    const semi = PENTA[this.melIdx % PENTA.length];
    this.melIdx++;
    const freq = ROOT * Math.pow(2, (semi + 12) / 12);

    // Grade shapes brightness / length / reverb: perfect = rich & long, off = dull & short.
    let g, dur, sp, rich;
    if (grade === 'perfect') { g = 0.26; dur = 0.52; sp = 0.42; rich = 2; }
    else if (grade === 'off') { g = 0.14; dur = 0.16; sp = 0.05; rich = 0; }
    else { g = 0.20; dur = 0.28; sp = 0.18; rich = 1; } // 'good'
    if (turned) { g *= 1.15; dur *= 1.18; sp = Math.min(0.5, sp + 0.1); } // turns a touch bigger

    this._voice('triangle', freq, t, dur, g, this.bus, turned ? -6 : -4, sp);
    if (rich >= 2) {
      this._voice('sine', freq * 1.5, t, dur * 0.8, g * 0.5, this.bus, 0, sp);   // fifth
      this._voice('sine', freq * 2, t, dur * 0.6, g * 0.4, this.bus, 0, sp);     // octave
    } else if (rich >= 1) {
      this._voice('sine', freq * 2, t, dur * 0.7, g * 0.35, this.bus, 0, sp * 0.5);
    }
    this._duckPad(t);
  }

  // Duck the pad bed a touch on each tap so the accent sits on top, then recover.
  _duckPad(t) {
    if (!this.padGain) return;
    const base = this._padLevel;
    this.padGain.gain.cancelScheduledValues(t);
    this.padGain.gain.setValueAtTime(this.padGain.gain.value, t);
    this.padGain.gain.linearRampToValueAtTime(base * 0.6, t + 0.04);
    this.padGain.gain.linearRampToValueAtTime(base, t + 0.5);
  }

  // Filtered white-noise hat — closed (short) or open (longer, on accents).
  _hat(t, gain, open = false, dest) {
    const src = this.ctx.createBufferSource();
    const len = (open ? 0.18 : 0.05) * this.ctx.sampleRate | 0;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    src.buffer = buf;
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = open ? 6000 : 7500;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + (open ? 0.18 : 0.05));
    src.connect(hp); hp.connect(g); g.connect(dest || this.bus);
    src.start(t); src.stop(t + (open ? 0.2 : 0.06));
  }

  // Soft sine kick.
  _kick(t, gain, dest) {
    const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g); g.connect(dest || this.bus); o.start(t); o.stop(t + 0.18);
  }

  // Light snare: noise burst + a short body tone.
  _snare(t, gain, dest) {
    const src = this.ctx.createBufferSource();
    const buf = this.ctx.createBuffer(1, 0.12 * this.ctx.sampleRate, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    src.connect(bp); bp.connect(g); g.connect(dest || this.bus);
    src.start(t); src.stop(t + 0.13);
    // body
    this._voice('triangle', 180, t, 0.09, gain * 0.5, dest || this.bus, 0, 0);
  }

  // Subtle footstep tick on landing — kept quiet so it doesn't fight the music.
  land() {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(65, t + 0.1);
    g.gain.setValueAtTime(0.1, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g); g.connect(this.bus); o.start(t); o.stop(t + 0.14);
  }

  // Backward-compat: turn emphasis normally flows through step(info.turned). Tiny bright accent.
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

  // "You fell" — descending sweep; stop the song and duck the bed to near-silence.
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
    // Stop the transport and duck the whole song bed away.
    this._stopTransport();
    this.melIdx = 0;
    this._songLevel = 0.0;
    if (this.songGain) {
      this.songGain.gain.cancelScheduledValues(t);
      this.songGain.gain.setValueAtTime(this.songGain.gain.value, t);
      this.songGain.gain.linearRampToValueAtTime(0.0001, t + 0.5);
    }
    this.spaceSend.gain.setTargetAtTime(0.12, t, 0.3);
  }

  // Warm, slow, breathing pad bed — a continuous layer inside the song bus.
  _startPad() {
    const t = this.ctx.currentTime;
    this._padLevel = 0.6; // level *within* songGain
    this.padGain = this.ctx.createGain(); this.padGain.gain.value = this._padLevel;
    this.padGain.connect(this.songGain);
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

  // setPad(true) STARTS the song (transport + fade in); setPad(false) STOPS/ducks it.
  setPad(on) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    if (on) {
      this._startTransport();
      this._songLevel = 0.9;
      this.songGain.gain.cancelScheduledValues(t);
      this.songGain.gain.setValueAtTime(Math.max(0.0001, this.songGain.gain.value), t);
      this.songGain.gain.exponentialRampToValueAtTime(this._songLevel, t + 1.2);
      this.spaceSend.gain.setTargetAtTime(0.22, t, 0.6);
    } else {
      this._stopTransport();
      this._songLevel = 0.0001;
      this.songGain.gain.cancelScheduledValues(t);
      this.songGain.gain.setValueAtTime(Math.max(0.0001, this.songGain.gain.value), t);
      this.songGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
    }
  }

  // rhythmFlip(i) marks a stair index as a "turn"; the song emphasizes those same
  // grid positions via RHYTHM.patterns in _scheduleStep. Exposed for callers that
  // want the audio module's view of whether a given step is an accent.
  isTurnStep(i) { return !!rhythmFlip(i); }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }
}
