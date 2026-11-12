import {
  Box3, BufferGeometry, Group, Matrix4, Mesh, Object3D, Quaternion, Raycaster, Triangle, Vector3,
} from 'three';
import { buildPiece, type PieceDef } from './pieces';
import { DEG, segSegDistance } from '../core/math';

export type ColliderKind = 'surface' | 'obstacle';

export interface Hit {
  point: Vector3;
  normal: Vector3; // smooth (interpolated) normal, facing the ray origin
  distance: number;
  kind: ColliderKind;
  object: Object3D;
}

/** A kicker lip, used for pop timing. dir = launch direction (horizontal). */
export interface Lip {
  pos: Vector3;
  dir: Vector3;
  right: Vector3;
  width: number;
  length: number; // horizontal length of the ramp leading up to the lip
}

/** Analytic rail/coping segment (top edge), used for collisions now and grinds in Phase 2. */
export interface RailSeg {
  a: Vector3;
  b: Vector3;
  radius: number;
  /** Ramp coping: grindable, but riding/airing past it never counts as clipping it. */
  coping?: boolean;
}

export interface Checkpoint { pos: [number, number, number]; yaw: number; speed?: number }

export interface ParkDef {
  name: string;
  spawn: Checkpoint;
  /** Respawn points along a line; you respawn at the last one you rolled past. */
  checkpoints?: Checkpoint[];
  /** Reaching this ends the line and sends you back to the start. */
  finish?: { pos: [number, number, number]; radius: number; yaw?: number };
  /** Run length in seconds (default TUNING.run.duration). */
  runSeconds?: number;
  decor?: {
    theme?: 'meadow' | 'forest' | 'urban';
    /** Keep trees out of the whole bounding box of the pieces (compact parks). */
    solidArea?: boolean;
    buildings?: number;
    lampLayout?: 'path' | 'perimeter';
    trees?: number;
    rocks?: number;
    clear?: number;       // keep trees this far from the riding path
    pathWidth?: number;   // visual dirt track along the path (0 = none)
    lamps?: number;       // spacing of lamp posts for night mode (m)
  };
  pieces: PieceDef[];
}

const _pa = new Vector3(), _pb = new Vector3(), _pc = new Vector3();
const _na = new Vector3(), _nb = new Vector3(), _nc = new Vector3();

/** Static park: visual meshes (in `root`) + collision meshes baked in world space. */
export class World {
  readonly root = new Group();
  readonly colliders: Mesh[] = [];
  readonly lips: Lip[] = [];
  readonly rails: RailSeg[] = [];
  readonly spawnPos: Vector3;
  readonly spawnYaw: number;
  readonly checkpoints: { pos: Vector3; yaw: number; speed: number }[];
  readonly finish: { pos: Vector3; radius: number; dir: Vector3 | null } | null;
  readonly spawnSpeed: number;
  /** Bounding box of every non-ground piece. */
  readonly bounds = new Box3();
  /** Riding path (spawn → pieces in order), used for decor placement. */
  readonly path: Vector3[] = [];
  private rc = new Raycaster();

  constructor(readonly def: ParkDef) {
    this.spawnPos = new Vector3(...def.spawn.pos);
    this.spawnYaw = def.spawn.yaw * DEG;
    this.checkpoints = (def.checkpoints ?? []).map((c) => ({ pos: new Vector3(...c.pos), yaw: c.yaw * DEG, speed: c.speed ?? 0 }));
    this.spawnSpeed = def.spawn.speed ?? 0;
    this.finish = def.finish
      ? { pos: new Vector3(...def.finish.pos), radius: def.finish.radius, dir: def.finish.yaw === undefined ? null : new Vector3(Math.sin(def.finish.yaw * DEG), 0, Math.cos(def.finish.yaw * DEG)) }
      : null;
    this.path.push(this.spawnPos.clone());
    for (const p of def.pieces) {
      const m = new Matrix4().compose(
        new Vector3(...p.pos),
        new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (p.yaw ?? 0) * DEG),
        new Vector3(1, 1, 1),
      );
      const built = buildPiece(p);
      if (p.type !== 'ground') {
        this.path.push(new Vector3(...p.pos));
        if (built.length) this.path.push(new Vector3(0, 0, built.length).applyMatrix4(m));
      }
      for (const part of built.parts) {
        part.mesh.userData.pieceType = p.type;
        part.mesh.geometry.applyMatrix4(m);
        part.mesh.geometry.computeBoundingSphere();
        part.mesh.geometry.computeBoundingBox();
        if (p.type !== 'ground') this.bounds.union(part.mesh.geometry.boundingBox!);
        part.mesh.updateMatrixWorld(true);
        this.root.add(part.mesh);
        if (part.collide) {
          part.mesh.userData.kind = part.collide;
          this.colliders.push(part.mesh);
        }
      }
      for (const rail of built.rails ?? []) {
        rail.a.applyMatrix4(m);
        rail.b.applyMatrix4(m);
        this.rails.push(rail);
      }
      for (const lip of built.lips) {
        lip.pos.applyMatrix4(m);
        lip.dir.transformDirection(m);
        lip.right.transformDirection(m);
        this.lips.push(lip);
      }
    }
  }

  /** First hit along a ray. `kinds` filters which colliders count. */
  raycast(origin: Vector3, dir: Vector3, far: number, kinds?: ColliderKind[]): Hit | null {
    this.rc.set(origin, dir);
    this.rc.near = 0;
    this.rc.far = far;
    const hits = this.rc.intersectObjects(this.colliders, false);
    for (const h of hits) {
      const kind = h.object.userData.kind as ColliderKind;
      if (kinds && !kinds.includes(kind)) continue;
      const geo = (h.object as Mesh).geometry as BufferGeometry;
      const normal = new Vector3();
      const face = h.face;
      const nAttr = geo.getAttribute('normal');
      if (face && nAttr) {
        const pAttr = geo.getAttribute('position');
        _pa.fromBufferAttribute(pAttr, face.a); _pb.fromBufferAttribute(pAttr, face.b); _pc.fromBufferAttribute(pAttr, face.c);
        _na.fromBufferAttribute(nAttr, face.a); _nb.fromBufferAttribute(nAttr, face.b); _nc.fromBufferAttribute(nAttr, face.c);
        Triangle.getInterpolation(h.point, _pa, _pb, _pc, _na, _nb, _nc, normal);
        if (normal.lengthSq() < 1e-8) normal.copy(face.normal);
        normal.normalize();
      } else {
        normal.set(0, 1, 0);
      }
      if (normal.dot(dir) > 0) normal.negate();
      return { point: h.point.clone(), normal, distance: h.distance, kind, object: h.object };
    }
    return null;
  }

  /** First rail touching a capsule (segment p-q with radius). */
  railNear(p: Vector3, q: Vector3, radius: number, includeCoping = false): RailSeg | null {
    for (const rail of this.rails) {
      if (rail.coping && !includeCoping) continue;
      if (segSegDistance(p, q, rail.a, rail.b) < radius + rail.radius) return rail;
    }
    return null;
  }

  private static DOWN = new Vector3(0, -1, 0);
  /** Ground height + normal straight below a point (searches from 1.5 m above it). */
  groundBelow(p: Vector3, kinds: ColliderKind[] = ['surface']): Hit | null {
    const o = new Vector3(p.x, p.y + 1.5, p.z);
    return this.raycast(o, World.DOWN, 300, kinds);
  }
}
