import {
  ACESFilmicToneMapping, DirectionalLight, HalfFloatType, Mesh, MeshLambertMaterial, MeshStandardMaterial, NoToneMapping,
  Object3D, PCFShadowMap, PerspectiveCamera, Scene, Vector2, Vector3, WebGLRenderTarget, type Material, type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SUN_DIR } from '../world/decor';

export type Quality = 'low' | 'medium' | 'high';

interface Preset {
  pbr: boolean;          // MeshStandardMaterial + environment lighting
  shadows: number;       // shadow map size (0 = blob shadows only)
  shadowTrees: boolean;  // trees cast shadows too
  post: boolean;         // composer: colour grade + vignette
  bloom: boolean;
  ao: boolean;           // screen-space ambient occlusion (contact shadows under trees, ramps, the rider)
  msaa: number;          // samples on the composer target
  maxPixelRatio: number;
}

export const PRESETS: Record<Quality, Preset> = {
  low: { pbr: false, shadows: 0, shadowTrees: false, post: false, bloom: false, ao: false, msaa: 0, maxPixelRatio: 1.25 },
  medium: { pbr: true, shadows: 1024, shadowTrees: false, post: true, bloom: false, ao: false, msaa: 0, maxPixelRatio: 1.5 },
  high: { pbr: true, shadows: 2048, shadowTrees: true, post: true, bloom: true, ao: true, msaa: 4, maxPixelRatio: 2 },
};

/** Physical-material hints, set on a Lambert material's userData by whoever creates it. */
export interface PbrHint { roughness?: number; metalness?: number; envMapIntensity?: number }

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    contrast: { value: 1.08 },
    saturation: { value: 1.12 },
    lift: { value: new Vector3(0.012, 0.006, -0.004) }, // a touch warm in the shadows
    vignette: { value: 0.3 },
    speed: { value: 0 },      // 0..1: radial speed blur + a touch of lens fringing at the edges
    time: { value: 0 },
    grain: { value: 0.025 },
    warm: { value: new Vector3(1.04, 1.0, 0.94) },  // highlights lean warm,
    cool: { value: new Vector3(0.95, 1.0, 1.06) },  // shadows lean cool (split tone)
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float contrast; uniform float saturation; uniform vec3 lift; uniform float vignette;
    uniform float speed; uniform float time; uniform float grain; uniform vec3 warm; uniform vec3 cool;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + time) * 43758.5453); }
    void main() {
      vec2 d = vUv - 0.5;
      float r = length(d * vec2(1.25, 1.0));
      // speed: radial blur growing toward the screen edges (the rider in the middle stays sharp) + a little chromatic fringe
      float amt = speed * smoothstep(0.18, 0.9, r);
      vec3 c;
      if (amt > 0.002) {
        c = vec3(0.0);
        for (int i = 0; i < 6; i++) {
          float k = float(i) / 5.0;
          vec2 uv = 0.5 + d * (1.0 - amt * 0.07 * k);
          c += texture2D(tDiffuse, uv).rgb;
        }
        c /= 6.0;
        c.r = mix(c.r, texture2D(tDiffuse, 0.5 + d * (1.0 + amt * 0.006)).r, 0.6);
        c.b = mix(c.b, texture2D(tDiffuse, 0.5 + d * (1.0 - amt * 0.006)).b, 0.6);
      } else c = texture2D(tDiffuse, vUv).rgb;
      c = (c - 0.5) * contrast + 0.5 + lift;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, saturation);
      c *= mix(cool, warm, smoothstep(0.15, 0.75, l));
      c *= 1.0 - vignette * smoothstep(0.25, 0.85, r);
      c += (hash(vUv * 1024.0) - 0.5) * grain;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

const _off = SUN_DIR.clone().multiplyScalar(70);

/**
 * Quality-dependent rendering: materials (Lambert ↔ Standard, reversible), sun shadows that follow
 * the rider, and an optional post-processing chain. Everything here can change at runtime.
 */
export class Graphics {
  quality: Quality = 'high';
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private grade: ShaderPass | null = null;
  private speedSmooth = 0;
  private t = 0;
  private twins = new WeakMap<Material, MeshStandardMaterial>();
  private sun: DirectionalLight | null = null;
  private night = false;
  private size = new Vector2(1, 1);
  private renderScale = 1;

  constructor(private renderer: WebGLRenderer, private scene: Scene, private camera: PerspectiveCamera) {
    renderer.shadowMap.type = PCFShadowMap;
  }

  get preset() { return PRESETS[this.quality]; }

  setQuality(q: Quality) {
    this.quality = q;
    const P = this.preset;
    this.renderer.toneMapping = P.pbr ? ACESFilmicToneMapping : NoToneMapping;
    this.renderer.toneMappingExposure = this.night ? 1.25 : 1.05;
    this.renderer.shadowMap.enabled = P.shadows > 0;
    this.configureSun();
    this.buildComposer();
    this.refresh(this.scene);
    this.resize(this.size.x, this.size.y, this.renderScale);
  }

  /** Decor tells us which light is the sun, and whether it's night. */
  setSun(sun: DirectionalLight, night: boolean) {
    this.sun = sun;
    this.night = night;
    this.renderer.toneMappingExposure = night ? 1.25 : 1.05;
    if (!sun.target.parent) this.scene.add(sun.target);
    this.configureSun();
    if (this.bloom) this.applyBloomLevel();
  }

  private configureSun() {
    const s = this.sun, P = this.preset;
    if (!s) return;
    s.castShadow = P.shadows > 0;
    if (!s.castShadow) return;
    if (s.shadow.mapSize.x !== P.shadows) {
      s.shadow.mapSize.set(P.shadows, P.shadows);
      s.shadow.map?.dispose();
      s.shadow.map = null as never;
    }
    const cam = s.shadow.camera;
    const half = P.shadows >= 2048 ? 28 : 22;
    cam.left = cam.bottom = -half; cam.right = cam.top = half;
    cam.near = 10; cam.far = 160;
    cam.updateProjectionMatrix();
    s.shadow.bias = -0.0004;
    s.shadow.normalBias = 0.03;
    s.shadow.radius = 3;
  }

  /** Keep the shadow frustum centred on the rider (snapped to texels to stop shimmering). */
  follow(target: Vector3) {
    const s = this.sun;
    if (!s || !s.castShadow) return;
    const texel = (2 * (s.shadow.camera.right)) / s.shadow.mapSize.x;
    const x = Math.round(target.x / texel) * texel, z = Math.round(target.z / texel) * texel;
    s.target.position.set(x, target.y, z);
    s.position.set(x + _off.x, target.y + _off.y, z + _off.z);
    s.target.updateMatrixWorld();
  }

  private buildComposer() {
    this.composer?.dispose();
    this.composer = null;
    this.bloom = null;
    this.grade = null;
    const P = this.preset;
    if (!P.post) return;
    const rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: P.msaa });
    const c = new EffectComposer(this.renderer, rt);
    c.addPass(new RenderPass(this.scene, this.camera));
    if (P.ao) {
      const ao = new GTAOPass(this.scene, this.camera, this.size.x || 1, this.size.y || 1);
      ao.output = GTAOPass.OUTPUT.Default;
      ao.blendIntensity = 0.9;
      ao.updateGtaoMaterial({ radius: 0.7, distanceExponent: 1.5, thickness: 1.2, scale: 1.1, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 12 });
      c.addPass(ao);
    }
    if (P.bloom) {
      this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.35, 0.5, 0.92);
      this.applyBloomLevel();
      c.addPass(this.bloom);
    }
    c.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    c.addPass(this.grade);
    this.composer = c;
  }

  private applyBloomLevel() {
    if (!this.bloom) return;
    this.bloom.strength = this.night ? 0.8 : 0.28;
    this.bloom.threshold = this.night ? 0.92 : 0.97;
  }

  resize(w: number, h: number, renderScale: number) {
    this.size.set(w, h);
    this.renderScale = renderScale;
    const pr = Math.min(devicePixelRatio, this.preset.maxPixelRatio) * renderScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    if (this.composer) { this.composer.setPixelRatio(pr); this.composer.setSize(w, h); }
  }

  /** 0..1 from the rider's speed: drives the radial speed blur at the screen edges. */
  setSpeed(kmh01: number) { this.speedSmooth += (Math.max(0, Math.min(1, kmh01)) - this.speedSmooth) * 0.08; }

  render() {
    if (this.grade) {
      this.t += 1 / 60;
      this.grade.uniforms.speed.value = this.night ? this.speedSmooth * 0.6 : this.speedSmooth;
      this.grade.uniforms.time.value = this.t % 100;
    }
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /**
   * Apply the current quality to everything under `root`: material type and shadow flags.
   * Call after adding things to the scene (park load, ghosts, recolouring).
   */
  refresh(root: Object3D) {
    const P = this.preset;
    root.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const ud = m.userData as { noCast?: boolean; noReceive?: boolean; tree?: boolean; blob?: boolean };
      if (ud.blob) { m.visible = P.shadows === 0 && m.userData.blobWanted !== false; return; }
      m.castShadow = P.shadows > 0 && !ud.noCast && (!ud.tree || P.shadowTrees);
      m.receiveShadow = P.shadows > 0 && !ud.noReceive;
      if (Array.isArray(m.material)) return;
      m.material = this.materialFor(m.material);
    });
  }

  private materialFor(mat: Material): Material {
    const P = this.preset;
    // already a twin → maybe swap back
    const orig = (mat.userData as { lambert?: MeshLambertMaterial }).lambert;
    if (orig) {
      if (!P.pbr) return orig;
      this.syncTwin(orig, mat as MeshStandardMaterial);
      return mat;
    }
    if (!(mat as MeshLambertMaterial).isMeshLambertMaterial || !P.pbr) return mat;
    const lam = mat as MeshLambertMaterial;
    let twin = this.twins.get(lam);
    if (!twin) {
      const hint = (lam.userData.pbr ?? {}) as PbrHint;
      twin = new MeshStandardMaterial({
        roughness: hint.roughness ?? 0.85,
        metalness: hint.metalness ?? 0,
        envMapIntensity: hint.envMapIntensity ?? 1,
      });
      twin.userData.lambert = lam;
      this.twins.set(lam, twin);
    }
    this.syncTwin(lam, twin);
    return twin;
  }

  private syncTwin(l: MeshLambertMaterial, t: MeshStandardMaterial) {
    t.color.copy(l.color);
    t.map = l.map;
    t.side = l.side;
    t.flatShading = l.flatShading;
    t.transparent = l.transparent;
    t.opacity = l.opacity;
    t.depthWrite = l.depthWrite;
    t.polygonOffset = l.polygonOffset;
    t.polygonOffsetFactor = l.polygonOffsetFactor;
    t.polygonOffsetUnits = l.polygonOffsetUnits;
    t.vertexColors = l.vertexColors;
    t.emissive.copy(l.emissive);
    t.emissiveIntensity = l.emissiveIntensity;
    t.needsUpdate = true;
  }
}

export function defaultQuality(touch: boolean): Quality {
  return touch ? 'medium' : 'high';
}
