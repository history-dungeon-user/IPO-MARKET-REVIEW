// SKYWARD — fully procedural WebAudio, now a RHYTHM GAME. A continuous fixed-tempo
// SONG plays on its own clock (a lookahead scheduler running the backing track), and
// the player's taps become melodic ACCENTS layered on top. The staircase is laid out
// on the same beat grid (see config.RHYTHM / rhythmFlip), so this module also exposes
// the beat clock the rest of the game syncs to. No files — all synthesized.
import { RHYTHM, rhythmFlip } from './config.js';

// C-major pentatonic phrase (semitone offsets from a root), a 24-note motif with a
// rising/falling contour. Notes: C D E G A across ~2 octaves. No 4th/7th => never clashes.
// The TUNE the player performs: one tap = the next note. A pleasant looping
// pentatonic phrase (C D E G A across ~2 octaves) with a rising/falling contour
// that resolves home, so any run of taps sounds musical and loops seamlessly.
const PENTA = [0, 2, 4, 7, 9, 12, 14, 12, 9, 7, 9, 12,
               16, 14, 12, 9, 7, 4, 2, 4, 7, 9, 4, 0];
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
    this.bpm = RHYTHM.bpm;      // current tempo (defaults to RHYTHM.bpm; setTempo overrides)
    this.beatDur = 60 / this.bpm;
    this.stepDur = this.beatDur / 4; // one 16th note

    // --- User-song mode: play the player's own track as the bed instead of the procedural one ---
    this.userMode = false;      // is a user-loaded song the active bed?
    this.userBuffer = null;     // decoded AudioBuffer of the user's song
    this.userSource = null;     // the live looping AudioBufferSourceNode (if playing)
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

  // ======================= USER SONG (player's own track) =================

  // Decode raw audio bytes into a loopable buffer, auto-detect its tempo so the stairs
  // sync without the player tapping, and switch to user-song mode.
  // Returns the detected BPM (number) on success, false if decoding fails.
  async loadUserSong(arrayBuffer) {
    if (!this.ctx || !arrayBuffer) return false;
    try {
      const buf = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
      this.userBuffer = buf;
      this.userMode = true;
      // Estimate tempo from the audio and lock the beat grid to it.
      const detected = this._detectBpm(buf);
      this.setTempo(detected); // clamps + realigns the clock; also stores this.bpm
      // If the transport is already playing, swap the bed to the user song right now.
      if (this.running) this._startUserSource();
      return detected;
    } catch (e) {
      return false;
    }
  }

  // Compact, dependency-free BPM estimator over a decoded AudioBuffer.
  // Energy-envelope onset detection + autocorrelation; folds into a musical range.
  // Falls back to RHYTHM.bpm on short/quiet/degenerate input.
  _detectBpm(buf) {
    const FALLBACK = RHYTHM.bpm;
    if (!buf || !buf.length || !buf.sampleRate) return FALLBACK;
    const sr = buf.sampleRate;
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;

    // Analyze at most the first ~60s for speed.
    const N = Math.min(ch0.length, Math.floor(sr * 60));
    const hop = Math.max(1, Math.floor(sr * 0.0116)); // ~11.6ms frames
    const frames = Math.floor(N / hop);
    if (frames < 16) return FALLBACK; // too short to judge

    // 1) Per-frame RMS energy (mix ch1 in if stereo).
    const energy = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let sum = 0; const base = f * hop;
      for (let i = 0; i < hop; i++) {
        let s = ch0[base + i];
        if (ch1) s = (s + ch1[base + i]) * 0.5;
        sum += s * s;
      }
      energy[f] = Math.sqrt(sum / hop);
    }

    // 2) Onset envelope = positive first-difference, then mean-remove.
    const onset = new Float32Array(frames);
    let mean = 0;
    for (let f = 1; f < frames; f++) {
      const d = energy[f] - energy[f - 1];
      onset[f] = d > 0 ? d : 0;
      mean += onset[f];
    }
    mean /= frames;
    let energyAcc = 0;
    for (let f = 0; f < frames; f++) { onset[f] -= mean; energyAcc += onset[f] * onset[f]; }
    if (energyAcc <= 1e-9) return FALLBACK; // signal too quiet / flat

    // 3) Autocorrelate over lags for 60–190 BPM; pick the strongest lag.
    const frameDur = hop / sr; // seconds per frame
    const lagFor = (bpm) => Math.round(60 / (bpm * frameDur));
    const minLag = lagFor(190); // fast tempo => small lag
    const maxLag = lagFor(60);  // slow tempo => large lag
    if (maxLag >= frames || minLag < 1) return FALLBACK;

    const corr = (lag) => {
      let c = 0;
      for (let f = lag; f < frames; f++) c += onset[f] * onset[f - lag];
      return c;
    };

    let bestLag = -1, bestC = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const c = corr(lag);
      if (c > bestC) { bestC = c; bestLag = lag; }
    }
    if (bestLag < 1 || bestC <= 0) return FALLBACK;

    let bpm = 60 / (bestLag * frameDur);

    // 4) Fold into a sensible tap range using the octave with the stronger support.
    if (bpm < 90) {
      const dbl = bpm * 2;
      if (dbl <= 190) { const cd = corr(Math.round(lagFor(dbl))); if (cd >= bestC * 0.6) bpm = dbl; }
    } else if (bpm > 180) {
      bpm = bpm / 2;
    }

    bpm = Math.round(bpm);
    if (!isFinite(bpm) || bpm < 60 || bpm > 190) return FALLBACK;
    return bpm;
  }

  // Drop the user's song; the next transport start uses the procedural arrangement again.
  clearUserSong() {
    this._stopUserSource();
    this.userMode = false;
    this.userBuffer = null;
  }

  // Set the tempo the scheduler/clock read; realign to a fresh downbeat NOW so the beat
  // grid and beatPhase/nearestBeatError/beatCount stay correct at the new tempo.
  setTempo(bpm) {
    if (!this.ctx) return;
    bpm = Math.min(220, Math.max(50, bpm));
    this.bpm = bpm;
    this.beatDur = 60 / bpm;
    this.stepDur = this.beatDur / 4;
    this.transportStart = this.ctx.currentTime; // fresh downbeat at the new tempo
    this.stepCounter = 0;
    this.nextStepTime = this.transportStart;
  }

  // Start (or restart) the looping user-song source into songGain, aligned to the
  // transport downbeat. If transportStart is in the future, begin at buffer 0 on it;
  // if it's already in the past, seek into the loop to match elapsed transport time.
  _startUserSource() {
    if (!this.ctx || !this.userBuffer) return;
    this._stopUserSource();
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.userBuffer; src.loop = true;
    src.connect(this.songGain);
    const dur = this.userBuffer.duration || 0;
    if (this.transportStart > now) {
      src.start(this.transportStart, 0);                 // future downbeat: from the top
    } else {
      const off = dur > 0 ? (now - this.transportStart) % dur : 0;
      src.start(now, off);                               // already running: seek in
    }
    this.userSource = src;
  }

  _stopUserSource() {
    if (this.userSource) {
      try { this.userSource.stop(); } catch (e) { /* already stopped */ }
      try { this.userSource.disconnect(); } catch (e) { /* noop */ }
      this.userSource = null;
    }
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

    // USER-SONG MODE: the player's own track is the bed. Don't layer procedural pitched
    // parts (bass/pad/lead) over an arbitrary song — only a VERY soft kick on the beat for
    // reinforcement, so the beat grid + accents + beatCount still drive the game.
    if (this.userMode) {
      if (pos % 4 === 0) this._kick(t, 0.05, song); // whisper-quiet downbeat tick
      return;
    }

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
    // These + the drums + bass are the BED the player performs the melody over. NO auto-lead:
    // the tapped melody in step() is the song's lead, so nothing here competes with it.
    if (pos === 0 || pos === 8) {
      this._voice('triangle', chordF, t, 0.32, 0.09, song, -6, 0.10);
      this._voice('sine', chordF * 1.5, t, 0.30, 0.05, song, 0, 0.10);
      this._voice('sine', chordF * 2, t, 0.26, 0.04, song, 0, 0.10);
    }
    // A soft open-hat sparkle marks accent ("turn") grid positions without adding pitched
    // content that would clash with the player's lead.
    if (accent && pos % 2 !== 0) this._hat(t, 0.05, true, song);
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

  // step() is the PLAYER PERFORMING THE MELODY — one tap = the next note of the tune.
  // A prominent marimba/bell pluck that sits clearly above the backing bed. It does NOT
  // advance the song (the transport owns tempo). info.grade shapes tone; info.turned = bigger.
  step(combo, info = {}) {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    const turned = !!info.turned;
    const grade = info.grade || 'good';

    // In user-song mode, a pitched pentatonic lead could clash with an arbitrary track,
    // so play a NEUTRAL percussive tick (filtered noise click) shaped by grade instead.
    if (this.userMode) { this._tick(t, grade, turned); return; }

    // Next note of the looping pentatonic tune, an octave over the bass so it rings out.
    const semi = PENTA[this.melIdx % PENTA.length];
    this.melIdx++;
    const freq = ROOT * Math.pow(2, (semi + 12) / 12);

    // Grade shapes brightness / length / reverb: perfect = brightest & longest, off = dull & short.
    let g, dur, sp, rich;
    if (grade === 'perfect') { g = 0.40; dur = 0.60; sp = 0.42; rich = 2; }
    else if (grade === 'off') { g = 0.24; dur = 0.20; sp = 0.06; rich = 0; }
    else { g = 0.32; dur = 0.34; sp = 0.20; rich = 1; } // 'good'
    if (turned) { g *= 1.15; dur *= 1.18; sp = Math.min(0.5, sp + 0.1); } // turns a touch bigger

    // Marimba/bell lead: a triangle body + a bright sine harmonic partial, mallet-fast attack.
    this._voice('triangle', freq, t, dur, g, this.bus, turned ? -6 : -4, sp);
    this._voice('sine', freq * 3, t, dur * 0.45, g * 0.28, this.bus, 0, sp * 0.5); // struck-bar overtone
    if (rich >= 2) {
      this._voice('sine', freq * 1.5, t, dur * 0.85, g * 0.5, this.bus, 0, sp);    // fifth
      this._voice('sine', freq * 2, t, dur * 0.65, g * 0.45, this.bus, 0, sp);     // octave
      this._voice('sine', freq * 4, t, dur * 0.3, g * 0.14, this.bus, 0, sp);      // shimmer
    } else if (rich >= 1) {
      this._voice('sine', freq * 2, t, dur * 0.7, g * 0.4, this.bus, 0, sp * 0.5); // octave sparkle
    }
    this._duckPad(t);
  }

  // Neutral tap tick for user-song mode: a short filtered-noise click, no pitch to clash
  // with the loaded track. Grade opens the filter / lengthens: perfect = brighter/opener.
  _tick(t, grade, turned) {
    let gain, dur, hpF;
    if (grade === 'perfect') { gain = 0.20; dur = 0.06; hpF = 3500; }
    else if (grade === 'off') { gain = 0.10; dur = 0.03; hpF = 1200; }
    else { gain = 0.15; dur = 0.045; hpF = 2400; } // 'good'
    if (turned) { gain *= 1.2; dur *= 1.15; }
    const src = this.ctx.createBufferSource();
    const buf = this.ctx.createBuffer(1, Math.max(1, dur * this.ctx.sampleRate | 0), this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    src.buffer = buf;
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = hpF;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(hp); hp.connect(g); g.connect(this.bus);
    src.start(t); src.stop(t + dur + 0.02);
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
    this._stopUserSource(); // clear the user track so it doesn't linger after a fall
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
      // User-song mode: the player's track is the bed, aligned to the transport downbeat.
      if (this.userMode && this.userBuffer) this._startUserSource();
      this._songLevel = 0.9;
      this.songGain.gain.cancelScheduledValues(t);
      this.songGain.gain.setValueAtTime(Math.max(0.0001, this.songGain.gain.value), t);
      this.songGain.gain.exponentialRampToValueAtTime(this._songLevel, t + 1.2);
      this.spaceSend.gain.setTargetAtTime(0.22, t, 0.6);
    } else {
      this._stopTransport();
      this._stopUserSource(); // don't let the user track linger past a stop
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
