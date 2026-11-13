import {
  AdditiveBlending, Box3, BoxGeometry, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, DirectionalLight, Fog, Group,
  HemisphereLight, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, PlaneGeometry,
  BackSide, PMREMGenerator, PointLight, Quaternion, Scene, ShaderMaterial, SphereGeometry, Sprite, SpriteMaterial, Vector3,
  type Material, type WebGLRenderer,
} from 'three';
import { TUNING } from '../tuning';
import type { World } from './World';
import { pieceMaterials } from './pieces';
import { rng, textures } from './textures';
import type { ModelKit } from '../rider/models';

export type Lighting = 'day' | 'night';

/** Direction the sun light comes from (shared by the sky, the sun light and the shadow camera). Low and warm: long, soft shadows. */
export const SUN_DIR = new Vector3(-48, 46, -30).normalize();

const PRESETS = {
  day: {
    sky: 0xb9d2e4, skyTop: 0x2a6fc4, skyGround: 0x6f7a55, hemiSky: 0xbcd6ff, hemiGround: 0x6a5a40, hemi: 1.25,
    sun: 0xffe2b8, sunI: 3.1, sunGlow: 0xffe6c0, fogNear: TUNING.render.fogNear, fogFar: TUNING.render.fogFar, stars: 0,
  },
  night: {
    sky: 0x17223d, skyTop: 0x03060f, skyGround: 0x0c0f14, hemiSky: 0x4a5a8a, hemiGround: 0x1a1612, hemi: 0.35,
    sun: 0x9fb4ff, sunI: 0.4, sunGlow: 0x8fa8ff, fogNear: 18, fogFar: 120, stars: 1,
  },
};

/** Gradient sky + sun/moon glow (+ stars at night), drawn on a big inside-out sphere. */
function skyMaterial(L: { sky: number; skyTop: number; skyGround: number; sunGlow: number; stars: number }, clouds: number) {
  return new ShaderMaterial({
    side: BackSide, depthWrite: false, fog: false, toneMapped: false,
    uniforms: {
      top: { value: new Color(L.skyTop) }, horizon: { value: new Color(L.sky) }, ground: { value: new Color(L.skyGround) },
      sunDir: { value: SUN_DIR.clone() },
      glow: { value: new Color(L.sunGlow) }, stars: { value: L.stars }, clouds: { value: clouds },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; }',
    fragmentShader: `
      uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sunDir; uniform vec3 glow; uniform float stars; uniform float clouds;
      varying vec3 vDir;
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453), b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
        float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453), d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
      float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 c = h > 0.0 ? mix(horizon, top, pow(smoothstep(0.0, 0.75, h), 0.8)) : mix(horizon, ground, smoothstep(0.0, 0.15, -h));
        float s = max(dot(d, normalize(sunDir)), 0.0);
        // atmosphere: horizon haze, warm forward scattering toward the sun, sun disc
        if (clouds > 0.5) {
          c = mix(c, horizon * 1.04, exp(-max(h, 0.0) * 9.0) * 0.55);
          c += glow * pow(s, 5.0) * 0.18 * exp(-max(h, 0.0) * 2.5);
          // layered clouds on a flat deck: stretched toward the horizon, lit on the sun side, grey-blue underneath
          if (h > 0.015) {
            vec2 cp = d.xz / (h + 0.22) * 1.35 + vec2(7.3, 2.1);
            float n = fbm(cp * 0.85) * 0.75 + fbm(cp * 2.6) * 0.25;
            float dens = smoothstep(0.50, 0.78, n);
            float lit = clamp(0.55 + 0.9 * dot(normalize(vec3(d.x, 0.35, d.z)), normalize(vec3(sunDir.x, 0.35, sunDir.z))) * 0.6 - (n - 0.55) * 1.2, 0.0, 1.0);
            vec3 cc = mix(vec3(0.62, 0.69, 0.80), vec3(1.0, 0.97, 0.92), lit);
            cc += glow * pow(s, 8.0) * 0.5;
            float fade = smoothstep(0.015, 0.16, h);
            c = mix(c, cc, dens * 0.92 * fade);
          }
        }
        c += glow * (pow(s, 900.0) * 3.0 + pow(s, 12.0) * 0.25);
        if (stars > 0.5 && h > 0.05) {
          float st = step(0.9975, hash(floor(d * 260.0)));
          c += vec3(st) * 0.9 * smoothstep(0.05, 0.4, h);
        }
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

export interface Decor {
  group: Group;
  sun: DirectionalLight;
  hemi: HemisphereLight;
  /** Per frame: move the real lights to the lamps nearest the rider (night). */
  update(riderPos: Vector3): void;
  dispose(): void;
}

/** Browser-only dressing: sky, fog, lights, textures, trees, rocks, dirt track, night lamps. */
/** `kit` = the Blender scenery kit (null → built-in shapes, e.g. on Graphics: Low). */
export function decorate(scene: Scene, world: World, renderer: WebGLRenderer, lighting: Lighting, kit: ModelKit | null = null): Decor {
  const L = PRESETS[lighting];
  const night = lighting === 'night';
  const D = world.def.decor ?? {};
  const theme = D.theme ?? 'meadow';
  const group = new Group();
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => { disposables.push(x); return x; };
  const aniso = renderer.capabilities.getMaxAnisotropy();

  scene.background = new Color(L.sky);
  scene.fog = new Fog(L.sky, L.fogNear, L.fogFar);
  const hemi = new HemisphereLight(L.hemiSky, L.hemiGround, L.hemi);
  hemi.userData.base = L.hemi;
  group.add(hemi);
  const sun = new DirectionalLight(L.sun, L.sunI);
  sun.position.copy(SUN_DIR).multiplyScalar(70);
  group.add(sun);

  // sky dome, and the same sky baked into an environment map for physical materials
  const skyMat = keep(skyMaterial(L, night ? 0 : 1));
  const skyGeo = keep(new SphereGeometry(450, 32, 16));
  const sky = new Mesh(skyGeo, skyMat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  sky.userData.noCast = sky.userData.noReceive = true;
  group.add(sky);
  const envScene = new Scene();
  envScene.add(new Mesh(skyGeo, skyMat));
  const pmrem = new PMREMGenerator(renderer);
  const env = keep(pmrem.fromScene(envScene, 0.04).texture);
  pmrem.dispose();
  scene.environment = env;
  scene.environmentIntensity = night ? 0.5 : 0.75;

  // ---------------------------------------------------------------- materials for park pieces
  const groundTex = keep(theme === 'forest' ? textures.forestFloor(aniso) : theme === 'urban' ? textures.concrete(aniso) : textures.grass(aniso));
  const concreteTex = keep(textures.concrete(aniso)), woodTex = keep(textures.wood(aniso));
  const hint = <T extends Material>(m: T, roughness: number, metalness = 0): T => { m.userData.pbr = { roughness, metalness }; return m; };
  const swap: Map<Material, Material> = new Map([
    [pieceMaterials.ground, keep(hint(new MeshLambertMaterial({ map: groundTex }), 1))],
    [pieceMaterials.dirtTop, keep(hint(new MeshLambertMaterial({ map: keep(textures.dirtTop(aniso)), color: 0xd8cabc, flatShading: true }), 1))],
    [pieceMaterials.dirtSide, keep(hint(new MeshLambertMaterial({ map: keep(textures.dirtSide(aniso)), flatShading: true, side: 2 }), 1))],
    [pieceMaterials.concrete, keep(hint(new MeshLambertMaterial({ map: concreteTex }), 0.88))],
    [pieceMaterials.concreteSide, keep(hint(new MeshLambertMaterial({ map: concreteTex, color: 0xd8d4cc, side: 2 }), 0.9))],
    [pieceMaterials.wood, keep(hint(new MeshLambertMaterial({ map: woodTex }), 0.62))],
    [pieceMaterials.woodSide, keep(hint(new MeshLambertMaterial({ color: 0x7c5a36, side: 2 }), 0.8))],
  ]);
  world.root.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh && swap.has(m.material as Material)) m.material = swap.get(m.material as Material)!;
  });

  // ---------------------------------------------------------------- dirt track along the line
  const path = world.path;
  if ((D.pathWidth ?? 0) > 0 && path.length > 1) {
    const mat = keep(new MeshLambertMaterial({ map: keep(textures.dirtTop(aniso)), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    const geo = keep(ribbon(path, D.pathWidth!, 0.02));
    const track = new Mesh(geo, mat);
    track.userData.noCast = true;
    group.add(track);
  }

  // ---------------------------------------------------------------- trees, rocks, ground cover
  const rand = rng(7);
  const clear = D.clear ?? 26;
  const nTrees = D.trees ?? 260;
  const spots: Vector3[] = [];
  const bounds = bbox(path, theme === 'forest' ? 60 : 200);
  const area = world.bounds.clone().expandByScalar(clear);
  const blocked = (p: Vector3, c: number) =>
    distToPath(p, path) < c || (!!D.solidArea && p.x > area.min.x && p.x < area.max.x && p.z > area.min.z && p.z < area.max.z);
  const randomSpot = (minClear: number, tries = 30): Vector3 | null => {
    for (let t = 0; t < tries; t++) {
      const p = new Vector3(bounds.x0 + rand() * (bounds.x1 - bounds.x0), 0, bounds.z0 + rand() * (bounds.z1 - bounds.z0));
      if (!blocked(p, minClear)) return p;
    }
    return null;
  };
  for (let tries = 0; spots.length < nTrees && tries < nTrees * 20; tries++) {
    const p = new Vector3(bounds.x0 + rand() * (bounds.x1 - bounds.x0), 0, bounds.z0 + rand() * (bounds.z1 - bounds.z0));
    if (blocked(p, clear + rand() * 4)) continue;
    spots.push(p);
  }
  const forest = theme === 'forest';
  const m = new Matrix4(), q = new Quaternion(), s = new Vector3(), p = new Vector3(), col = new Color();
  const UPY = new Vector3(0, 1, 0);

  // ---- Blender kit (public/models/scenery.glb), instanced: one draw call per kind × material
  type Xf = { pos: Vector3; yaw: number; scale: number; sy?: number; tint?: Color };
  const kitMats = new Map<string, Material>();
  const TINTED = new Set(['leaves', 'wall', 'rock', 'grass']);
  const kitMat = (key: string): Material => {
    let mm = kitMats.get(key);
    if (mm) return mm;
    const L = (color: number, rough: number, metal = 0, extra: object = {}) =>
      keep(hint(new MeshLambertMaterial({ color, ...extra }), rough, metal));
    switch (key) {
      case 'leaves': mm = L(0xffffff, 0.9); break;
      case 'grass': mm = L(0xffffff, 1, 0, { side: 2 }); break;
      case 'wall': mm = L(0xffffff, 0.92); break;
      case 'rock': mm = L(0xffffff, 0.95); break;
      case 'bark': mm = L(0x5a4030, 0.95); break;
      case 'birchbark': mm = L(0xe6e1d6, 0.8); break;
      case 'window': mm = L(0x2b3646, 0.25, 0.3, night ? { emissive: 0xffb55a, emissiveIntensity: 0.55 } : {}); break;
      case 'roof': mm = L(0x55585e, 0.9); break;
      case 'trim': mm = L(0xd9d5cc, 0.85); break;
      case 'wood': mm = L(0x8a5a33, 0.75); break;
      case 'metal': mm = L(0x3d4248, 0.45, 0.6); break;
      case 'awning': mm = L(0xb3392f, 0.85); break;
      case 'bulb': mm = keep(new MeshBasicMaterial({ color: new Color(0xffe2a8).multiplyScalar(4) })); break;
      default: mm = L(0x888888, 0.9);
    }
    kitMats.set(key, mm);
    return mm;
  };
  /** Place many copies of a kit kind. Returns false if the kit doesn't have it. */
  const instance = (kind: string, xfs: Xf[], flags: { tree?: boolean; noCast?: boolean } = {}): boolean => {
    const pieces = kit?.get(kind);
    if (!pieces || !xfs.length) return !!pieces;
    for (const pc of pieces) {
      const im = new InstancedMesh(pc.geometry, kitMat(pc.mat), xfs.length);
      xfs.forEach((x, i) => {
        m.compose(x.pos, q.setFromAxisAngle(UPY, x.yaw), s.set(x.scale, x.scale * (x.sy ?? 1), x.scale));
        im.setMatrixAt(i, m);
        if (TINTED.has(pc.mat)) im.setColorAt(i, x.tint ?? col.set(0xffffff));
      });
      im.computeBoundingSphere();
      if (flags.tree) im.userData.tree = true;
      if (flags.noCast) im.userData.noCast = true;
      group.add(im);
    }
    return true;
  };
  const pick = <T,>(w: [T, number][]): T => {
    let r = rand() * w.reduce((a, [, x]) => a + x, 0);
    for (const [v, x] of w) if ((r -= x) <= 0) return v;
    return w[0][0];
  };
  const leafTint = (kind: string) => kind === 'birch'
    ? new Color().setHSL(0.24 + rand() * 0.06, 0.45, 0.36 + rand() * 0.08)
    : new Color().setHSL(0.28 + rand() * 0.08, forest ? 0.42 : 0.4, (forest ? 0.2 : 0.26) + rand() * 0.1);

  if (kit) {
    const weights: [string, number][] = forest ? [['pine_a', 45], ['pine_b', 40], ['birch', 15]]
      : theme === 'urban' ? [['oak', 50], ['pine_a', 30], ['birch', 20]] : [['pine_a', 30], ['oak', 35], ['birch', 20], ['pine_b', 15]];
    const byKind = new Map<string, Xf[]>();
    for (const v of spots) {
      const kind = pick(weights);
      const sc = (forest ? 0.85 : 0.7) + rand() * (forest ? 0.75 : 0.55);
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind)!.push({ pos: v, yaw: rand() * 6.28, scale: sc, sy: 0.9 + rand() * 0.25, tint: leafTint(kind) });
    }
    for (const [kind, xfs] of byKind) instance(kind, xfs, { tree: true });

    // bushes + stumps near the edge of the clearing, grass tufts closer in
    if (theme !== 'urban' || !D.solidArea) {
      const bushes: Xf[] = [], tufts: Xf[] = [], stumps: Xf[] = [];
      const minPath = Math.max((D.pathWidth ?? 0) / 2 + 1.2, 3);
      for (let i = 0; i < Math.round(nTrees * 0.35); i++) {
        const v = randomSpot(clear * 0.55);
        if (v) bushes.push({ pos: v, yaw: rand() * 6.28, scale: 0.7 + rand() * 0.8, tint: leafTint('bush') });
      }
      for (let i = 0; i < (forest ? 900 : 600); i++) {
        const v = randomSpot(minPath + rand() * clear, 12);
        if (v) tufts.push({ pos: v, yaw: rand() * 6.28, scale: 1 + rand() * 1.4, tint: new Color().setHSL(0.24 + rand() * 0.07, 0.45, 0.3 + rand() * 0.1) });
      }
      if (forest) for (let i = 0; i < 30; i++) { const v = randomSpot(clear * 0.6); if (v) stumps.push({ pos: v, yaw: rand() * 6.28, scale: 0.8 + rand() * 0.6 }); }
      instance('bush', bushes);
      instance('grass', tufts, { noCast: true });
      instance('stump', stumps);
    }

    const rocks: Xf[] = [];
    for (let i = 0; i < (D.rocks ?? 60); i++) {
      const v = randomSpot(clear * 0.6, 20);
      if (v) rocks.push({ pos: v.setY(-0.1), yaw: rand() * 6.28, scale: 0.35 + rand() * 0.95, sy: 0.8 + rand() * 0.4, tint: new Color().setHSL(0.1, 0.04 + rand() * 0.05, 0.42 + rand() * 0.14) });
    }
    const rockKinds = ['rock_a', 'rock_b', 'rock_c'];
    rockKinds.forEach((k, j) => instance(k, rocks.filter((_, i) => i % 3 === j)));
  } else {
    // built-in shapes (Graphics: Low, or the kit didn't load)
    const crownMat = keep(hint(new MeshLambertMaterial({ color: 0xffffff, flatShading: true }), 0.95));
    const crown = new InstancedMesh(keep(new ConeGeometry(1, 1, 6)), crownMat, spots.length);
    const trunk = new InstancedMesh(keep(new CylinderGeometry(0.18, 0.25, 1, 5)), keep(new MeshLambertMaterial({ color: 0x5b4030 })), spots.length);
    spots.forEach((v, i) => {
      const h = (forest ? 8 : 5) + rand() * (forest ? 12 : 7), w = (forest ? 1.8 : 1.6) + rand() * 1.6;
      m.compose(p.set(v.x, 1.4 + h / 2, v.z), q.identity(), s.set(w, h, w));
      crown.setMatrixAt(i, m);
      m.compose(p.set(v.x, 1.0, v.z), q, s.set(1, 2.0, 1));
      trunk.setMatrixAt(i, m);
      crown.setColorAt(i, col.setHSL(0.3 + rand() * 0.08, forest ? 0.42 : 0.38, (forest ? 0.2 : 0.27) + rand() * 0.1));
    });
    crown.userData.tree = trunk.userData.tree = true;
    group.add(crown, trunk);

    const nRocks = D.rocks ?? 60;
    const rocks = new InstancedMesh(keep(new IcosahedronGeometry(1, 0)), keep(new MeshLambertMaterial({ color: 0x8b8b84, flatShading: true })), nRocks);
    for (let i = 0; i < nRocks; i++) {
      const v = randomSpot(clear * 0.6, 20) ?? new Vector3();
      const sc = 0.3 + rand() * 0.9;
      m.compose(p.set(v.x, sc * 0.3, v.z), q.setFromAxisAngle(UPY, rand() * 6), s.set(sc, sc * 0.7, sc));
      rocks.setMatrixAt(i, m);
    }
    group.add(rocks);
  }

  // ---------------------------------------------------------------- urban: buildings, street furniture
  const nb = D.buildings ?? 0;
  const cx = (world.bounds.min.x + world.bounds.max.x) / 2, cz = (world.bounds.min.z + world.bounds.max.z) / 2;
  if (nb > 0) {
    const ring = world.bounds.clone().expandByScalar(clear + 6);
    const xfs: Xf[] = [];
    for (let i = 0; i < nb; i++) {
      const side = i % 4, t = rand();
      const x = side < 2 ? ring.min.x + t * (ring.max.x - ring.min.x) : side === 2 ? ring.min.x - 8 : ring.max.x + 8;
      const z = side >= 2 ? ring.min.z + t * (ring.max.z - ring.min.z) : side === 0 ? ring.min.z - 8 : ring.max.z + 8;
      xfs.push({ pos: new Vector3(x, 0, z), yaw: Math.atan2(cx - x, cz - z), scale: 1, tint: new Color().setHSL(0.06 + rand() * 0.07, 0.12 + rand() * 0.18, 0.5 + rand() * 0.18) });
    }
    if (kit?.has('building_a')) {
      ['building_a', 'building_b', 'building_c'].forEach((k, j) => instance(k, xfs.filter((_, i) => i % 3 === j)));
    } else {
      const bm = new InstancedMesh(keep(new BoxGeometry(1, 1, 1).translate(0, 0.5, 0)), keep(new MeshLambertMaterial({ color: 0xffffff })), nb);
      xfs.forEach((x, i) => {
        const w = 8 + rand() * 10, h = 6 + rand() * 18;
        m.compose(x.pos, q.identity(), s.set(w, h, w));
        bm.setMatrixAt(i, m);
        bm.setColorAt(i, col.setHSL(0.08 + rand() * 0.06, 0.12 + rand() * 0.1, (night ? 0.18 : 0.55) + rand() * 0.15));
      });
      group.add(bm);
    }
  }
  if (kit && theme === 'urban') {
    // benches and bins around the edge of the park, railings a little further out
    const benches: Xf[] = [], bins: Xf[] = [], rails: Xf[] = [];
    let k = 0;
    for (const [pt, dir] of samplePath(perimeter(world.bounds.clone().expandByScalar(3)), 9)) {
      const yaw = Math.atan2(cx - pt.x, cz - pt.z);
      (k++ % 3 === 2 ? bins : benches).push({ pos: pt, yaw: k % 3 === 2 ? 0 : Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2), scale: 1 });
      void dir;
    }
    k = 0;
    for (const [pt, dir] of samplePath(perimeter(world.bounds.clone().expandByScalar(6)), 4)) {
      if (k++ % 6 === 5) continue; // gaps to walk through
      rails.push({ pos: pt, yaw: Math.atan2(-dir.z, dir.x), scale: 1 });
    }
    instance('bench', benches);
    instance('bin', bins);
    instance('railing', rails);
  }

  // ---------------------------------------------------------------- night: lamp posts
  const lampPos: Vector3[] = [];
  const pool: PointLight[] = [];
  let riderLight: PointLight | null = null;
  if (night) {
    const spacing = D.lamps ?? 25;
    const poleMat = keep(new MeshLambertMaterial({ color: 0x30343a }));
    const bulbMat = keep(new MeshBasicMaterial({ color: new Color(0xffe2a8).multiplyScalar(4) })); // HDR → blooms on High
    const glowTex = keep(textures.radial());
    const poolMat = keep(new MeshBasicMaterial({ map: glowTex, color: 0xffb860, transparent: true, opacity: 0.35, depthWrite: false, blending: AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4 }));
    const haloMat = keep(new SpriteMaterial({ map: glowTex, color: 0xffd28a, transparent: true, opacity: 0.8, depthWrite: false, blending: AdditiveBlending }));
    const poleGeo = keep(new CylinderGeometry(0.07, 0.1, 5.5, 6)), bulbGeo = keep(new SphereGeometry(0.18, 8, 6));
    const poolGeo = keep(new PlaneGeometry(12, 12).rotateX(-Math.PI / 2));
    let side = 1;
    const lampXfs: Xf[] = [];
    const lampPath = D.lampLayout === 'perimeter' ? perimeter(world.bounds.clone().expandByScalar(5)) : path;
    for (const [pt, dir] of samplePath(lampPath, spacing)) {
      const off = new Vector3(dir.z, 0, -dir.x).multiplyScalar(side * ((D.pathWidth ?? 4) / 2 + 3.5));
      side = -side;
      const base = pt.clone().add(off);
      const bulbPos = base.clone().setY(5.5);
      if (kit?.has('lamp')) {
        // arm reaches toward the riding line; the model's bulb sits 0.9 m out along +X at 5.33 m
        const toward = off.clone().negate().normalize();
        lampXfs.push({ pos: base, yaw: Math.atan2(-toward.z, toward.x), scale: 1 });
        bulbPos.set(base.x + toward.x * 0.9, 5.33, base.z + toward.z * 0.9);
      } else {
        const pole = new Mesh(poleGeo, poleMat); pole.position.copy(base).setY(2.75);
        const bulb = new Mesh(bulbGeo, bulbMat); bulb.position.copy(bulbPos);
        bulb.userData.noCast = true;
        group.add(pole, bulb);
      }
      const halo = new Sprite(haloMat); halo.position.copy(bulbPos); halo.scale.set(2.2, 2.2, 1);
      const pl = new Mesh(poolGeo, poolMat); pl.position.set(bulbPos.x, 0.03, bulbPos.z);
      pl.userData.noCast = pl.userData.noReceive = true;
      group.add(halo, pl);
      lampPos.push(bulbPos);
    }
    instance('lamp', lampXfs);
    for (let i = 0; i < 4; i++) {
      const l = new PointLight(0xffc27a, 0, 26, 1.6);
      pool.push(l);
      group.add(l);
    }
    riderLight = new PointLight(0xdfe8ff, 14, 22, 1.4);
    group.add(riderLight);
  }

  scene.add(group);
  const order: number[] = lampPos.map((_, i) => i);
  return {
    group,
    sun,
    hemi,
    update(riderPos: Vector3) {
      if (!night) return;
      order.sort((a, b) => lampPos[a].distanceToSquared(riderPos) - lampPos[b].distanceToSquared(riderPos));
      pool.forEach((l, i) => {
        const idx = order[i];
        if (idx === undefined) { l.intensity = 0; return; }
        l.position.copy(lampPos[idx]);
        l.intensity = 60;
      });
      riderLight!.position.set(riderPos.x, riderPos.y + 5, riderPos.z);
    },
    dispose() {
      scene.remove(group);
      scene.remove(sun.target);
      scene.environment = null;
      disposables.forEach((d) => d.dispose());
    },
  };
}

// --------------------------------------------------------------------------- helpers
function perimeter(b: Box3): Vector3[] {
  const y = 0;
  return [new Vector3(b.min.x, y, b.min.z), new Vector3(b.max.x, y, b.min.z), new Vector3(b.max.x, y, b.max.z), new Vector3(b.min.x, y, b.max.z), new Vector3(b.min.x, y, b.min.z)];
}

function distToPath(p: Vector3, path: Vector3[]): number {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const abx = b.x - a.x, abz = b.z - a.z;
    const l2 = abx * abx + abz * abz || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2));
    best = Math.min(best, Math.hypot(p.x - a.x - abx * t, p.z - a.z - abz * t));
  }
  return path.length === 1 ? Math.hypot(p.x - path[0].x, p.z - path[0].z) : best;
}

function bbox(path: Vector3[], pad: number) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of path) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  return { x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad };
}

/** Points every `spacing` metres along the path, with the local direction. */
function* samplePath(path: Vector3[], spacing: number): Generator<[Vector3, Vector3]> {
  let carry = spacing * 0.5;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const d = new Vector3(b.x - a.x, 0, b.z - a.z);
    const len = d.length();
    if (len < 1e-3) continue;
    d.divideScalar(len);
    for (let s = carry; s < len; s += spacing) yield [new Vector3(a.x + d.x * s, 0, a.z + d.z * s), d.clone()];
    carry = (carry - len) % spacing;
    if (carry < 0) carry += spacing;
  }
}

/** Flat strip following a polyline (visual dirt track). */
function ribbon(path: Vector3[], width: number, y: number): BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  let dist = 0;
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    const nx = dz / l, nz = -dx / l;
    if (i > 0) dist += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    for (const sgn of [-1, 1]) {
      pos.push(path[i].x + nx * sgn * width / 2, y, path[i].z + nz * sgn * width / 2);
      uv.push(sgn < 0 ? 0 : width / 4, dist / 2);
    }
    if (i > 0) {
      const k = (i - 1) * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // computeVertexNormals may point down depending on winding; force up
  const n = g.getAttribute('normal');
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return g;
}
