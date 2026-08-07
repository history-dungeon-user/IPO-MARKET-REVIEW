// Post pipeline: render -> bloom -> grade(vignette + aberration + grain) -> output(ACES).
import { Vector2 } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 1.22 },
    uAber: { value: 0.0012 },
    uGrain: { value: 0.024 },
    uWarm: { value: 0.03 },
    uContrast: { value: 1.17 },
    uLift: { value: new Vector2(0, 0) },  // unused placeholder (kept for layout)
    uFade: { value: 0.0 },     // 0 normal .. 1 fully dark (game over dip)
    uRes: { value: new Vector2(1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uAber, uGrain, uWarm, uContrast, uFade;
    uniform vec2 uRes;
    float hash(vec2 p){ p=fract(p*vec2(123.34,345.45)); p+=dot(p,p+34.345); return fract(p.x*p.y); }
    void main(){
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      float r2 = dot(d,d);
      // chromatic aberration grows toward the edges
      vec2 off = d * uAber * (0.4 + r2*3.0);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + off).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - off).b;

      // subtle warm push in highlights
      col += vec3(uWarm, uWarm*0.5, -uWarm*0.6) * col.r;

      // soft vignette
      float vig = smoothstep(0.95, 0.25, r2*uVignette*1.6);
      col *= mix(0.80, 1.0, vig);

      // lift shadows toward cool ink (but let them approach real dark), add
      // contrast + a saturation lift so the lavender/peach palette actually sings.
      col = mix(vec3(0.055,0.05,0.10), vec3(1.0), col);
      col = (col - 0.5) * uContrast + 0.5;
      float lum = dot(col, vec3(0.299,0.587,0.114));
      col = mix(vec3(lum), col, 1.15);

      // filmic grain
      float g = hash(uv*uRes + fract(uTime))*2.0 - 1.0;
      col += g * uGrain * (0.6 + (1.0-vig)*0.8);

      // game-over fade to deep ink
      col = mix(col, vec3(0.06,0.03,0.12), uFade);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class PostFX {
  constructor(renderer, scene, camera, w, h) {
    this.renderer = renderer;
    this.composer = new EffectComposer(renderer);
    this.composer.setSize(w, h);

    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new Vector2(w, h), 0.36, 0.62, 0.82);
    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.uRes.value.set(w, h);
    this.output = new OutputPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.grade);
    this.composer.addPass(this.output);
  }

  setSize(w, h, dpr) {
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.grade.uniforms.uRes.value.set(w * dpr, h * dpr);
  }

  setCamera(cam) { this.renderPass.camera = cam; }
  set fade(v) { this.grade.uniforms.uFade.value = v; }

  render(dt) {
    this.grade.uniforms.uTime.value += dt;
    this.composer.render();
  }
}
