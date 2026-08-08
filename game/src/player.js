// SKYWARD's mascot: an AAA-cute vinyl-toy critter — head-dominant, squat, with a
// camera-cheating face, springy ears/tail/antenna, and full squash-and-stretch.
// Built ONLY from SphereGeometry + RoundedBoxGeometry. The bloom pass loves the
// mint antenna orb; a tumble plays on death.
import {
  Group, Mesh, SphereGeometry, MeshStandardMaterial, MeshPhysicalMaterial,
  Vector3, Color, PointLight,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { PALETTE, CFG, clamp, lerp, easeOutBack, easeOutCubic } from './config.js';

// Camera looks down the (-1,-1,-1) diagonal from +X,+Y,+Z, so its ground azimuth
// sits at 45° between +X and +Z. The face is counter-rotated to this each frame so
// BOTH eyes always read in the 3/4 iso view no matter which way the body faces.
const CAM_AZ = Math.PI / 4;

// Tiny critically-ish-damped spring for secondary motion (ears, tail, antenna trail).
class Spring {
  constructor(k = 120, d = 14) { this.k = k; this.d = d; this.x = 0; this.v = 0; }
  kick(a) { this.v += a; }
  step(dt) {
    // semi-implicit Euler; clamp dt so a hitch can't explode the spring
    const h = Math.min(dt, 0.05);
    this.v += (-this.k * this.x - this.d * this.v) * h;
    this.x += this.v * h;
    return this.x;
  }
}

export class Player {
  constructor(scene) {
    this.root = new Group();        // world position of the character
    this.rig = new Group();         // squash/stretch + facing yaw + bank
    this.root.add(this.rig);
    scene.add(this.root);

    // --- Satin vinyl-toy materials (matte, faintly clearcoated — NOT wet plastic) ---
    const CREAM = new Color('#F7E7C8');   // warm cream body
    const CREAM_LT = new Color('#FFF3E0'); // lighter belly/front
    const PINK = new Color('#FFB3C1');    // cheek blush
    const MINT = new Color('#5ff0cf');    // antenna orb
    const PEACH = new Color('#FFD9B0');   // sheen tint

    const skinMat = new MeshPhysicalMaterial({
      color: CREAM, roughness: 0.5, metalness: 0.0,
      clearcoat: 0.35, clearcoatRoughness: 0.5,
      sheen: 0.5, sheenColor: PEACH, sheenRoughness: 0.6,
      emissive: new Color('#3a2412'), emissiveIntensity: 0.12, // warm floor, never greys out
    });
    const bellyMat = new MeshPhysicalMaterial({
      color: CREAM_LT, roughness: 0.55, metalness: 0.0,
      clearcoat: 0.3, clearcoatRoughness: 0.5, sheen: 0.4, sheenColor: PEACH,
    });

    // --- BODY: a squat rounded box, wider than tall, grounded ---
    this.body = new Mesh(new RoundedBoxGeometry(0.55, 0.42, 0.5, 5, 0.2), skinMat);
    this.body.castShadow = true; this.body.receiveShadow = true;
    this.body.position.y = 0.36;
    this.rig.add(this.body);

    // lighter belly/front patch
    const belly = new Mesh(new SphereGeometry(0.2, 24, 20), bellyMat);
    belly.scale.set(1.1, 1.05, 0.5); belly.position.set(0, -0.02, 0.24);
    this.body.add(belly);

    // --- HEAD: a big sphere on top (head:body ≈ 1.15:1), front slightly flattened ---
    this.head = new Group();
    this.head.position.y = 0.80;      // nestles onto the body top
    this.rig.add(this.head);
    const headMesh = new Mesh(new SphereGeometry(0.42, 32, 26), skinMat);
    headMesh.castShadow = true; headMesh.receiveShadow = true;
    headMesh.scale.z = 0.9;           // flatten the front so the face reads flat & cute
    this.head.add(headMesh);

    // --- FACE sub-group: counter-rotated toward the camera every frame (see update) ---
    this.faceGrp = new Group();
    this.faceGrp.rotation.y = CAM_AZ; // reset placeholder; driven live in update
    this.head.add(this.faceGrp);

    // EYES: big, wide-set, low, pushed forward so both catch light
    const eyeMat = new MeshPhysicalMaterial({
      color: new Color('#161616'), roughness: 0.15, metalness: 0.0,
      clearcoat: 0.8, clearcoatRoughness: 0.15,
    });
    const eyeGeo = new SphereGeometry(0.075, 20, 16);
    const hlMat = new MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.5, roughness: 0.3 });
    const hlGeo = new SphereGeometry(0.022, 10, 8);
    this.eyes = [];
    for (const sx of [-1, 1]) {
      const e = new Mesh(eyeGeo, eyeMat);
      e.position.set(0.14 * sx, 0.05, 0.34);
      this.faceGrp.add(e); this.eyes.push(e);
      // white highlight on the upper-INNER of each eye, facing camera
      const hl = new Mesh(hlGeo, hlMat);
      hl.position.set(-0.02 * sx, 0.025, 0.05);
      e.add(hl);
    }

    // MOUTH: a tiny dark flattened shape below the eyes for expression
    const mouth = new Mesh(new SphereGeometry(0.05, 14, 10), eyeMat);
    mouth.scale.set(1.4, 0.55, 0.5); mouth.position.set(0, -0.10, 0.36);
    this.faceGrp.add(mouth);

    // CHEEKS: soft matte pink, low-outer, both visible
    const cheekMat = new MeshStandardMaterial({ color: PINK, roughness: 0.9, metalness: 0.0 });
    for (const sx of [-1, 1]) {
      const c = new Mesh(new SphereGeometry(0.06, 14, 12), cheekMat);
      c.scale.set(1.0, 0.7, 0.35); c.position.set(0.20 * sx, -0.02, 0.32);
      this.faceGrp.add(c);
    }

    // --- EARS: flattened spheres on top of the head for silhouette (spring on hop/land) ---
    const earGeo = new SphereGeometry(0.12, 20, 16);
    this.ears = [];
    for (const sx of [-1, 1]) {
      const ear = new Mesh(earGeo, skinMat);
      ear.scale.set(0.85, 1.1, 0.5);
      ear.position.set(0.26 * sx, 0.30, -0.02);
      ear.rotation.z = -0.35 * sx;    // splay outward
      ear.castShadow = true;
      this.head.add(ear);
      this.ears.push({ mesh: ear, sx, restZ: -0.35 * sx });
    }
    this.earSpring = new Spring(150, 12);

    // --- TAIL: a stubby rounded nub at the back for back-silhouette + wiggle ---
    this.tail = new Mesh(new RoundedBoxGeometry(0.16, 0.16, 0.2, 4, 0.07), skinMat);
    this.tail.position.set(0, 0.30, -0.32);
    this.tail.castShadow = true;
    this.rig.add(this.tail);
    this.tailSpring = new Spring(110, 10);

    // --- FEET: clearly-visible rounded-box feet, slightly forward, splay on squash ---
    this.feet = [];
    for (const sx of [-1, 1]) {
      const f = new Mesh(new RoundedBoxGeometry(0.18, 0.13, 0.24, 3, 0.06), bellyMat);
      f.position.set(0.15 * sx, 0.07, 0.11); f.castShadow = true;
      this.rig.add(f);
      this.feet.push({ mesh: f, sx, baseX: 0.15 * sx });
    }

    // --- ANTENNA: crown-mounted stalk + DIM mint orb, springs so the orb trails/overshoots ---
    this.stalkGrp = new Group();
    this.stalkGrp.position.set(0, 0.40, 0);   // top-center of head (crown)
    this.head.add(this.stalkGrp);
    const stalk = new Mesh(new RoundedBoxGeometry(0.04, 0.22, 0.04, 2, 0.02),
      new MeshStandardMaterial({ color: CREAM, roughness: 0.6 }));
    stalk.position.y = 0.11;
    this.stalkGrp.add(stalk);
    this.orb = new Mesh(new SphereGeometry(0.09, 24, 20),
      new MeshStandardMaterial({ color: MINT, emissive: MINT, emissiveIntensity: 1.1, roughness: 0.3 }));
    this.orb.position.y = 0.24;
    this.stalkGrp.add(this.orb);
    // small point light: lights only the crown, must NOT blow out the face
    this.orbLight = new PointLight(MINT, 0.3, 2.2, 2.0);
    this.orbLight.position.copy(this.orb.position);
    this.stalkGrp.add(this.orbLight);
    this.antSpring = new Spring(90, 8);

    this.showBack = false;   // game toggles: true in play (back view), false on menu
    this.reset(new Vector3());
  }

  reset(pos) {
    this.root.position.copy(pos);
    this.rig.position.set(0, 0, 0);
    this.rig.scale.set(1, 1, 1);
    this.rig.rotation.set(0, 0, 0);
    this.facing = 0;                 // target yaw
    this.yaw = 0;
    this.rig.rotation.y = 0;
    this.state = 'idle';
    this.hop = null;
    this.dead = false;
    this.t = 0;
    this.sy = 1;                     // current vertical scale (sxz derived, volume-preserving)
    this.bank = 0;                   // current body roll (rig.rotation.z)
    this.pitch = 0;                  // current forward lean (rig.rotation.x), smoothed
    this.shift = 0;                  // current body/head forward weight shift, smoothed
    this.stride = 0;                 // run-cycle parity: which foot leads (flips each hop)
    // per-foot smoothed run-cycle offsets (ease back to rest when idle)
    for (const ft of this.feet) { ft.rx = 0; ft.ry = 0; ft.rz = 0; }
    // secondary-motion springs
    this.earSpring.x = this.earSpring.v = 0;
    this.tailSpring.x = this.tailSpring.v = 0;
    this.antSpring.x = this.antSpring.v = 0;
    // blink scheduler
    this.blinkT = 2 + Math.random() * 3;
    this.blink = 0;                  // 0..1 lid closure
    this.blinkPhase = 'open';
    this.blinkTimer = 0;
    this.blinkDouble = false;
  }

  faceDir(dir) {
    // dir 0 (+X) -> face +X (yaw +PI/2) ; dir 1 (+Z) -> face +Z (yaw 0)
    this.facing = (dir === 0) ? Math.PI / 2 : 0;
  }

  hopTo(target, dir, duration, onLand) {
    this.faceDir(dir);
    // alternate the leading foot every step so it reads as a real running gait
    this.stride ^= 1;
    this.hop = {
      from: this.root.position.clone(),
      to: target.clone(),
      dur: duration, t: 0, onLand, landed: false,
      lead: this.stride,             // index of the foot that swings forward this step
    };
    this.state = 'hop';
    // anticipation: deeper crouch + kick the springs so ears/tail/orb lag the launch
    this.sy = 0.82;
    this.earSpring.kick(-6);
    this.tailSpring.kick(-5);
    this.antSpring.kick(-7);
  }

  die(sideDir) {
    this.dead = true;
    this.state = 'fall';
    this.fall = {
      vy: 4.2,
      vx: (sideDir === 0 ? 3.2 : -0.5),
      vz: (sideDir === 1 ? 3.2 : -0.5),
      spin: (Math.random() - 0.5) * 14,
      t: 0,
    };
    this.earSpring.kick(10);
    this.tailSpring.kick(8);
    this.antSpring.kick(12);
  }

  // --- blink: occasional single or double blink, ~90ms closure ---
  _updateBlink(dt) {
    if (this.blinkPhase === 'open') {
      this.blinkT -= dt;
      if (this.blinkT <= 0) { this.blinkPhase = 'closing'; this.blinkTimer = 0; }
    } else if (this.blinkPhase === 'closing') {
      this.blinkTimer += dt;
      this.blink = clamp(this.blinkTimer / 0.045, 0, 1);
      if (this.blink >= 1) { this.blinkPhase = 'opening'; this.blinkTimer = 0; }
    } else { // opening
      this.blinkTimer += dt;
      this.blink = 1 - clamp(this.blinkTimer / 0.045, 0, 1);
      if (this.blink <= 0) {
        if (this.blinkDouble) { this.blinkDouble = false; this.blinkPhase = 'closing'; this.blinkTimer = 0; }
        else { this.blinkPhase = 'open'; this.blinkT = 3 + Math.random() * 2; this.blinkDouble = Math.random() < 0.25; }
      }
    }
    // scale eye Y from 1 down to ~0.1 while blinking
    const ey = lerp(1, 0.1, this.blink);
    this.eyes[0].scale.y = ey; this.eyes[1].scale.y = ey;
  }

  update(dt, time) {
    // clamp dt so a frame hitch can't jerk the run/lean smoothing or physics
    dt = Math.min(dt, 0.05);
    // smooth facing toward target yaw
    let d = this.facing - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * clamp(dt * 18, 0, 1);

    // step secondary-motion springs (used by ears / tail / antenna below)
    const eSpr = this.earSpring.step(dt);
    const tSpr = this.tailSpring.step(dt);
    const aSpr = this.antSpring.step(dt);

    if (this.state === 'fall') {
      const f = this.fall; f.t += dt;
      f.vy -= 14 * dt;
      this.root.position.x += f.vx * dt;
      this.root.position.y += f.vy * dt;
      this.root.position.z += f.vz * dt;
      this.rig.rotation.z += f.spin * dt;
      this.rig.rotation.x += f.spin * 0.6 * dt;
      this.orb.material.emissiveIntensity = lerp(this.orb.material.emissiveIntensity, 0.25, dt * 3);
      this.orbLight.intensity = lerp(this.orbLight.intensity, 0.1, dt * 3);
      // let the appendages flail as it tumbles
      this.stalkGrp.rotation.x = aSpr * 0.05;
      for (const e of this.ears) e.mesh.rotation.z = e.restZ + eSpr * 0.04 * e.sx;
      this.tail.rotation.x = tSpr * 0.04;
      return;
    }

    // --- antenna orb: DIM breathing 1.1 -> 1.6, crown light stays low so the face is safe ---
    const breathe = Math.sin(time * 2.2) * 0.5 + 0.5;
    this.orb.material.emissiveIntensity = 1.1 + breathe * 0.5;
    this.orbLight.intensity = 0.42 + breathe * 0.16;

    // --- face cheats toward the LIVE camera azimuth regardless of body yaw ---
    // (game.js feeds the current camera azimuth; falls back to the neutral iso)
    // In back view we don't cheat the face to camera — the body's front faces
    // the way it's climbing, so we see the cute 3/4 back (ears, tail, antenna).
    const camAz = (this.faceCamAz != null) ? this.faceCamAz : CAM_AZ;
    this.faceGrp.rotation.y = this.showBack ? 0 : (camAz - this.yaw);
    this._updateBlink(dt);

    // --- squash/stretch state machine: drive vertical scale sy (sxz derived, volume-preserving) ---
    let bankTarget = 0;
    let pitchTarget = 0;             // forward lean about local X (airborne)
    let shiftTarget = 0;             // body/head forward weight shift
    let runReach = 0;                // 0->1->0 airborne envelope for the foot run cycle
    let leadIdx = -1;                // which foot leads this step (-1 = plant/rest)
    if (this.state === 'hop' && this.hop) {
      const h = this.hop; h.t += dt;
      const t = clamp(h.t / h.dur, 0, 1);
      const e = easeOutCubic(t);
      this.root.position.lerpVectors(h.from, h.to, e);
      // parabolic arc: y = lerp + 4*t*(1-t)*arcHeight
      const arc = 4 * t * (1 - t);
      this.root.position.y = lerp(h.from.y, h.to.y, e) + arc * 0.55;
      // push-off crouch -> ascent stretch -> upward "reach" near apex -> settle grounded
      if (t < 0.15)      this.sy = lerp(0.82, 1.10, t / 0.15);
      else if (t < 0.50) this.sy = lerp(1.10, 1.18, (t - 0.15) / 0.35);   // reach at apex
      else               this.sy = lerp(1.18, 0.98, (t - 0.50) / 0.50);
      // bank ~10° into the direction of travel, strongest mid-arc
      bankTarget = 0.17 * (1 - Math.abs(2 * t - 1));
      // forward lean + weight lead into the leap, easing back to upright on landing
      pitchTarget = 0.26 * arc;
      shiftTarget = 0.045 * arc;
      // alternating-foot run cycle: lead swings forward+up, trailing pushes back+down
      runReach = Math.sin(Math.PI * t);
      leadIdx = h.lead;
      // cute waddle: a little body roll toward the lead foot, synced to the stride
      bankTarget += (h.lead === 0 ? 1 : -1) * runReach * 0.08;
      if (t >= 1 && !h.landed) {
        h.landed = true;
        this.sy = 0.78;               // landing squash HIT (wide & short)
        this.state = 'land';
        this.landT = 0;
        this.hop = null;              // clear BEFORE onLand — a buffered tap in
                                      // onLand may start a new hop we must not clobber
        // impact kicks: ears flap up, tail bounces, orb overshoots
        this.earSpring.kick(12);
        this.tailSpring.kick(10);
        this.antSpring.kick(13);
        if (h.onLand) h.onLand();
      }
    } else if (this.state === 'hop' && !this.hop) {
      // watchdog: state says 'hop' but there is no hop object — never get stuck
      this.state = 'idle';
    } else if (this.state === 'land') {
      this.landT += dt;
      const k = clamp(this.landT / 0.24, 0, 1);
      // springy overshoot back to 1 (easeOutBack rebounds past neutral, then settles)
      this.sy = lerp(0.78, 1.0, easeOutBack(k));
      if (k >= 1) this.state = 'idle';
    } else {
      // idle breathing ±3%
      this.sy = lerp(this.sy, 1 + Math.sin(time * 2.6) * 0.03, clamp(dt * 6, 0, 1));
    }

    // apply body transform: forward lean (pitch) + yaw + bank, volume-preserving scale
    this.bank = lerp(this.bank, bankTarget, clamp(dt * 12, 0, 1));
    this.pitch = lerp(this.pitch, pitchTarget, clamp(dt * 10, 0, 1));
    const B = 1.16;                  // base scale — a touch more hero presence
    const sy = this.sy;
    const sxz = 1 / Math.sqrt(sy);   // volume preservation: XZ shrinks as Y grows
    this.rig.scale.set(sxz * B, sy * B, sxz * B);
    this.rig.rotation.set(this.pitch, this.yaw, this.bank);

    // body/head lead forward into the leap, settling back for weight on land
    this.shift = lerp(this.shift, shiftTarget, clamp(dt * 10, 0, 1));
    this.body.position.z = this.shift;
    this.head.position.z = this.shift * 0.6;

    // feet: alternating run cycle (lead reaches forward+up, trail drives back+down),
    // layered over the squash splay; all offsets ease back to rest when not hopping.
    const squashAmt = Math.max(0, 1 - sy);
    const fr = clamp(dt * 16, 0, 1);
    for (let i = 0; i < this.feet.length; i++) {
      const ft = this.feet[i];
      let tx = 0, ty = 0, tz = 0, trot = 0;
      if (leadIdx >= 0) {
        if (i === leadIdx) {         // LEAD foot: big swing forward+up, toe kicks up
          tz = runReach * 0.23;
          ty = runReach * 0.17;
          tx = runReach * 0.03 * ft.sx;
          trot = -runReach * 0.85;   // kick the toe up as it reaches
        } else {                     // TRAILING foot: drive back+down (push-off), toe points back
          tz = -runReach * 0.17;
          ty = -runReach * 0.05;
          trot = runReach * 0.55;
        }
      }
      ft.rx = lerp(ft.rx, tx, fr);
      ft.ry = lerp(ft.ry, ty, fr);
      ft.rz = lerp(ft.rz, tz, fr);
      ft.rrot = lerp(ft.rrot || 0, trot, fr);
      ft.mesh.position.x = ft.baseX + squashAmt * 0.12 * ft.sx + ft.rx;
      ft.mesh.position.y = 0.07 - squashAmt * 0.03 + ft.ry;
      ft.mesh.position.z = 0.11 + ft.rz;
      ft.mesh.rotation.x = ft.rrot;
    }

    // --- secondary motion + idle life ---
    // ears: spring flap (mirrored per side) plus a faint idle sway
    const earIdle = Math.sin(time * 2.4) * 0.04;
    for (const en of this.ears) {
      en.mesh.rotation.z = en.restZ + (eSpr * 0.05 + earIdle) * en.sx;
      en.mesh.rotation.x = eSpr * 0.06;
    }
    // tail: springy wag + gentle idle
    this.tail.rotation.x = tSpr * 0.06 + Math.sin(time * 1.8) * 0.05;
    this.tail.rotation.y = Math.sin(time * 1.3) * 0.08;
    // antenna: orb trails & overshoots via spring, plus idle sway
    this.stalkGrp.rotation.x = aSpr * 0.06 + Math.sin(time * 2.0) * 0.05;
    this.stalkGrp.rotation.z = Math.sin(time * 1.6 + 1.0) * 0.05;
    // occasional subtle head tilt toward the camera
    this.head.rotation.z = Math.sin(time * 0.7) * 0.05;
    this.head.rotation.x = Math.sin(time * 0.9 + 0.5) * 0.03;
  }
}
