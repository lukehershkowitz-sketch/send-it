import {
  BoxGeometry, BufferGeometry, CylinderGeometry, DoubleSide, Material, Mesh, MeshLambertMaterial, PlaneGeometry, Vector3,
} from 'three';
import { DEG } from '../core/math';
import { extrudeRuns, profileSides, Turtle, type P2 } from './geometry';
import type { ColliderKind, Lip, RailSeg } from './World';

/**
 * Modular park pieces. Every piece is built in local space (+Z = forward/downhill direction,
 * origin at the start of the piece on the ground) and placed by `pos` + `yaw` from park JSON.
 */
export type PieceDef =
  | { type: 'ground'; pos: [number, number, number]; yaw?: number; size: number }
  | { type: 'kicker'; pos: [number, number, number]; yaw?: number; height: number; angle: number; width: number }
  | {
      type: 'landing'; pos: [number, number, number]; yaw?: number;
      height: number; slope: number; width: number; deck?: number; faceAngle?: number;
      knuckleRadius?: number; transitionRadius?: number;
    }
  | { type: 'rail'; pos: [number, number, number]; yaw?: number; length: number; height: number };

export interface BuiltPart { mesh: Mesh; collide: ColliderKind | null }
export interface BuiltPiece { parts: BuiltPart[]; lips: Lip[]; rails?: RailSeg[] }

const mats = {
  dirtTop: new MeshLambertMaterial({ color: 0xb98454, flatShading: true }),
  dirtSide: new MeshLambertMaterial({ color: 0x8a5a36, flatShading: true, side: DoubleSide }),
  metal: new MeshLambertMaterial({ color: 0xc9d1d8 }),
  post: new MeshLambertMaterial({ color: 0x4b545c }),
  ground: new MeshLambertMaterial({ color: 0x8fa36a }),
};
/** Decor code swaps in a textured ground material in the browser. */
export const pieceMaterials: Record<string, Material> = mats;

const part = (geo: BufferGeometry, mat: Material, collide: ColliderKind | null): BuiltPart => ({
  mesh: new Mesh(geo, mat),
  collide,
});

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
        parts: [
          part(extrudeRuns(runs, def.width), mats.dirtTop, 'surface'),
          part(profileSides(runs, def.width), mats.dirtSide, 'surface'),
        ],
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
      return {
        parts: [
          part(extrudeRuns(runs, def.width), mats.dirtTop, 'surface'),
          part(profileSides(runs, def.width), mats.dirtSide, 'surface'),
        ],
        lips: [],
      };
    }
    case 'rail': {
      const r = 0.05, L = def.length, H = def.height;
      const bar = new CylinderGeometry(r, r, L, 10).rotateX(Math.PI / 2).translate(0, H, L / 2);
      const parts = [part(bar, mats.metal, 'obstacle')];
      for (const z of [0.4, L - 0.4]) {
        const post = new BoxGeometry(0.07, H, 0.07).translate(0, H / 2, z);
        parts.push(part(post, mats.post, 'obstacle'));
        const foot = new BoxGeometry(0.4, 0.04, 0.25).translate(0, 0.02, z);
        parts.push(part(foot, mats.post, null));
      }
      return { parts, lips: [], rails: [{ a: new Vector3(0, H, 0), b: new Vector3(0, H, L), radius: r }] };
    }
  }
}
