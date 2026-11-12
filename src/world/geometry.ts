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

/**
 * Sloped side walls for dirt mounds: the top edge follows the profile at ±width/2, the
 * bottom edge flares out by `flare` × height, so mounds look piled up rather than cut.
 */
export function flaredSides(runs: P2[][], width: number, flare: number): BufferGeometry {
  const pts: P2[] = [];
  for (const run of runs) for (const p of run) {
    const last = pts[pts.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-4 || Math.abs(last[1] - p[1]) > 1e-4) pts.push(p);
  }
  const pos: number[] = [];
  const hw = width / 2;
  for (const side of [1, -1]) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [z0, y0] = pts[i], [z1, y1] = pts[i + 1];
      const t0 = [side * hw, y0, z0], t1 = [side * hw, y1, z1];
      const b0 = [side * (hw + y0 * flare), 0, z0], b1 = [side * (hw + y1 * flare), 0, z1];
      // two triangles, wound so the normal faces outward (±X)
      const tri = side === 1 ? [t0, t1, b0, t1, b1, b0] : [t0, b0, t1, t1, b0, b1];
      for (const v of tri) pos.push(...v);
    }
    // end caps where the profile meets the ground away from the first/last point
    for (const [z, y] of [pts[0], pts[pts.length - 1]]) {
      if (y < 1e-3) continue;
      const a = [side * hw, y, z], b = [side * (hw + y * flare), 0, z], c = [side * hw, 0, z];
      pos.push(...(side === 1 ? [...a, ...c, ...b] : [...a, ...b, ...c]));
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  const uv: number[] = [];
  for (let i = 0; i < pos.length; i += 3) uv.push(pos[i + 2] * 0.5, pos[i + 1] * 0.5 + Math.abs(pos[i]) * 0.25);
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.computeVertexNormals();
  return g;
}
