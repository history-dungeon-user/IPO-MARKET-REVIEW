import {
  Scene, PerspectiveCamera, WebGLRenderer, Vector3, ACESFilmicToneMapping,
  PCFSoftShadowMap, SRGBColorSpace, MathUtils, DirectionalLight, Color,
} from 'three';
import { CFG, PALETTE, clamp, lerp } from './config.js';
import { Sky } from './sky.js';
import { Stairs } from './stairs.js';
import { Player } from './player.js';
import { Environment } from './environment.js';
import { Ambient, Bursts } from './particles.js';
import { PostFX } from './postfx.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';

const BEST_KEY = 'skyward.best.v1';

// localStorage can throw in sandboxed iframes (e.g. published artifacts); guard it.
const safeStore = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

export class Game {
  constructor(mount) {
    this.mount = mount;
    this.state = 'menu';
    this.time = 0;
    this.shake = 0;

    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance', alpha: false });
    this.renderer.setClearColor(0x150c28, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.99;
    this.renderer.outputColorSpace = SRGBColorSpace;
    mount.appendChild(this.renderer.domElement);

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(CFG.camera.fov, 1, 0.1, 400);

    this.sky = new Sky(this.scene);
    // warm camera-side beauty fill so the hero's face is never lit by cool ambient alone
    this.beauty = new DirectionalLight(0xffd9b0, 0.5);
    this.scene.add(this.beauty, this.beauty.target);
    this.env = new Environment(this.scene);
    this.stairs = new Stairs(this.scene);
    this.player = new Player(this.scene);
    this.ambient = new Ambient(this.scene);
    this.bursts = new Bursts(this.scene);

    this.ui = new UI();
    this.audio = new Audio();

    this.best = parseInt(safeStore.get(BEST_KEY) || '0', 10) || 0;
    this.ui.setBest(this.best);

    this.playerIndex = 0;
    this.score = 0;
    this.combo = 0;
    this.stamina = CFG.stamina.start;
    this.lastDir = 0;
    this.buffered = null;
    this.runBias = 0;                 // EMA of recent taps: +1 all-right, -1 all-left
    this.camAz = CFG.camera.baseAz;   // smoothed camera azimuth
    this.camPos = new Vector3();
    this.camTarget = new Vector3();
    this.groundPos = new Vector3();   // smoothed step-follow (no jump-arc bob)
    this._tmp = new Vector3();
    this._occP = new Vector3();
    this._occS = new Vector3();

    this.input = new Input(this.renderer.domElement, (a) => this.onAction(a));

    // start / retry buttons + first-tap-to-play
    document.getElementById('playBtn').addEventListener('click', () => this.startGame());
    document.getElementById('retryBtn').addEventListener('click', () => this.startGame());

    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.postfx = new PostFX(this.renderer, this.scene, this.camera, this._w, this._h);

    this.enterMenu();
  }

  resize() {
    const w = this.mount.clientWidth || window.innerWidth;
    const h = this.mount.clientHeight || window.innerHeight;
    this._w = w; this._h = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // widen framing a touch on portrait phones so the stairs read well
    this.camera.fov = h > w ? CFG.camera.fov * 1.16 : CFG.camera.fov;
    this.camera.updateProjectionMatrix();
    if (this.postfx) this.postfx.setSize(w, h, this.dpr);
  }

  // --- camera framing helper ---
  desiredCam(out) {
    const p = this.groundPos;      // follow the smoothed step, not the jump arc
    const c = CFG.camera;
    const menu = this.state === 'menu';
    const R = menu ? c.menu.radiusXZ : c.radiusXZ;
    const oy = menu ? c.menu.offsetY : c.offsetY;
    out.set(p.x + R * Math.sin(this.camAz), p.y + oy, p.z + R * Math.cos(this.camAz));
    return out;
  }
  desiredLook(out) {
    const p = this.groundPos;
    const c = CFG.camera;
    if (this.state === 'menu') {
      // frame the mascot as a clear hero, no centroid bias
      out.set(p.x + c.menu.lookFwd, p.y + c.menu.lookUp, p.z + c.menu.lookFwd);
      return out;
    }
    const l = c.look;
    // look up the diagonal & above the player so it sits in the lower third
    out.set(p.x + l.fwd, p.y + l.up, p.z + l.fwd);
    // bias horizontally toward the centroid of the next few steps so the tower
    // stays centred and the empty sky doesn't collect on one side
    let mx = 0, mz = 0, cnt = 0;
    for (let i = 1; i <= 5; i++) {
      const s = this.stairs.stepAt(this.playerIndex + i);
      if (s) { mx += s.pos.x; mz += s.pos.z; cnt++; }
    }
    if (cnt) {
      out.x = lerp(out.x, mx / cnt, 0.18);
      out.z = lerp(out.z, mz / cnt, 0.18);
    }
    return out;
  }

  enterMenu() {
    this.state = 'menu';
    this.stairs.reset();
    const s0 = this.stairs.stepAt(0);
    const start = s0.pos.clone(); start.y += CFG.step.thickness / 2;
    this.player.reset(start);
    this.player.faceDir(this.stairs.requiredDir(0) ?? 0);
    this.runBias = 0; this.camAz = CFG.camera.baseAz;
    this.groundPos.copy(start);
    this.desiredCam(this.camPos); this.camera.position.copy(this.camPos);
    this.desiredLook(this.camTarget); this.camera.lookAt(this.camTarget);
    this.postfx.fade = 0;
    this.input.disable();
    this.ui.showStart();
  }

  startGame() {
    this.audio.init(); this.audio.resume(); this.audio.setPad(true);
    this.state = 'playing';
    this.stairs.reset();
    const s0 = this.stairs.stepAt(0);
    const start = s0.pos.clone(); start.y += CFG.step.thickness / 2;
    this.player.reset(start);
    this.playerIndex = 0; this.score = 0; this.combo = 0;
    this.stamina = CFG.stamina.start; this.lastDir = this.stairs.requiredDir(0) ?? 0;
    this.player.faceDir(this.lastDir);
    this.buffered = null;
    this.runBias = 0; this.camAz = CFG.camera.baseAz;
    this.groundPos.copy(start);
    this.postfx.fade = 0;
    this.desiredCam(this.camPos); this.camera.position.copy(this.camPos);
    this.ui.setScore(0); this.ui.setStamina(this.stamina);
    this.ui.showPlaying();
    this.input.enable();
  }

  onAction(action) {
    if (this.state === 'menu') { this.startGame(); this._process(action); return; }
    if (this.state !== 'playing') return;
    if (this.player.state === 'hop') { this.buffered = action; return; }
    this._process(action);
  }

  _process(action) {
    if (this.state !== 'playing') return;
    const chosen = action === 'right' ? 0 : 1;
    const required = this.stairs.requiredDir(this.playerIndex);
    if (required == null) return;
    if (chosen !== required) { this.fail(chosen); return; }

    // advance one step
    this.playerIndex++;
    this.score = this.playerIndex;
    this.combo++;
    const st = this.stairs.stepAt(this.playerIndex);
    const target = st.pos.clone(); target.y += CFG.step.thickness / 2;

    const speed = clamp(0.5 + this.score * 0.006, 0.5, 2.4);
    const dur = clamp(CFG.hopTime / speed, CFG.hopTimeMin, CFG.hopTime);

    const turned = chosen !== this.lastDir;
    this.lastDir = chosen;

    // track run bias so the camera azimuth can re-centre the tower
    const sign = chosen === 0 ? 1 : -1;   // right(+X)=+1, left(+Z)=-1
    this.runBias += 0.12 * (sign - this.runBias);

    this.player.hopTo(target, chosen, dur, () => this.onLand(st, chosen));

    // stamina refill
    const sc = CFG.stamina;
    const gain = Math.max(sc.gainMin, sc.gainPerStep + sc.gainRamp * this.score);
    this.stamina = clamp(this.stamina + gain, 0, sc.max);

    this.ui.setScore(this.score);
    // the climb performs the music: each step advances the melody; turns accent
    this.audio.step(this.combo, { turned, score: this.score });
    this.ui.hideHint();

    // combo call-outs & milestones
    if (this.combo > 0 && this.combo % 10 === 0) {
      const words = ['NICE!', 'GREAT!', 'SUPER!', 'BLAZING!', 'UNREAL!', 'ASCENDANT!'];
      this.ui.showCombo(words[Math.min(words.length - 1, this.combo / 10 - 1) | 0] || 'ASCENDANT!');
      this.audio.milestone();
      this.shake = Math.min(0.5, this.shake + 0.18);
    }
    this.stairs.maintain(this.playerIndex);
  }

  onLand(st, dir) {
    // burst + juice on landing
    const at = st.pos.clone(); at.y += CFG.step.thickness / 2 + 0.05;
    const c = this.sky._c.sun.clone().lerp(PALETTE.player.accent, 0.25);
    this.bursts.burst(at, c, 14, 1.0);
    this.audio.land();
    this.shake = Math.min(0.6, this.shake + 0.08);
    this.ui.doFlash(0.12, 70);

    // consume a buffered tap for snappy rapid climbing
    if (this.buffered && this.state === 'playing') {
      const b = this.buffered; this.buffered = null;
      this._process(b);
    }
  }

  fail(dir) {
    this.state = 'dying';
    this.input.disable();
    this.combo = 0;
    this.player.die(dir);
    this.audio.fail(); this.audio.setPad(false);
    this.ui.doFlash(0.4, 220);
    this.shake = 0.9;
    this.dieT = 0;
  }

  finishDeath() {
    this.state = 'over';
    const isNew = this.score > this.best;
    if (isNew) { this.best = this.score; safeStore.set(BEST_KEY, String(this.best)); this.ui.setBest(this.best); }
    this.ui.showOver(this.score, this.best, isNew);
  }

  // --- main loop ---
  update(dt) {
    this.time += dt;

    if (this.state === 'playing') {
      const sc = CFG.stamina;
      const drain = sc.drainStart + sc.drainRamp * this.score;
      this.stamina = clamp(this.stamina - drain * dt, 0, sc.max);
      this.ui.setStamina(this.stamina);
      if (this.stamina <= 0) this.fail(this.lastDir);
    }

    if (this.state === 'dying') {
      this.dieT += dt;
      this.postfx.fade = clamp(this.dieT / 1.1, 0, 0.55);
      if (this.dieT > 1.15) this.finishDeath();
    }

    // warm fill tracks the camera so the character's camera-facing side stays warm
    this.beauty.position.copy(this.camera.position);
    this.beauty.target.position.copy(this.player.root.position);

    this.player.faceCamAz = this.camAz;   // keep the face turned to the lens
    this.player.update(dt, this.time);
    this.stairs.maintain(this.playerIndex);

    // Smooth the camera's ground anchor toward the CURRENT STEP (not the jump
    // arc) so the view glides steadily instead of bobbing with every hop — the
    // single biggest anti-motion-sickness lever.
    const cur = this.stairs.stepAt(this.playerIndex);
    if (cur) { this._occP.copy(cur.pos); this._occP.y += CFG.step.thickness / 2; }
    else this._occP.copy(this.player.root.position);
    this.groundPos.lerp(this._occP, clamp(dt * 6, 0, 1));

    // camera azimuth eases VERY gently toward the run bias (rotation is the main
    // vertigo source, so keep it small & slow)
    const targetAz = CFG.camera.baseAz + this.runBias * CFG.camera.maxYaw;
    this.camAz += (targetAz - this.camAz) * (this.state === 'playing' ? CFG.camera.yawFollow : 0.02);

    // camera follow (skip strong follow while dying so we watch the tumble)
    this.desiredCam(this._tmp);
    const foll = this.state === 'dying' ? 0.04 : CFG.camera.follow;
    this.camPos.lerp(this._tmp, foll);
    this.desiredLook(this.camTarget);

    // camera shake — subtle; big vertical shakes read as nausea, keep it tiny
    this.shake = Math.max(0, this.shake - dt * 2.6);
    const sh = this.shake * this.shake;
    const ox = (Math.sin(this.time * 51.0) + Math.sin(this.time * 89.0)) * 0.5 * sh * 0.18;
    const oy = (Math.sin(this.time * 63.0) + Math.sin(this.time * 97.0)) * 0.5 * sh * 0.14;
    this.camera.position.set(this.camPos.x + ox, this.camPos.y + oy, this.camPos.z);
    this.camera.lookAt(this.camTarget);

    this.updateOcclusion();

    this.sky.update(dt, this.camera.position, this.player.root.position, this.score);
    this.env.setTint(this.sky._c.top, this.sky._c.low, this.sky._c.sun);
    this.env.update(dt, this.camera.position, this.player.root.position, this.score);
    this.ambient.tint(this.sky._c.sun.clone().lerp(this.sky._c.mid, 0.3));
    this.ambient.update(dt, this.camera.position, this.dpr);
    this.bursts.update(dt, this.dpr);
  }

  // Ghost any step that would cross in front of the hero's head, so the face is
  // never buried by a foreground slab (the readability guarantee for this genre).
  updateOcclusion() {
    const cam = this.camera;
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const head = this._occP.copy(this.player.root.position); head.y += 0.82;
    const camDist = this.player.root.position.distanceTo(cam.position);
    const hp = head.clone().project(cam);   // head NDC (one alloc/frame is fine)

    for (const st of this.stairs.steps) {
      let occ = false;
      if (st.index >= this.playerIndex - 3 && st.index <= this.playerIndex + 3) {
        const sp = this._occS.copy(st.pos); sp.y += CFG.step.thickness / 2;
        const sDist = sp.distanceTo(cam.position);
        if (sDist < camDist - 0.25) {          // nearer to camera than the hero
          const s = sp.project(cam);
          if (Math.abs(s.x - hp.x) < 0.22 && s.y > hp.y - 0.18) occ = true;
        }
      }
      const want = occ ? this.stairs.fadeMat(st.dir) : this.stairs.baseMat(st.dir);
      if (st.mesh.material !== want) st.mesh.material = want;
    }
  }

  render(dt) { this.postfx.render(dt); }
}
