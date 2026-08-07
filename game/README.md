# SKYWARD — Infinite Ascent

A mobile-ready, visually-polished **Three.js** endless climber in the spirit of
*무한의 계단 (Infinite Stairs)*, styled after the *Alto's Odyssey / Monument
Valley* school of beautiful mobile games. Tap left / right to match each step's
direction and climb an endless zig-zag staircase through a living, height-driven
sky.

## Play

It's a single static site — no build step. Serve the folder and open it:

```bash
cd game
python3 -m http.server 8000      # or any static server
# open http://localhost:8000
```

- **Controls:** tap (or click) the **left / right** half of the screen; on desktop
  use **← / →** or **A / D**. Match the direction of the next step. A wrong tap or
  running out of stamina ends the run.
- Works on touch and mouse, portrait and landscape, with safe-area insets for
  notched phones.

## What's inside

| Area | Highlights |
|------|-----------|
| **Rendering** | ACES tone mapping, PCF soft shadows, `EffectComposer` → bloom → colour-grade (vignette, chromatic aberration, film grain, lift/contrast/saturation) |
| **Sky** | Custom skydome shader: cool-top/warm-bottom gradient, soft sun disc + halo, two-octave drifting cloud banks, night stars. **Time-of-day is driven by climb height** — dawn → day → coral dusk → night biomes. |
| **Lighting** | One dominant low-raking warm key + restrained hemisphere + a warm camera-side beauty fill so the hero is never lit by cool ambient alone. |
| **Steps** | Rounded-box slabs, two-tone (warm vs cool) that *encodes turn direction*, cheap vertex-baked AO undersides, sky-catching fresnel rim. Recycled from a pool. |
| **Character** | An AAA-cute vinyl-toy mascot built from primitives — head-dominant, camera-cheating face (both eyes always read in iso), springy ears/tail/antenna, blink, full squash-and-stretch, tumble on death. |
| **Camera** | Near-orthographic; azimuth eases toward the recent run so the tower stays centred; a **depth-cutaway ghosts any step that would cross in front of the hero's face**. |
| **Feel** | Combo call-outs, camera shake, landing particle bursts, ambient motes, stamina system, best-score persistence, and a fully-procedural WebAudio score (pentatonic step tones, ambient pad, SFX). |

## Source map

```
index.html        entry, HUD/overlays, import-map
src/config.js     tunables + palette (biome keyframes, camera, pacing)
src/game.js       state machine, loop, camera, occlusion cutaway
src/sky.js        skydome shader, lighting, fog, day/night
src/stairs.js     procedural zig-zag staircase + step materials
src/player.js     the mascot: rig, face-cheat, squash/stretch, springs
src/environment.js parallax clouds / islands / god-ray / birds
src/particles.js  ambient motes + landing bursts
src/postfx.js     bloom + colour-grade pipeline
src/input.js      two-zone touch + keyboard
src/audio.js      procedural WebAudio SFX + pad
src/ui.js         HUD/overlay wiring
vendor/           pinned Three.js r160 + jsm addons (offline)
tools/shoot.mjs   Playwright screenshot harness (gameplay frames)
tools/quick.mjs   fast single-page capture for iteration
```

## How it was built

The game was developed with a **distributed sub-agent critique loop**: the core
engine was authored directly, while self-contained modules (the character, the
atmosphere layer) were built by dedicated implementer agents. Each iteration was
captured with the Playwright harness and handed to **strict "AAA art-director"
critic agents** (composition, lighting/materials, character, and a blind-A/B
judge comparing against the real *Infinite Stairs* + Alto's/Monument Valley).
Changes were driven by their prioritised notes until the blind test moved from
"the reference wins" to a **tie that clearly beats the original _무한의 계단_**.

## Regenerating review screenshots

```bash
npm install                 # three + playwright (dev only)
node tools/shoot.mjs        # writes shots/*.png (uses the pre-installed Chromium)
```
