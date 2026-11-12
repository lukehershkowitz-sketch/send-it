import {
  BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, DoubleSide, Material, Mesh, MeshLambertMaterial, PlaneGeometry, Vector3,
} from 'three';
import { DEG } from '../core/math';
import { extrudeRuns, flaredSides, profileSides, Turtle, type P2 } from './geometry';
import type { ColliderKind, Lip, RailSeg } from './World';

/**
 * Modular park pieces. Every piece is built in local space (+Z = forward/downhill direction,
 * origin at the start of the piece on the ground) and placed by `pos` + `yaw` from park JSON.
 */
export type PieceDef =
  | { type: 'ground'; pos: [number, number, number]; yaw?: number; size: number }
  | { type: 'kicker'; pos: [number, number, number]; yaw?: number; height: number; angle: number; width: number; flare?: number; surface?: Surface }
  | {
      type: 'landing'; pos: [number, number, number]; yaw?: number;
      height: number; slope: number; width: number; deck?: number; faceAngle?: number;
      knuckleRadius?: number; transitionRadius?: number; flare?: number; surface?: Surface;
    }
  | { type: 'rail'; pos: Vec; yaw?: number; length: number; height: number; drop?: number }
  | { type: 'ledge'; pos: Vec; yaw?: number; length: number; height: number; width: number; drop?: number; surface?: Surface }
  /** Quarter pipe: transition (radius, top angle) up to `height`, coping, flat deck behind. */
  | { type: 'quarter'; pos: Vec; yaw?: number; height: number; radius: number; angle?: number; width: number; deck?: number; surface?: Surface }
  /** 90° bowl corner joining two quarters (see parks/README note in pieces.ts). */
  | { type: 'corner'; pos: Vec; yaw?: number; height: number; radius: number; angle?: number; cornerRadius: number; deck?: number; surface?: Surface }
  /** Box jump: ramp up, flat deck, ramp down. */
  | { type: 'funbox'; pos: Vec; yaw?: number; height: number; angle: number; deck: number; width: number; surface?: Surface }
  /** Straight bank/wedge up to a deck (turn it around to land on). */
  | { type: 'wedge'; pos: Vec; yaw?: number; height: number; angle: number; deck?: number; width: number; surface?: Surface }
  /** Stair set going down in +Z, with a platform at the top. */
  | { type: 'stairs'; pos: Vec; yaw?: number; steps: number; rise: number; run: number; top: number; width: number; surface?: Surface }
  /** Plain raised block / platform. */
  | { type: 'block'; pos: Vec; yaw?: number; length: number; width: number; height: number; grind?: boolean; surface?: Surface };

type Vec = [number, number, number];
export type Surface = 'dirt' | 'concrete' | 'wood';

export interface BuiltPart { mesh: Mesh; collide: ColliderKind | null }
export interface BuiltPiece { parts: BuiltPart[]; lips: Lip[]; rails?: RailSeg[]; length?: number }

const mats = {
  dirtTop: new MeshLambertMaterial({ color: 0xb98454, flatShading: true }),
  dirtSide: new MeshLambertMaterial({ color: 0x9a6a42, flatShading: true, side: DoubleSide }),
  metal: new MeshLambertMaterial({ color: 0xc9d1d8 }),
  post: new MeshLambertMaterial({ color: 0x4b545c }),
  ground: new MeshLambertMaterial({ color: 0x8fa36a }),
  concrete: new MeshLambertMaterial({ color: 0xb8b4aa }),
  concreteSide: new MeshLambertMaterial({ color: 0x9d998f, side: DoubleSide }),
  wood: new MeshLambertMaterial({ color: 0xc89b62 }),
  woodSide: new MeshLambertMaterial({ color: 0x7c5a36, side: DoubleSide }),
  coping: new MeshLambertMaterial({ color: 0x8d949a }),
};
/** Decor code swaps in a textured ground material in the browser. */
export const pieceMaterials: Record<string, Material> = mats;

const part = (geo: BufferGeometry, mat: Material, collide: ColliderKind | null): BuiltPart => ({
  mesh: new Mesh(geo, mat),
  collide,
});

const topMat = (s: Surface | undefined) => (s === 'wood' ? mats.wood : s === 'dirt' ? mats.dirtTop : mats.concrete);
const sideMat = (s: Surface | undefined) => (s === 'wood' ? mats.woodSide : s === 'dirt' ? mats.dirtSide : mats.concreteSide);

/** Kickers/landings: dirt mounds get flared sides, built (wood/concrete) ones get straight sides. */
function moundParts(runs: P2[][], width: number, flare: number | undefined, surface: Surface | undefined): BuiltPart[] {
  if (surface && surface !== 'dirt') return profilePiece(runs, width, surface);
  return [part(extrudeRuns(runs, width), mats.dirtTop, 'surface'), part(flaredSides(runs, width, flare ?? 0.7), mats.dirtSide, 'surface')];
}

/** Extruded profile piece with vertical sides. */
function profilePiece(runs: P2[][], width: number, surface: Surface | undefined): BuiltPart[] {
  return [part(extrudeRuns(runs, width), topMat(surface), 'surface'), part(profileSides(runs, width), sideMat(surface), 'surface')];
}

/** Coping pipe along X at (y, z), visual only (the RailSeg does the work). */
function copingMesh(width: number, y: number, z: number): BuiltPart {
  return part(new CylinderGeometry(0.035, 0.035, width, 8).rotateZ(Math.PI / 2).translate(0, y, z), mats.coping, null);
}

/** Transition profile of a quarter. Returns runs and the z of the coping. */
export function quarterProfile(H: number, R: number, angleDeg: number, deck: number): { runs: P2[][]; top: number } {
  let a = Math.min(angleDeg, 90) * DEG;
  if (R * (1 - Math.cos(a)) > H) a = Math.acos(1 - H / R);
  const t = new Turtle().arc(R, a, 24);
  if (t.y < H - 1e-3) t.line((H - t.y) / Math.sin(a), 3);
  t.pts[t.pts.length - 1][1] = H;
  const top = t.pts[t.pts.length - 1][0];
  const runs: P2[][] = [t.pts];
  if (deck > 0) runs.push([[top, H], [top + deck, H]]);
  runs.push([[top + deck, H], [top + deck, 0]]);
  return { runs, top };
}

/** Sweep profile runs 90° around the Y axis (bowl corner). Profile z = distance outward from `r0`. */
function revolve(runs: P2[][], r0: number, segs: number): BufferGeometry[] {
  return runs.map((run) => {
    const pos: number[] = [], idx: number[] = [], uv: number[] = [];
    for (let j = 0; j <= segs; j++) {
      const phi = (j / segs) * Math.PI / 2;
      for (const [z, y] of run) {
        const rho = r0 + z;
        pos.push(rho * Math.cos(phi), y, rho * Math.sin(phi));
        uv.push(phi * rho * 0.5, (z + y) * 0.5);
      }
    }
    const n = run.length;
    for (let j = 0; j < segs; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  });
}

/** Box with an optionally sloped top (drop = how much lower the far end is). */
function slopedBox(W: number, L: number, H: number, drop: number): BufferGeometry {
  const g = new BoxGeometry(W, H, L).translate(0, H / 2, L / 2);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) if (p.getY(i) > H / 2) p.setY(i, H - (drop * p.getZ(i)) / L);
  g.computeVertexNormals();
  return g;
}

export function kickerProfile(height: number, angleDeg: number): { runs: P2[][]; length: number } {
  const a = angleDeg * DEG;
  const R = height / (1 - Math.cos(a));
  const t = new Turtle().arc(R, a, 20);
  const length = t.z;
  return { runs: [t.pts, [[length, height], [length, 0]]], length };
}

export function landingProfile(d: Extract<PieceDef, { type: 'landing' }>): P2[][] {
  const H = d.height, a = d.slope * DEG;
  const face = (d.faceAngle ?? 50) * DEG;
  const rk = d.knuckleRadius ?? 2.5, rt = d.transitionRadius ?? 5;
  const deck = d.deck ?? 0.6;
  const faceRun = H / Math.tan(face);
  const front: P2[] = [[0, 0], [faceRun, H]];
  const knuckleDrop = rk * (1 - Math.cos(a));
  const transDrop = rt * (1 - Math.cos(a));
  const slopeLen = Math.max(0.2, (H - knuckleDrop - transDrop) / Math.sin(a));
  const t = new Turtle(faceRun, H, 0).line(deck).arc(rk, -a, 10).line(slopeLen, 4).arc(rt, a, 12);
  t.pts[t.pts.length - 1][1] = 0; // seat exactly on the ground
  return [front, t.pts];
}

export function buildPiece(def: PieceDef): BuiltPiece {
  switch (def.type) {
    case 'ground': {
      const g = new PlaneGeometry(def.size, def.size, 1, 1).rotateX(-Math.PI / 2);
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * def.size / 4, uv.getY(i) * def.size / 4);
      return { parts: [part(g, mats.ground, 'surface')], lips: [] };
    }
    case 'kicker': {
      const { runs, length } = kickerProfile(def.height, def.angle);
      return {
        parts: moundParts(runs, def.width, def.flare, def.surface),
        length,
        lips: [{
          pos: new Vector3(0, def.height, length),
          dir: new Vector3(0, 0, 1),
          right: new Vector3(-1, 0, 0),
          width: def.width,
          length,
        }],
      };
    }
    case 'landing': {
      const runs = landingProfile(def);
      const last = runs[runs.length - 1];
      return {
        parts: moundParts(runs, def.width, def.flare, def.surface),
        length: last[last.length - 1][0],
        lips: [],
      };
    }
    case 'ledge': {
      const { length: L, height: H, width: W } = def;
      const drop = def.drop ?? 0;
      const parts = [part(slopedBox(W, L, H, drop), topMat(def.surface), 'surface')];
      const rails = [];
      for (const x of [W / 2, -W / 2]) {
        const edge = new BoxGeometry(0.05, 0.04, L).translate(x, H - 0.015, L / 2);
        const ep = edge.getAttribute('position');
        for (let i = 0; i < ep.count; i++) ep.setY(i, ep.getY(i) - (drop * ep.getZ(i)) / L);
        parts.push(part(edge, mats.coping, null));
        rails.push({ a: new Vector3(x, H - 0.02, 0), b: new Vector3(x, H - drop - 0.02, L), radius: 0.02 });
      }
      return { parts, lips: [], rails, length: L };
    }
    case 'block': {
      const { length: L, height: H, width: W } = def;
      const parts = [part(slopedBox(W, L, H, 0), topMat(def.surface), 'surface')];
      const rails = def.grind ? [W / 2, -W / 2].map((x) => ({ a: new Vector3(x, H - 0.02, 0), b: new Vector3(x, H - 0.02, L), radius: 0.02 })) : [];
      return { parts, lips: [], rails, length: L };
    }
    case 'quarter': {
      const { runs, top } = quarterProfile(def.height, def.radius, def.angle ?? 88, def.deck ?? 2);
      return {
        parts: [...profilePiece(runs, def.width, def.surface ?? 'concrete'), copingMesh(def.width, def.height, top)],
        lips: [],
        rails: [{ a: new Vector3(-def.width / 2, def.height, top), b: new Vector3(def.width / 2, def.height, top), radius: 0.035, coping: true }],
        length: top + (def.deck ?? 2),
      };
    }
    case 'corner': {
      const { runs, top } = quarterProfile(def.height, def.radius, def.angle ?? 88, def.deck ?? 2);
      const geos = revolve(runs, def.cornerRadius, 20);
      const parts = geos.map((g, i) => part(g, i === 0 ? topMat(def.surface ?? 'concrete') : sideMat(def.surface ?? 'concrete'), 'surface' as const));
      const rails: RailSeg[] = [];
      const rho = def.cornerRadius + top, n = 8;
      for (let i = 0; i < n; i++) {
        const p0 = (i / n) * Math.PI / 2, p1 = ((i + 1) / n) * Math.PI / 2;
        rails.push({ a: new Vector3(rho * Math.cos(p0), def.height, rho * Math.sin(p0)), b: new Vector3(rho * Math.cos(p1), def.height, rho * Math.sin(p1)), radius: 0.035, coping: true });
        const len = rails[i].a.distanceTo(rails[i].b);
        const mid = rails[i].a.clone().add(rails[i].b).multiplyScalar(0.5);
        const cyl = new CylinderGeometry(0.035, 0.035, len, 6).rotateZ(Math.PI / 2).rotateY(-(p0 + p1) / 2 - Math.PI / 2).translate(mid.x, mid.y, mid.z);
        parts.push(part(cyl, mats.coping, null));
      }
      return { parts, lips: [], rails };
    }
    case 'funbox': {
      const H = def.height, Lr = H / Math.tan(def.angle * DEG), D = def.deck;
      const runs: P2[][] = [[[0, 0], [Lr, H]], [[Lr, H], [Lr + D, H]], [[Lr + D, H], [2 * Lr + D, 0]]];
      return {
        parts: profilePiece(runs, def.width, def.surface ?? 'wood'),
        lips: [{ pos: new Vector3(0, H, Lr), dir: new Vector3(0, 0, 1), right: new Vector3(-1, 0, 0), width: def.width, length: Lr }],
        rails: [def.width / 2, -def.width / 2].map((x) => ({ a: new Vector3(x, H, Lr), b: new Vector3(x, H, Lr + D), radius: 0.02 })),
        length: 2 * Lr + D,
      };
    }
    case 'wedge': {
      const H = def.height, L = H / Math.tan(def.angle * DEG), D = def.deck ?? 0;
      const runs: P2[][] = [[[0, 0], [L, H]]];
      if (D > 0) runs.push([[L, H], [L + D, H]]);
      runs.push([[L + D, H], [L + D, 0]]);
      return {
        parts: profilePiece(runs, def.width, def.surface ?? 'concrete'),
        lips: [{ pos: new Vector3(0, H, L), dir: new Vector3(0, 0, 1), right: new Vector3(-1, 0, 0), width: def.width, length: L }],
        length: L + D,
      };
    }
    case 'stairs': {
      const { steps, rise, run, top, width } = def;
      const Ht = steps * rise;
      const runs: P2[][] = [[[0, 0], [0, Ht]], [[0, Ht], [top, Ht]]];
      let z = top, h = Ht;
      for (let i = 0; i < steps; i++) {
        runs.push([[z, h], [z, h - rise]]);
        h -= rise;
        if (h > 1e-4) { runs.push([[z, h], [z + run, h]]); z += run; }
      }
      return { parts: profilePiece(runs, width, def.surface ?? 'concrete'), lips: [], length: z };
    }
    case 'rail': {
      const r = 0.05, L = def.length, H = def.height, drop = def.drop ?? 0;
      const slope = Math.atan2(drop, L), len = Math.hypot(L, drop);
      const bar = new CylinderGeometry(r, r, len, 10).rotateX(Math.PI / 2 + slope).translate(0, H - drop / 2, L / 2);
      const parts = [part(bar, mats.metal, 'obstacle')];
      for (const z of [0.4, L - 0.4]) {
        const ph = H - (drop * z) / L;
        const post = new BoxGeometry(0.07, ph, 0.07).translate(0, ph / 2, z);
        parts.push(part(post, mats.post, 'obstacle'));
        const foot = new BoxGeometry(0.4, 0.04, 0.25).translate(0, 0.02, z);
        parts.push(part(foot, mats.post, null));
      }
      return { parts, lips: [], length: L, rails: [{ a: new Vector3(0, H, 0), b: new Vector3(0, H - drop, L), radius: r }] };
    }
  }
}
