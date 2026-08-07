// Two systems: ambient drifting motes that live around the camera, and a pooled
// burst of sparks fired on each landing. Both are additive Points for glow.
import {
  BufferGeometry, BufferAttribute, Points, ShaderMaterial, AdditiveBlending,
  Color, Vector3,
} from 'three';

const AMBIENT_COUNT = 220;

const roundSprite = /* glsl */`
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
`;

export class Ambient {
  constructor(scene) {
    const n = AMBIENT_COUNT;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    const size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i*3] = (Math.random()-0.5)*36;
      pos[i*3+1] = (Math.random()-0.5)*26;
      pos[i*3+2] = (Math.random()-0.5)*36;
      seed[i] = Math.random()*100;
      size[i] = 2 + Math.random()*6;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('seed', new BufferAttribute(seed, 1));
    g.setAttribute('size', new BufferAttribute(size, 1));
    this.geo = g;
    this.mat = new ShaderMaterial({
      transparent: true, depthWrite: false, blending: AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uColor: { value: new Color('#ffe6b0') }, uDpr: { value: 1 } },
      vertexShader: /* glsl */`
        attribute float seed; attribute float size;
        uniform float uTime; uniform float uDpr; varying float vTw;
        void main(){
          vec3 p = position;
          p.y += sin(uTime*0.3 + seed)*1.4;
          p.x += cos(uTime*0.22 + seed*1.3)*1.1;
          vTw = 0.5 + 0.5*sin(uTime*1.5 + seed*6.0);
          vec4 mv = modelViewMatrix * vec4(p,1.0);
          gl_PointSize = size * uDpr * (14.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; varying float vTw;
        void main(){ ${roundSprite}
          gl_FragColor = vec4(uColor, a * (0.25 + vTw*0.6)); }`,
    });
    this.points = new Points(g, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  update(dt, camPos, dpr) {
    this.mat.uniforms.uTime.value += dt;
    this.mat.uniforms.uDpr.value = dpr;
    this.points.position.copy(camPos);
  }
  tint(c) { this.mat.uniforms.uColor.value.copy(c); }
}

const BURST_MAX = 260;
export class Bursts {
  constructor(scene) {
    const n = BURST_MAX;
    this.pos = new Float32Array(n*3);
    this.vel = new Float32Array(n*3);
    this.life = new Float32Array(n);     // remaining
    this.max = new Float32Array(n);
    this.col = new Float32Array(n*3);
    this.psize = new Float32Array(n);
    this.head = 0;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(35048)); // DynamicDraw
    g.setAttribute('acol', new BufferAttribute(this.col, 3).setUsage(35048));
    g.setAttribute('alife', new BufferAttribute(new Float32Array(n), 1).setUsage(35048));
    g.setAttribute('asize', new BufferAttribute(this.psize, 1).setUsage(35048));
    this.geo = g;
    this.mat = new ShaderMaterial({
      transparent: true, depthWrite: false, blending: AdditiveBlending,
      uniforms: { uDpr: { value: 1 } },
      vertexShader: /* glsl */`
        attribute vec3 acol; attribute float alife; attribute float asize;
        uniform float uDpr; varying vec3 vC; varying float vL;
        void main(){ vC=acol; vL=alife;
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = asize * uDpr * alife * (18.0 / -mv.z);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */`
        varying vec3 vC; varying float vL;
        void main(){ ${roundSprite}
          gl_FragColor = vec4(vC, a * vL); }`,
    });
    this.points = new Points(g, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this._tmp = new Vector3();
  }

  burst(at, color, count = 16, power = 1) {
    const c = color;
    for (let k = 0; k < count; k++) {
      const i = this.head; this.head = (this.head + 1) % BURST_MAX;
      this.pos[i*3] = at.x; this.pos[i*3+1] = at.y; this.pos[i*3+2] = at.z;
      const ang = Math.random()*Math.PI*2, up = 1.2 + Math.random()*2.6;
      const r = (0.7 + Math.random()*2.2) * power;
      this.vel[i*3] = Math.cos(ang)*r;
      this.vel[i*3+1] = up*power;
      this.vel[i*3+2] = Math.sin(ang)*r;
      this.max[i] = 0.5 + Math.random()*0.5;
      this.life[i] = this.max[i];
      this.psize[i] = 3 + Math.random()*5;
      this.col[i*3] = c.r; this.col[i*3+1] = c.g; this.col[i*3+2] = c.b;
    }
  }

  update(dt, dpr) {
    const life = this.geo.getAttribute('alife').array;
    for (let i = 0; i < BURST_MAX; i++) {
      if (this.life[i] <= 0) { life[i] = 0; continue; }
      this.life[i] -= dt;
      const l = Math.max(0, this.life[i]);
      this.vel[i*3+1] -= 9.0 * dt;
      this.pos[i*3]   += this.vel[i*3]   * dt;
      this.pos[i*3+1] += this.vel[i*3+1] * dt;
      this.pos[i*3+2] += this.vel[i*3+2] * dt;
      life[i] = l / this.max[i];
    }
    this.mat.uniforms.uDpr.value = dpr;
    this.geo.getAttribute('position').needsUpdate = true;
    this.geo.getAttribute('acol').needsUpdate = true;
    this.geo.getAttribute('alife').needsUpdate = true;
    this.geo.getAttribute('asize').needsUpdate = true;
  }
}
