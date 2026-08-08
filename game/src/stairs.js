// Procedural, recycled zig-zag staircase.
// RIGHT steps advance along +X, LEFT steps advance along +Z; a "turn" flips
// the active axis. Under the iso camera these read as up-right / up-left.
import {
  Group, MeshStandardMaterial, Mesh, Color, Vector3, DoubleSide,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CFG, PALETTE } from './config.js';

// A step material that (a) tints top faces lighter than sides and (b) adds a
// soft sky-tinted fresnel rim so edges catch the light like a real toy render.
function stepMaterial(topCol, sideCol, edgeCol) {
  const m = new MeshStandardMaterial({
    color: sideCol, roughness: 0.52, metalness: 0.0,
  });
  m.userData.top = topCol; m.userData.edge = edgeCol;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTop = { value: topCol };
    sh.uniforms.uEdge = { value: edgeCol };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n varying vec3 vWN; varying vec3 vVP; varying float vLY;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vWN = normalize(mat3(modelMatrix) * objectNormal); vVP = (modelViewMatrix*vec4(transformed,1.0)).xyz; vLY = position.y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n uniform vec3 uTop; uniform vec3 uEdge; varying vec3 vWN; varying vec3 vVP; varying float vLY;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float up = smoothstep(0.35, 0.9, vWN.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, uTop, up);
        // cheap baked AO: darken toward the underside so slabs feel solid
        float ao = smoothstep(-0.24, 0.22, vLY);
        diffuseColor.rgb *= mix(0.5, 1.0, ao);
      `)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        vec3 V = normalize(-vVP);
        float fres = pow(1.0 - max(dot(normalize(vWN), vec3(0.0,1.0,0.0))*0.0 + dot(normalize(vNormal), V), 0.0), 3.0);
        totalEmissiveRadiance += uEdge * fres * 0.30;
      `);
    m.userData.shader = sh;
  };
  return m;
}

export class Stairs {
  constructor(scene) {
    this.group = new Group();
    scene.add(this.group);

    const s = CFG.step;
    this.geo = new RoundedBoxGeometry(s.size, s.thickness, s.depth, 3, 0.09);

    this.matA = stepMaterial(PALETTE.step.top, PALETTE.step.side, PALETTE.step.edge);
    this.matB = stepMaterial(PALETTE.step.altTop, PALETTE.step.altSide, PALETTE.step.edge);
    // ghosted variants used to cut away any step that crosses in front of the hero
    this.matAFade = this.matA.clone(); this.matAFade.transparent = true; this.matAFade.opacity = 0.07; this.matAFade.depthWrite = false;
    this.matBFade = this.matB.clone(); this.matBFade.transparent = true; this.matBFade.opacity = 0.07; this.matBFade.depthWrite = false;

    this.baseMat = (dir) => (dir === 0 ? this.matA : this.matB);
    this.fadeMat = (dir) => (dir === 0 ? this.matAFade : this.matBFade);

    this.pool = [];
    this.steps = [];      // active step records {index, dir, pos, mesh}
    this.reset();
  }

  _mesh() {
    let m = this.pool.pop();
    if (!m) {
      m = new Mesh(this.geo, this.matA);
      m.castShadow = true; m.receiveShadow = true;
      this.group.add(m);
    }
    m.visible = true;
    return m;
  }

  reset() {
    for (const st of this.steps) { st.mesh.visible = false; this.pool.push(st.mesh); }
    this.steps.length = 0;
    this.index = 0;
    this.dir = 0;                 // 0 = +X (right), 1 = +Z (left)
    this.runLen = 0;
    this.rng = 987654321 ^ (Date.now() & 0xffffff);
    // origin step
    this.cursor = new Vector3(0, 0, 0);
    this._push(this.dir, true);
    for (let i = 0; i < CFG.visibleAhead; i++) this._advance();
  }

  _rand() { // xorshift for deterministic-ish sequence
    let x = this.rng | 0; x ^= x << 13; x ^= x >> 17; x ^= x << 5; this.rng = x;
    return ((x >>> 0) / 4294967296);
  }

  // Decide the next direction, then place a step there.
  _advance() {
    let flip = false;
    if (this.runLen >= CFG.minRun && this._rand() < CFG.turnChance) flip = true;
    if (CFG.maxRun && this.runLen >= CFG.maxRun) flip = true;   // never lean too far
    if (flip) { this.dir ^= 1; this.runLen = 0; } else { this.runLen++; }
    this._push(this.dir, false);
  }

  _push(dir, first) {
    const s = CFG.step;
    if (!first) {
      this.cursor = this.cursor.clone();
      this.cursor.y += s.rise;
      if (dir === 0) this.cursor.x += s.run; else this.cursor.z += s.run;
    }
    const mesh = this._mesh();
    mesh.material = (dir === 0) ? this.matA : this.matB;
    mesh.position.copy(this.cursor);
    // tiny random settle for organic feel
    mesh.rotation.set(0, 0, 0);
    const rec = { index: this.index, dir, pos: this.cursor.clone(), mesh };
    this.steps.push(rec);
    this.index++;
    return rec;
  }

  // The direction the player must press to reach step (playerIndex+1).
  requiredDir(playerIndex) {
    const next = this.steps.find(s => s.index === playerIndex + 1);
    return next ? next.dir : null;
  }

  stepAt(index) { return this.steps.find(s => s.index === index); }

  // Keep the pool tight: recycle far-behind steps, extend ahead of player.
  maintain(playerIndex) {
    while (this.steps.length && this.steps[0].index < playerIndex - CFG.visibleBehind) {
      const st = this.steps.shift();
      st.mesh.visible = false;
      this.pool.push(st.mesh);
    }
    let guard = 0;
    while (guard++ < 40) {
      const front = this.steps[this.steps.length - 1];
      if (!front || front.index - playerIndex >= CFG.visibleAhead) break;
      this._advance();
    }
  }
}
