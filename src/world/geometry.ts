import { BufferAttribute, BufferGeometry, Shape, ShapeGeometry, Vector2, Vector3 } from 'three';

/** A 2D profile point: [z (forward), y (height)]. */
export type P2 = [number, number];

/** Builds smooth profiles from lines and arcs. Angle = slope of the tangent (rad, up positive). */
export class Turtle {
  pts: P2[];
  constructor(public z = 0, public y = 0, public a = 0) {
    this.pts = [[z, y]];
  }
  line(len: number, steps = 1): this {
    for (let i = 0; i < steps; i++) {
      this.z += (Math.cos(this.a) * len) / steps;
      this.y += (Math.sin(this.a) * len) / steps;
      this.pts.push([this.z, this.y]);
    }
    return this;
  }
  arc(radius: number, delta: number, steps = 12): this {
    const d = delta / steps;
    const chord = 2 * radius * Math.sin(Math.abs(d) / 2);
    for (let i = 0; i < steps; i++) {
      const mid = this.a + d / 2;
      this.z += chord * Math.cos(mid);
      this.y += chord * Math.sin(mid);
      this.a += d;
      this.pts.push([this.z, this.y]);
    }
    return this;
  }
}

/**
 * Extrude profile "runs" across the X axis (width). Points inside a run share smooth
 * normals (for silky ground probing); separate runs meet at a sharp edge.
 */
export function extrudeRuns(runs: P2[][], width: number): BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const hw = width / 2;
  for (const run of runs) {
    const base = pos.length / 3;
    let dist = 0;
    for (let i = 0; i < run.length; i++) {
      const p0 = run[Math.max(0, i - 1)], p1 = run[Math.min(run.length - 1, i + 1)];
      let tz = p1[0] - p0[0], ty = p1[1] - p0[1];
      const l = Math.hypot(tz, ty) || 1;
      tz /= l; ty /= l;
      if (i > 0) dist += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
      const [z, y] = run[i];
      // normal = (0, tz, -ty)
      pos.push(-hw, y, z, hw, y, z);
      nor.push(0, tz, -ty, 0, tz, -ty);
      uv.push(0, dist / 2, width / 2, dist / 2);
    }
    for (let i = 0; i < run.length - 1; i++) {
      const L0 = base + i * 2, R0 = L0 + 1, L1 = L0 + 2, R1 = L0 + 3;
      idx.push(L0, L1, R0, R0, L1, R1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  return g;
}

/** Both side walls of an extruded profile (closed down to y = 0). */
export function profileSides(runs: P2[][], width: number): BufferGeometry {
  const pts: P2[] = [];
  for (const run of runs) for (const p of run) {
    const last = pts[pts.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-4 || Math.abs(last[1] - p[1]) > 1e-4) pts.push(p);
  }
  const first = pts[0], last = pts[pts.length - 1];
  if (last[1] > 1e-3) pts.push([last[0], 0]);
  if (first[1] > 1e-3) pts.unshift([first[0], 0]);
  const sg = new ShapeGeometry(new Shape(pts.map(([z, y]) => new Vector2(z, y))));
  const src = sg.getAttribute('position');
  const index = sg.getIndex()!;
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  const hw = width / 2;
  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (let i = 0; i < src.count; i++) {
      pos.push(side * hw, src.getY(i), src.getX(i));
      nor.push(side, 0, 0);
    }
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
      // Shape (z,y) CCW maps to a face whose normal points -X; flip for the +X side.
      if (side === 1) idx.push(base + a, base + c, base + b);
      else idx.push(base + a, base + b, base + c);
    }
  }
  sg.dispose();
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  g.setIndex(idx);
  return g;
}

export const v3 = (x: number, y: number, z: number) => new Vector3(x, y, z);
