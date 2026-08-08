// Living gradient sky + atmosphere. A single skydome shader gives us the
// vertical gradient, a soft sun bloom, drifting clouds and a night star field,
// all blended between palette keyframes as the "time of day" drifts.
import {
  Mesh, SphereGeometry, ShaderMaterial, BackSide, Color,
  HemisphereLight, DirectionalLight, FogExp2, Vector3,
} from 'three';
import { PALETTE, lerp, clamp } from './config.js';

const SKY_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const SKY_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vDir;
  uniform vec3 uTop, uMid, uLow, uSun;
  uniform vec3 uSunDir;
  uniform float uTime;
  uniform float uNight;      // 0 day .. 1 night (star + moon strength)
  uniform float uSunStr;

  // cheap hash / value-noise for clouds & dithering
  float hash(vec2 p){ p=fract(p*vec2(123.34,345.45)); p+=dot(p,p+34.345); return fract(p.x*p.y); }
  float noise(vec2 p){
    vec2 i=floor(p), f=fract(p);
    float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
    vec2 u=f*f*(3.0-2.0*f);
    return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
  }
  float fbm(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.02; a*=0.5;} return v; }

  void main() {
    vec3 dir = normalize(vDir);
    float h = clamp(dir.y*0.5+0.5, 0.0, 1.0);

    // three-stop vertical gradient with a gentle curve
    vec3 col = mix(uLow, uMid, smoothstep(0.0, 0.55, h));
    col = mix(col, uTop, smoothstep(0.42, 1.0, h));

    // sun / moon — a soft disc with a broad warm halo, an actual light source
    float sd = max(dot(dir, normalize(uSunDir)), 0.0);
    float disc = smoothstep(0.9930, 0.9974, sd);
    float halo = pow(sd, 4.0)*0.22 + pow(sd, 30.0)*0.7;
    col = mix(col, uSun, clamp(halo * uSunStr, 0.0, 1.0));
    col += uSun * disc * (1.3 + uNight*0.6);

    // horizon warm lift
    col += uLow * pow(1.0 - abs(dir.y), 8.0) * 0.15 * uSunStr;

    // layered drifting cloud banks — lit tops toward warm white so they read as
    // real clouds with depth, not a same-hue smear. Two octaves for soft form.
    vec2 cuv = dir.xz / max(0.30 + dir.y, 0.14);
    float c1 = fbm(cuv*1.25 + vec2(uTime*0.010, uTime*0.003));
    float c2 = fbm(cuv*2.70 + vec2(uTime*0.020, 5.0));
    float clouds = smoothstep(0.42, 0.86, c1*0.66 + c2*0.42);
    clouds *= smoothstep(0.99, 0.10, h);            // present low-mid, gone at zenith
    // a hint of internal shading: brighter where the higher-freq noise peaks
    float lit = 0.5 + 0.5*smoothstep(0.4, 0.9, c2);
    vec3 cloudCol = mix(mix(uMid, vec3(1.0), 0.62), uSun, 0.25) + lit*0.06;
    col = mix(col, cloudCol, clouds*(0.60+0.4*uSunStr)*(1.0-uNight*0.35));

    // stars at night
    if (uNight > 0.01) {
      vec2 suv = dir.xz / max(dir.y, 0.05);
      float st = hash(floor(suv*90.0));
      float star = smoothstep(0.985, 1.0, st) * smoothstep(0.0, 0.35, dir.y);
      float tw = 0.6 + 0.4*sin(uTime*3.0 + st*40.0);
      col += vec3(0.9,0.95,1.0) * star * tw * uNight * 1.4;
    }

    // ordered-ish dithering to kill banding on the gradient
    float dth = (hash(gl_FragCoord.xy)-0.5)/255.0;
    col += dth;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class Sky {
  constructor(scene) {
    this.scene = scene;
    this.t = 0;                 // day cycle phase [0..N)
    // Sun up the stairs (+X+Z, high): visible ahead in the back-view climb (a
    // "toward the light" rim), and front-lighting the face on the menu (which
    // views from the +X+Z side). Works for both camera angles.
    this.sunDir = new Vector3(0.45, 0.62, 0.50).normalize();

    const geo = new SphereGeometry(200, 48, 32);
    this.mat = new ShaderMaterial({
      side: BackSide, depthWrite: false, fog: false,
      uniforms: {
        uTop: { value: new Color() }, uMid: { value: new Color() },
        uLow: { value: new Color() }, uSun: { value: new Color() },
        uSunDir: { value: this.sunDir.clone() },
        uTime: { value: 0 }, uNight: { value: 0 }, uSunStr: { value: 1 },
      },
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    });
    this.dome = new Mesh(geo, this.mat);
    this.dome.renderOrder = -1;
    scene.add(this.dome);

    // Lighting — one dominant directional key, restrained ambient so the scene
    // keeps a real top→shadow value range instead of a flat wash.
    this.hemi = new HemisphereLight(0xdfe7ff, 0xc98b6a, 0.42);
    scene.add(this.hemi);

    this.key = new DirectionalLight(0xffe9c8, 2.8);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.camera.near = 1;
    this.key.shadow.camera.far = 60;
    const s = 18;
    Object.assign(this.key.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.022;
    this.key.shadow.radius = 4;
    scene.add(this.key);
    this.keyTarget = this.key.target;
    scene.add(this.keyTarget);

    // cool fill — only lifts shadow cores out of mud, never relights
    this.fill = new DirectionalLight(0x9fb8ff, 0.14);
    this.fill.position.set(4, -1, 5);
    scene.add(this.fill);

    scene.fog = new FogExp2(0x000000, 0.014);
    this._c = { top: new Color(), mid: new Color(), low: new Color(), sun: new Color(), amb: new Color(), key: new Color(), fog: new Color() };
    this.apply(0);
  }

  // Blend between the 4 palette skies by the continuous phase `t`.
  apply(phase) {
    const S = PALETTE.skies, n = S.length;
    const f = ((phase % n) + n) % n;
    const i = Math.floor(f), j = (i + 1) % n, k = f - i;
    const mix = (key, out) => out.copy(S[i][key]).lerp(S[j][key], k);
    const c = this._c;
    mix('top', c.top); mix('mid', c.mid); mix('low', c.low);
    mix('sun', c.sun); mix('amb', c.amb); mix('key', c.key); mix('fog', c.fog);

    this.mat.uniforms.uTop.value.copy(c.top);
    this.mat.uniforms.uMid.value.copy(c.mid);
    this.mat.uniforms.uLow.value.copy(c.low);
    this.mat.uniforms.uSun.value.copy(c.sun);

    // night factor peaks around the "night" keyframe (index 3)
    const night = clamp(Math.cos((f - 3) / n * Math.PI * 2) * 0.5 + 0.5, 0, 1);
    const nightPow = Math.pow(night, 1.5);
    this.mat.uniforms.uNight.value = nightPow;
    this.mat.uniforms.uSunStr.value = lerp(1.0, 0.4, nightPow);

    this.hemi.color.copy(c.top).lerp(new Color(0xdfe7ff), 0.4);
    this.hemi.groundColor.copy(c.fog);
    this.hemi.intensity = lerp(0.44, 0.30, nightPow);
    this.key.color.copy(c.key);
    this.key.intensity = lerp(2.9, 1.15, nightPow);
    this.fill.color.copy(c.low).lerp(new Color(0x9fb8ff), 0.5);
    this.fill.intensity = lerp(0.16, 0.09, nightPow);

    this.scene.fog.color.copy(c.fog);
    this.scene.fog.density = lerp(0.0105, 0.016, nightPow);
    this.nightFactor = nightPow;
  }

  // Follow the camera. The time-of-day is driven mainly by CLIMB HEIGHT so the
  // ascent visibly journeys dawn → day → dusk → night (a new biome ~every 24
  // steps), with a slow idle drift on top so the sky is never fully static.
  update(dt, camPos, playerPos, score = 0) {
    this.drift = (this.drift || 0) + dt * 0.004;
    const targetPhase = score / 24 + this.drift;
    // ease so a burst of steps doesn't snap the palette
    this.t += (targetPhase - this.t) * Math.min(1, dt * 1.5);
    this.mat.uniforms.uTime.value += dt;
    this.apply(this.t);
    this.dome.position.copy(camPos);

    // Keep the shadow frustum centred on the player.
    const p = playerPos || camPos;
    this.key.position.copy(p).addScaledVector(this.sunDir, 22);
    this.keyTarget.position.copy(p);
  }

  setPhase(p) { this.t = p; this.apply(p); }
}
