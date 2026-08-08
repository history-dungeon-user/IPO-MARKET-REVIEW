// Central tunables & palette. Keep everything a designer would touch in one place.
import { Color } from 'three';

export const CFG = {
  // --- Gameplay geometry ---
  // Steeper rise + tighter run makes each run read as a proper climb up-screen.
  step: { rise: 0.70, run: 0.88, size: 1.0, depth: 1.0, thickness: 0.46 },
  // Directions on the isometric grid: RIGHT advances +X, LEFT advances +Z.
  // The camera is oriented so both read as up-right / up-left on screen.
  turnChance: 0.52,        // flips often so the tower snakes up the centre
  minRun: 2,               // min steps before a flip is allowed (readability)
  maxRun: 5,               // force a flip after this many straight steps (no long lean)
  visibleAhead: 22,        // steps generated in front of player
  visibleBehind: 10,       // steps kept behind before recycling

  // --- Pacing ---
  hopTime: 0.16,           // seconds per hop (scales down with speed)
  hopTimeMin: 0.085,
  stamina: {
    max: 1.0,
    start: 0.62,
    drainStart: 0.052,     // per second at score 0
    drainRamp: 0.00060,    // extra drain per step of score
    gainPerStep: 0.072,    // refill per successful step
    gainRamp: -0.00016,    // step gain shrinks slightly as score climbs
    gainMin: 0.035,
  },

  camera: {
    // Near-orthographic: a long lens far away keeps every step the same size,
    // the clean iso "staircase into the sky" read of the genre.
    fov: 15,
    radiusXZ: 21.5,        // horizontal distance from player
    offsetY: 12.6,         // elevation: climb reads as a column, hero stays clear
    // Azimuth tracks the recent run direction so the tower stays centred and
    // the empty dead-space on long straight runs collapses.
    baseAz: Math.PI / 4,   // 45deg neutral iso
    maxYaw: 0.14,          // tiny recentre swing — rotation is the main vertigo source
    yawFollow: 0.03,       // very slow so it never feels like the world is turning
    // look target = player + (fwd, up, fwd): seats the character low, lens up.
    look: { fwd: 1.9, up: 3.15 },
    follow: 0.11,          // lerp factor
    shake: 0.0,
    // menu hero framing: closer & lower so the mascot reads as the star
    menu: { radiusXZ: 12.5, offsetY: 8.4, lookFwd: 0.6, lookUp: 2.35 },
  },
};

// A curated dawn→dusk dreamscape palette (Alto's-Odyssey lineage).
export const PALETTE = {
  step: {
    // tops bright & cool, sides notably darker & warmer so the slabs read solid
    top:  new Color('#f6eeff'),
    side: new Color('#a892c6'),
    // subtle two-tone so the zigzag reads clearly
    altTop:  new Color('#ffe7cf'),
    altSide: new Color('#cf9468'),
    edge: new Color('#fff6e8'),
  },
  player: {
    body:   new Color('#fff3df'),
    belly:  new Color('#ffd9a6'),
    accent: new Color('#39e6b0'),   // emissive teal
    accent2: new Color('#ff7aa8'),
    eye:    new Color('#241636'),
  },
  // Sky keyframes for the day/night drift (top → horizon). Each is cool-top /
  // warm-bottom for aerial perspective; fog sits slightly cooler than the steps.
  skies: [
    { name: 'dawn',  top: new Color('#6a5aa8'), mid: new Color('#f2996f'), low: new Color('#f4cfa0'), sun: new Color('#fff3d6'), fog: new Color('#d9c4d8'), amb: new Color('#b892cf'), key: new Color('#ffe6c4') },
    { name: 'day',   top: new Color('#3d6fc4'), mid: new Color('#79ade0'), low: new Color('#cadcf0'), sun: new Color('#fff4e2'), fog: new Color('#b7cbe4'), amb: new Color('#9fc4ee'), key: new Color('#fff2df') },
    { name: 'dusk',  top: new Color('#3a2a63'), mid: new Color('#c95f86'), low: new Color('#ff9d55'), sun: new Color('#ffd28a'), fog: new Color('#b58aa6'), amb: new Color('#a877b0'), key: new Color('#ffd6a8') },
    { name: 'night', top: new Color('#0b0e2c'), mid: new Color('#243a6b'), low: new Color('#456f9e'), sun: new Color('#dfe6ff'), fog: new Color('#1b2b50'), amb: new Color('#48598f'), key: new Color('#c2ceff') },
  ],
};

// --- Rhythm / music-driven design ---------------------------------------
// A fixed-tempo song plays; the staircase's turn pattern is laid out ON the
// beat grid (a `1` = flip direction on that step). Both the stairs and the
// backing track's accents read from these motifs, so stepping in time lands
// turns on the musical accents — a rhythm-game feel with the same L/R buttons.
export const RHYTHM = {
  bpm: 96,
  sectionSteps: 16,           // steps per motif before advancing to the next
  patterns: [
    [0,0,1,0, 0,1,0,0, 1,0,0,1, 0,0,1,0],   // A — sparse, easy groove
    [0,1,0,1, 0,0,1,0, 1,0,0,1, 0,1,0,1],   // B — busier
    [1,0,1,0, 0,1,0,1, 1,0,0,1, 0,1,1,0],   // C — syncopated
  ],
  // on-beat judging windows (seconds from the nearest beat)
  perfect: 0.085,
  good: 0.17,
};

// The flip decision for the step at absolute index `i` (0 = origin, never flips).
export function rhythmFlip(i) {
  if (i <= 0) return 0;
  const secLen = RHYTHM.sectionSteps;
  const sec = Math.floor((i - 1) / secLen) % RHYTHM.patterns.length;
  const pos = (i - 1) % secLen;
  return RHYTHM.patterns[sec][pos] ? 1 : 0;
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
