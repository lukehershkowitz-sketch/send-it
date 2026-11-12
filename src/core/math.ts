import { Matrix4, Quaternion, Vector3 } from 'three';

export const DEG = Math.PI / 180;
export const UP = new Vector3(0, 1, 0);
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Frame-rate independent exponential approach. */
export const damp = (cur: number, target: number, rate: number, dt: number) =>
  target + (cur - target) * Math.exp(-rate * dt);
export const dampFactor = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

/** Yaw convention: 0 = +Z, positive yaw turns toward +X (left). */
export const dirFromYaw = (yaw: number, out = new Vector3()) => out.set(Math.sin(yaw), 0, Math.cos(yaw));
export const yawOf = (v: Vector3) => Math.atan2(v.x, v.z);

export function projectOnPlane(v: Vector3, n: Vector3, out: Vector3): Vector3 {
  return out.copy(v).addScaledVector(n, -v.dot(n));
}

const _m = new Matrix4(), _x = new Vector3(), _y = new Vector3(), _z = new Vector3();
/** Local +Z = forward, +Y = up, +X = left. */
export function quatFromForwardUp(forward: Vector3, up: Vector3, out: Quaternion): Quaternion {
  _z.copy(forward).normalize();
  _x.crossVectors(up, _z);
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
  _x.normalize();
  _y.crossVectors(_z, _x);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

const AX_X = new Vector3(1, 0, 0), AX_Y = new Vector3(0, 1, 0);
const _qp = new Quaternion();
/** Air orientation: yaw about world up, then pitch (nose-up positive) about the bike's lateral axis. */
export function quatFromYawPitch(yaw: number, pitch: number, out: Quaternion): Quaternion {
  out.setFromAxisAngle(AX_Y, yaw);
  _qp.setFromAxisAngle(AX_X, -pitch);
  return out.multiply(_qp);
}

const _d1 = new Vector3(), _d2 = new Vector3(), _r = new Vector3(), _c1 = new Vector3(), _c2 = new Vector3();
/** Closest distance between segments p1-q1 and p2-q2. Optionally returns the param t on segment 2. */
export function segSegDistance(p1: Vector3, q1: Vector3, p2: Vector3, q2: Vector3, out?: { s: number; t: number }): number {
  _d1.subVectors(q1, p1); _d2.subVectors(q2, p2); _r.subVectors(p1, p2);
  const a = _d1.dot(_d1), e = _d2.dot(_d2), f = _d2.dot(_r);
  let s = 0, t = 0;
  if (a <= 1e-9 && e <= 1e-9) { s = t = 0; }
  else if (a <= 1e-9) { t = clamp(f / e, 0, 1); }
  else {
    const c = _d1.dot(_r);
    if (e <= 1e-9) { s = clamp(-c / a, 0, 1); }
    else {
      const b = _d1.dot(_d2), denom = a * e - b * b;
      s = denom > 1e-9 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  if (out) { out.s = s; out.t = t; }
  _c1.copy(p1).addScaledVector(_d1, s);
  _c2.copy(p2).addScaledVector(_d2, t);
  return _c1.distanceTo(_c2);
}

const _rt = new Vector3();
/**
 * Riding direction on a surface for a heading yaw: normal × (horizontal right vector).
 * Unlike projecting the heading onto the surface, this stays well defined on vertical
 * walls (heading into a wall = straight up it).
 */
export function tangentFromYaw(yaw: number, n: Vector3, out: Vector3): Vector3 {
  _rt.set(-Math.cos(yaw), 0, Math.sin(yaw)); // rider's right for this yaw
  out.crossVectors(n, _rt);
  if (out.lengthSq() < 1e-6) projectOnPlane(dirFromYaw(yaw, out), n, out);
  return out.normalize();
}

/** Inverse of tangentFromYaw: heading yaw for a direction of travel `t` on a surface with normal `n`. */
export function yawFromTangent(t: Vector3, n: Vector3): number {
  _rt.crossVectors(t, n); // right vector
  if (Math.abs(_rt.y) > 0.9 * _rt.length()) return Math.atan2(t.x, t.z); // degenerate: riding sideways on a wall
  return Math.atan2(_rt.z, -_rt.x);
}
