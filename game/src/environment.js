// Mid/far atmosphere layers for the empty sky of a SKYWARD-style climber.
// Everything here lives BEHIND the staircase and only fills otherwise-blank
// screen. It deliberately does NOT touch the skydome, ambient dust or step
// bursts (owned elsewhere). Layers, by importance:
//   1) 3 parallax cloud bands (soft canvas sprites, ≤9 planes total)
//   2) 4–6 distant floating rock-shard silhouettes
//   3) one faint vertical light-shaft / god-ray
//   4) 2–3 subliminal drifting-bird V's
// Counts are capped and per-frame CPU is a handful of vector ops so it stays
// happy under SwiftShader software rendering.
import {
  Group, Mesh, PlaneGeometry, IcosahedronGeometry, MeshBasicMaterial,
  ShaderMaterial, CanvasTexture, DataTexture, RGBAFormat, LinearFilter,
  Color, Vector3, DoubleSide, AdditiveBlending, NormalBlending,
} from 'three';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const UP = new Vector3(0, 1, 0);

// ---- cheap cached textures ------------------------------------------------

// Soft cloud alpha: a few overlapping radial-gradient blobs -> one texture,
// drawn once and shared by every cloud plane. Falls back to a tiny procedural
// radial DataTexture if no canvas is available.
function makeCloudTexture() {
  try {
    const S = 256, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d');
    if (!g) throw 0;
    g.clearRect(0, 0, S, S);
    const blob = (cx, cy, r, a) => {
      const rg = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      rg.addColorStop(0.0, `rgba(255,255,255,${a})`);
      rg.addColorStop(0.6, `rgba(255,255,255,${a * 0.35})`);
      rg.addColorStop(1.0, 'rgba(255,255,255,0)');
      g.fillStyle = rg;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    };
    // clustered puff, wider than tall so it reads as a horizon band
    blob(128, 150, 96, 0.55);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      blob(128 + Math.cos(a) * (46 + Math.random() * 34),
           150 + Math.sin(a) * (20 + Math.random() * 18),
           40 + Math.random() * 42, 0.28 + Math.random() * 0.22);
    }
    const tex = new CanvasTexture(cv);
    tex.minFilter = tex.magFilter = LinearFilter;
    return tex;
  } catch (e) {
    return radialFallback();
  }
}

// 32x32 radial-alpha white texture, used when canvas isn't available.
function radialFallback() {
  const S = 32, d = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const dx = (x - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2);
    const a = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy));
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = Math.round(a * a * 255);
  }
  const tex = new DataTexture(d, S, S, RGBAFormat);
  tex.minFilter = tex.magFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// Tiny dark V-silhouette for the far-away birds.
function makeBirdTexture() {
  try {
    const S = 64, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d');
    if (!g) throw 0;
    g.clearRect(0, 0, S, S);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 6; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(10, 34); g.quadraticCurveTo(26, 20, 32, 30);
    g.quadraticCurveTo(38, 20, 54, 34);
    g.stroke();
    const tex = new CanvasTexture(cv);
    tex.minFilter = tex.magFilter = LinearFilter;
    return tex;
  } catch (e) {
    return radialFallback();
  }
}

// ---- god-ray shader (single faint additive quad) --------------------------
const SHAFT_FRAG = /* glsl */`
  precision mediump float;
  varying vec2 vUv;
  uniform vec3 uColor;
  uniform float uAlpha;
  void main(){
    // soft on both axes, brightest along the vertical centre, fading up/down
    float x = smoothstep(0.0, 0.5, vUv.x) * smoothstep(1.0, 0.5, vUv.x);
    float y = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.35, vUv.y);
    gl_FragColor = vec4(uColor, x * y * uAlpha);
  }
`;
const SHAFT_VERT = /* glsl */`
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
`;

export class Environment {
  constructor(scene) {
    this.scene = scene;
    this.t = 0;

    // shared basis / scratch (rebuilt each frame, ~constant since the camera
    // offset is fixed relative to the player)
    this._fwd = new Vector3(-1, -0.6, -1).normalize();
    this._right = new Vector3(1, 0, 0);
    this._up = new Vector3(0, 1, 0);
    this._t0 = new Vector3(); this._t1 = new Vector3(); this._pos = new Vector3();

    // group is purely organisational; we place children in world space
    this.group = new Group();
    this.group.frustumCulled = false;
    scene.add(this.group);

    const cloudTex = makeCloudTexture();
    const planeGeo = new PlaneGeometry(1, 1);

    // --- 1) parallax cloud bands ---------------------------------------
    // band: parallax factor (fraction of camera horizontal drift it tracks),
    // depth into the scene, vertical anchor, plane count, opacity, scale.
    const bands = [
      { par: 0.50, depth: 120, y: -16, n: 3, op: 0.30, sc: 62 }, // near-low, densest
      { par: 0.25, depth: 175, y:  12, n: 3, op: 0.22, sc: 90 }, // mid
      { par: 0.10, depth: 235, y:  36, n: 3, op: 0.15, sc: 122 }, // far-high
    ];
    this.cloudMats = [];
    this.clouds = [];
    const W = 260; // lateral loop width
    for (const b of bands) {
      const mat = new MeshBasicMaterial({
        map: cloudTex, transparent: true, depthWrite: false, depthTest: true,
        blending: NormalBlending, opacity: b.op, fog: false, color: new Color(0xffffff),
      });
      this.cloudMats.push(mat);
      for (let i = 0; i < b.n; i++) {
        const m = new Mesh(planeGeo, mat);
        m.frustumCulled = false;
        m.renderOrder = -2; // behind staircase, after skydome
        const sc = b.sc * (0.75 + Math.random() * 0.6);
        m.scale.set(sc, sc * 0.5, 1);
        this.group.add(m);
        this.clouds.push({
          m, par: b.par, depth: b.depth,
          x0: (i / b.n) * W + Math.random() * 40, // spread across the loop
          y0: b.y + (Math.random() - 0.5) * 8,
          speed: 2.0 + Math.random() * 2.5,       // slow autonomous drift
          bob: 0.6 + Math.random() * 0.8, phase: Math.random() * 6.28,
        });
      }
    }
    this._W = W;

    // --- 2) distant floating rock-shard silhouettes --------------------
    this.islandMat = new MeshBasicMaterial({
      color: new Color(0xb0a0c0), fog: false, depthWrite: true, depthTest: true,
      side: DoubleSide,
    });
    this.islands = [];
    const N_ISL = 5;
    for (let i = 0; i < N_ISL; i++) {
      const geo = new IcosahedronGeometry(1, i % 2 ? 1 : 0); // rounded low-poly
      const m = new Mesh(geo, this.islandMat);
      m.frustumCulled = false;
      // normal opaque ordering (renderOrder 0) so the skydome can't cover them
      // flatten non-uniformly into plateau / shard forms
      const s = 14 + Math.random() * 16;
      m.scale.set(s * (0.8 + Math.random() * 0.6), s * (0.3 + Math.random() * 0.3),
                  s * (0.8 + Math.random() * 0.6));
      this.group.add(m);
      // spread laterally into the empty upper screen regions, far away
      const side = i % 2 ? 1 : -1;
      this.islands.push({
        m, depth: 160 + Math.random() * 120,
        x: side * (60 + Math.random() * 80),
        y: 24 + Math.random() * 66,
        bob: 1.2 + Math.random() * 1.6, phase: Math.random() * 6.28,
        rot: (Math.random() - 0.5) * 0.05, // extremely slow spin
      });
    }

    // --- 3) faint vertical light shaft ---------------------------------
    this.shaftMat = new ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true, fog: false,
      blending: AdditiveBlending, side: DoubleSide,
      uniforms: {
        uColor: { value: new Color(0xfff2cf) },
        uAlpha: { value: 0.05 },
      },
      vertexShader: SHAFT_VERT, fragmentShader: SHAFT_FRAG,
    });
    this.shaft = new Mesh(new PlaneGeometry(1, 1), this.shaftMat);
    this.shaft.frustumCulled = false;
    this.shaft.renderOrder = -2;
    this.shaft.scale.set(70, 200, 1);
    this.group.add(this.shaft);

    // --- 4) drifting birds --------------------------------------------
    const birdTex = makeBirdTexture();
    this.birdMat = new MeshBasicMaterial({
      map: birdTex, transparent: true, depthWrite: false, depthTest: true,
      fog: false, opacity: 0.5, color: new Color(0x2a2436),
    });
    this.birds = [];
    const N_BIRD = 3;
    for (let i = 0; i < N_BIRD; i++) {
      const m = new Mesh(planeGeo, this.birdMat);
      m.frustumCulled = false;
      m.renderOrder = -2;
      const sc = 2.0 + Math.random() * 1.4;
      m.scale.set(sc, sc, 1);
      this.group.add(m);
      this.birds.push({
        m, depth: 90 + Math.random() * 60,
        x0: Math.random() * 220, y: 30 + Math.random() * 40,
        speed: 5 + Math.random() * 4, bob: 1.5 + Math.random(), phase: Math.random() * 6.28,
      });
    }
    this._birdW = 220;

    // sensible warm defaults so it looks right even before game.js recolours
    this.setTint(new Color(0xbfa9d0), new Color(0xffd98a), new Color(0xfff2cf));
  }

  // Rebuild the camera-relative basis (right / up screen axes + forward-into-
  // scene). Forward ≈ toward the player from the camera; horizontal `right`
  // is kept level so parallax slides cleanly.
  _basis(camPos, playerPos) {
    const f = this._t0.copy(playerPos || camPos).sub(camPos);
    if (f.lengthSq() < 1e-4) f.set(-1, -0.6, -1);
    this._fwd.copy(f).normalize();
    this._right.copy(this._fwd).cross(UP);
    if (this._right.lengthSq() < 1e-4) this._right.set(1, 0, 0);
    this._right.normalize();
    this._up.copy(this._right).cross(this._fwd).normalize();
  }

  // Place `mesh` in world space at camera + right*offR + up*offU + fwd*depth.
  _place(mesh, offR, offU, depth, camPos) {
    this._pos.copy(camPos)
      .addScaledVector(this._right, offR)
      .addScaledVector(this._up, offU)
      .addScaledVector(this._fwd, depth);
    mesh.position.copy(this._pos);
  }

  // dt seconds, camPos/playerPos are THREE.Vector3, score is the step count.
  update(dt, camPos, playerPos, score) {
    if (!camPos) return;
    this.t += dt;
    this._basis(camPos, playerPos);

    // camera's horizontal position along the screen-right axis; bands track a
    // fraction of it so nearer bands slide faster (parallax).
    const driftH = camPos.dot(this._right);
    // altitude hook: sink the sky layers a touch as the score climbs, selling
    // the sense of having risen above them.
    const sink = clamp((score || 0) * 0.02, 0, 34);
    const W = this._W;

    // clouds
    for (const c of this.clouds) {
      let own = (c.x0 + this.t * c.speed) % W;      // loop across the frame
      if (own < 0) own += W;
      own -= W / 2;
      const offR = (c.par - 1) * driftH + own;
      const offU = c.y0 - sink + Math.sin(this.t * 0.2 + c.phase) * c.bob;
      this._place(c.m, offR, offU, c.depth, camPos);
      c.m.lookAt(camPos);                            // billboard toward camera
    }

    // islands (fixed lateral slot, very slow bob + spin, no billboard)
    for (const s of this.islands) {
      const offU = s.y - sink * 0.6 + Math.sin(this.t * 0.15 + s.phase) * s.bob;
      this._place(s.m, s.x, offU, s.depth, camPos);
      s.m.rotation.y += s.rot * dt;
      s.m.rotation.z = Math.sin(this.t * 0.1 + s.phase) * 0.04;
    }

    // light shaft: high in the sky, slightly to the sun side, yaw-billboarded
    // and given a fixed lean so it rakes across the upper sky.
    this._place(this.shaft, -46, 78 - sink * 0.3, 200, camPos);
    this._t1.copy(camPos).sub(this.shaft.position);
    this.shaft.rotation.set(0, Math.atan2(this._t1.x, this._t1.z), 0.22);

    // birds
    const BW = this._birdW;
    for (const b of this.birds) {
      let x = (b.x0 + this.t * b.speed) % BW;
      if (x < 0) x += BW;
      x -= BW / 2;
      const offU = b.y + Math.sin(this.t * 0.4 + b.phase) * b.bob;
      this._place(b.m, x, offU, b.depth, camPos);
      b.m.lookAt(camPos);
    }
  }

  // Called by game.js as the sky palette drifts so every layer stays cohesive.
  // colorTop = zenith, colorLow = horizon, sunColor = sun/glow tint.
  setTint(colorTop, colorLow, sunColor) {
    const white = new Color(0xffffff);
    if (this.cloudMats && (sunColor || colorLow)) {
      // bright warm-white so the banks read AGAINST the sky (depth), not into it
      const cc = (sunColor || colorLow).clone().lerp(white, 0.55);
      for (const m of this.cloudMats) m.color.copy(cc);
    }
    if (this.islandMat && colorLow) {
      // ~65% toward the sky so they read as soft, low-saturation silhouettes
      const ic = colorLow.clone().lerp(colorTop || colorLow, 0.35);
      this.islandMat.color.copy(colorLow.clone().lerp(ic, 0.65));
    }
    if (this.shaftMat && sunColor) this.shaftMat.uniforms.uColor.value.copy(sunColor);
    if (this.birdMat && colorTop) this.birdMat.color.copy(colorTop.clone().multiplyScalar(0.28));
  }
}
