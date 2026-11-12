import {
  ACESFilmicToneMapping, DirectionalLight, HalfFloatType, Mesh, MeshLambertMaterial, MeshStandardMaterial, NoToneMapping,
  Object3D, PCFShadowMap, PerspectiveCamera, Scene, Vector2, Vector3, WebGLRenderTarget, type Material, type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export type Quality = 'low' | 'medium' | 'high';

interface Preset {
  pbr: boolean;          // MeshStandardMaterial + environment lighting
  shadows: number;       // shadow map size (0 = blob shadows only)
  shadowTrees: boolean;  // trees cast shadows too
  post: boolean;         // composer: colour grade + vignette
  bloom: boolean;
  msaa: number;          // samples on the composer target
  maxPixelRatio: number;
}

export const PRESETS: Record<Quality, Preset> = {
  low: { pbr: false, shadows: 0, shadowTrees: false, post: false, bloom: false, msaa: 0, maxPixelRatio: 1.25 },
  medium: { pbr: true, shadows: 1024, shadowTrees: false, post: true, bloom: false, msaa: 0, maxPixelRatio: 1.5 },
  high: { pbr: true, shadows: 2048, shadowTrees: true, post: true, bloom: true, msaa: 4, maxPixelRatio: 2 },
};

/** Physical-material hints, set on a Lambert material's userData by whoever creates it. */
export interface PbrHint { roughness?: number; metalness?: number; envMapIntensity?: number }

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    contrast: { value: 1.08 },
    saturation: { value: 1.12 },
    lift: { value: new Vector3(0.012, 0.006, -0.004) }, // a touch warm in the shadows
    vignette: { value: 0.28 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float contrast; uniform float saturation; uniform vec3 lift; uniform float vignette;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c = (c - 0.5) * contrast + 0.5 + lift;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, saturation);
      vec2 d = vUv - 0.5;
      c *= 1.0 - vignette * smoothstep(0.25, 0.85, length(d * vec2(1.25, 1.0)));
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

const _off = new Vector3(-30, 60, -20).normalize().multiplyScalar(70);

/**
 * Quality-dependent rendering: materials (Lambert ↔ Standard, reversible), sun shadows that follow
 * the rider, and an optional post-processing chain. Everything here can change at runtime.
 */
export class Graphics {
  quality: Quality = 'high';
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
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
    const P = this.preset;
    if (!P.post) return;
    const rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: P.msaa });
    const c = new EffectComposer(this.renderer, rt);
    c.addPass(new RenderPass(this.scene, this.camera));
    if (P.bloom) {
      this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.35, 0.5, 0.92);
      this.applyBloomLevel();
      c.addPass(this.bloom);
    }
    c.addPass(new OutputPass());
    c.addPass(new ShaderPass(GradeShader));
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

  render() {
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
    t.needsUpdate = true;
  }
}

export function defaultQuality(touch: boolean): Quality {
  return touch ? 'medium' : 'high';
}
