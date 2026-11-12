import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, DirectionalLight, Fog, Group,
  HemisphereLight, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, PlaneGeometry,
  PointLight, Quaternion, Scene, SphereGeometry, Sprite, SpriteMaterial, Vector3, type Material, type WebGLRenderer,
} from 'three';
import { TUNING } from '../tuning';
import type { World } from './World';
import { pieceMaterials } from './pieces';
import { rng, textures } from './textures';

export type Lighting = 'day' | 'night';

const PRESETS = {
  day: { sky: 0xa9d4ee, hemiSky: 0xdff1ff, hemiGround: 0x5d4a35, hemi: 1.5, sun: 0xfff0d6, sunI: 2.2, fogNear: TUNING.render.fogNear, fogFar: TUNING.render.fogFar },
  night: { sky: 0x0b1326, hemiSky: 0x4a5a8a, hemiGround: 0x1a1612, hemi: 0.35, sun: 0x9fb4ff, sunI: 0.35, fogNear: 18, fogFar: 120 },
};

export interface Decor {
  group: Group;
  /** Per frame: move the real lights to the lamps nearest the rider (night). */
  update(riderPos: Vector3): void;
  dispose(): void;
}

/** Browser-only dressing: sky, fog, lights, textures, trees, rocks, dirt track, night lamps. */
export function decorate(scene: Scene, world: World, renderer: WebGLRenderer, lighting: Lighting): Decor {
  const L = PRESETS[lighting];
  const D = world.def.decor ?? {};
  const theme = D.theme ?? 'meadow';
  const group = new Group();
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => { disposables.push(x); return x; };
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const night = lighting === 'night';

  scene.background = new Color(L.sky);
  scene.fog = new Fog(L.sky, L.fogNear, L.fogFar);
  group.add(new HemisphereLight(L.hemiSky, L.hemiGround, L.hemi));
  const sun = new DirectionalLight(L.sun, L.sunI);
  sun.position.set(-30, 60, -20);
  group.add(sun);

  // ---------------------------------------------------------------- materials for park pieces
  const groundTex = keep(theme === 'forest' ? textures.forestFloor(aniso) : textures.grass(aniso));
  const swap: Map<Material, Material> = new Map([
    [pieceMaterials.ground, keep(new MeshLambertMaterial({ map: groundTex }))],
    [pieceMaterials.dirtTop, keep(new MeshLambertMaterial({ map: keep(textures.dirtTop(aniso)), flatShading: true }))],
    [pieceMaterials.dirtSide, keep(new MeshLambertMaterial({ map: keep(textures.dirtSide(aniso)), flatShading: true, side: 2 }))],
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
    group.add(new Mesh(geo, mat));
  }

  // ---------------------------------------------------------------- trees + rocks
  const rand = rng(7);
  const clear = D.clear ?? 26;
  const nTrees = D.trees ?? 260;
  const spots: Vector3[] = [];
  const bounds = bbox(path, theme === 'forest' ? 60 : 200);
  for (let tries = 0; spots.length < nTrees && tries < nTrees * 20; tries++) {
    const p = new Vector3(bounds.x0 + rand() * (bounds.x1 - bounds.x0), 0, bounds.z0 + rand() * (bounds.z1 - bounds.z0));
    if (distToPath(p, path) < clear + rand() * 4) continue;
    spots.push(p);
  }
  const forest = theme === 'forest';
  const crown = new InstancedMesh(keep(new ConeGeometry(1, 1, 6)), keep(new MeshLambertMaterial({ color: 0xffffff, flatShading: true })), spots.length);
  const trunk = new InstancedMesh(keep(new CylinderGeometry(0.18, 0.25, 1, 5)), keep(new MeshLambertMaterial({ color: 0x5b4030 })), spots.length);
  const m = new Matrix4(), q = new Quaternion(), s = new Vector3(), p = new Vector3(), col = new Color();
  spots.forEach((v, i) => {
    const h = (forest ? 8 : 5) + rand() * (forest ? 12 : 7), w = (forest ? 1.8 : 1.6) + rand() * 1.6;
    m.compose(p.set(v.x, 1.4 + h / 2, v.z), q.identity(), s.set(w, h, w));
    crown.setMatrixAt(i, m);
    m.compose(p.set(v.x, 1.0, v.z), q, s.set(1, 2.0, 1));
    trunk.setMatrixAt(i, m);
    crown.setColorAt(i, col.setHSL(0.3 + rand() * 0.08, forest ? 0.42 : 0.38, (forest ? 0.2 : 0.27) + rand() * 0.1));
  });
  group.add(crown, trunk);

  const nRocks = D.rocks ?? 60;
  const rocks = new InstancedMesh(keep(new IcosahedronGeometry(1, 0)), keep(new MeshLambertMaterial({ color: 0x8b8b84, flatShading: true })), nRocks);
  for (let i = 0; i < nRocks; i++) {
    let x = 0, z = 0;
    for (let t = 0; t < 20; t++) {
      x = bounds.x0 + rand() * (bounds.x1 - bounds.x0); z = bounds.z0 + rand() * (bounds.z1 - bounds.z0);
      if (distToPath(p.set(x, 0, z), path) > clear * 0.6) break;
    }
    const sc = 0.3 + rand() * 0.9;
    m.compose(p.set(x, sc * 0.3, z), q.setFromAxisAngle(new Vector3(0, 1, 0), rand() * 6), s.set(sc, sc * 0.7, sc));
    rocks.setMatrixAt(i, m);
  }
  group.add(rocks);

  // ---------------------------------------------------------------- night: lamp posts
  const lampPos: Vector3[] = [];
  const pool: PointLight[] = [];
  let riderLight: PointLight | null = null;
  if (night) {
    const spacing = D.lamps ?? 25;
    const poleMat = keep(new MeshLambertMaterial({ color: 0x30343a }));
    const bulbMat = keep(new MeshBasicMaterial({ color: 0xffe2a8 }));
    const glowTex = keep(textures.radial());
    const poolMat = keep(new MeshBasicMaterial({ map: glowTex, color: 0xffb860, transparent: true, opacity: 0.35, depthWrite: false, blending: AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4 }));
    const haloMat = keep(new SpriteMaterial({ map: glowTex, color: 0xffd28a, transparent: true, opacity: 0.8, depthWrite: false, blending: AdditiveBlending }));
    const poleGeo = keep(new CylinderGeometry(0.07, 0.1, 5.5, 6)), bulbGeo = keep(new SphereGeometry(0.18, 8, 6));
    const poolGeo = keep(new PlaneGeometry(12, 12).rotateX(-Math.PI / 2));
    let side = 1;
    for (const [pt, dir] of samplePath(path, spacing)) {
      const off = new Vector3(dir.z, 0, -dir.x).multiplyScalar(side * ((D.pathWidth ?? 4) / 2 + 3.5));
      side = -side;
      const base = pt.clone().add(off);
      const pole = new Mesh(poleGeo, poleMat); pole.position.copy(base).setY(2.75);
      const bulb = new Mesh(bulbGeo, bulbMat); bulb.position.copy(base).setY(5.5);
      const halo = new Sprite(haloMat); halo.position.copy(bulb.position); halo.scale.set(2.2, 2.2, 1);
      const pl = new Mesh(poolGeo, poolMat); pl.position.copy(base).setY(0.03);
      group.add(pole, bulb, halo, pl);
      lampPos.push(bulb.position.clone());
    }
    for (let i = 0; i < 4; i++) {
      const l = new PointLight(0xffc27a, 0, 26, 1.6);
      pool.push(l);
      group.add(l);
    }
    riderLight = new PointLight(0xdfe8ff, 9, 16, 1.4);
    group.add(riderLight);
  }

  scene.add(group);
  const order: number[] = lampPos.map((_, i) => i);
  return {
    group,
    update(riderPos: Vector3) {
      if (!night) return;
      order.sort((a, b) => lampPos[a].distanceToSquared(riderPos) - lampPos[b].distanceToSquared(riderPos));
      pool.forEach((l, i) => {
        const idx = order[i];
        if (idx === undefined) { l.intensity = 0; return; }
        l.position.copy(lampPos[idx]);
        l.intensity = 60;
      });
      riderLight!.position.set(riderPos.x, riderPos.y + 3, riderPos.z);
    },
    dispose() {
      scene.remove(group);
      disposables.forEach((d) => d.dispose());
    },
  };
}

// --------------------------------------------------------------------------- helpers
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
