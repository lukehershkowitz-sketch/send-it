import { Quaternion, Vector3 } from 'three';
import { TUNING } from '../tuning';

const DEG = Math.PI / 180;

/**
 * Rigid-body rotation of rider + bike in the air.
 *
 *  - `q` is the real orientation, `omega` the angular velocity (world frame, rad/s).
 *  - Inputs are *torques*, not target angles: they spin the body up, and the body keeps its
 *    angular momentum when you let go (only light air resistance bleeds it). The rider can only
 *    drive a rotation up to a per-axis limit (`maxRate`): the torque fades out as that rate is
 *    approached, but counter-torque is always at full strength.
 *  - Euler's equations (a `gyro` fraction of them) couple the axes: flipping while spinning
 *    makes the rotation axis wander, which is where corks and rodeos come from.
 *  - Posture changes the moment of inertia (`inertia`: tuck < 1 < brace). Angular momentum is
 *    conserved when it changes, so tucking speeds a spin up and bracing slows it down.
 *
 * Conventions (match the rest of the game): body +X = left, +Y = up, +Z = forward.
 * spin  = rotation about the frame's up axis, + = counter-clockwise from above (left)
 * flip  = rotation about the body lateral axis, + = backflip (nose rises)
 * roll  = rotation about the body forward axis, + = right side down
 */
export interface RotState {
  q: Quaternion;
  omega: Vector3;
  omegaB: Vector3;      // body-frame angular velocity (x = pitch axis, y = yaw axis, z = roll axis), last step
  alphaB: Vector3;      // body-frame angular acceleration, last step (drives the rider's secondary motion)
  inertia: number;      // posture scale (1 = neutral)
  frameUp: Vector3;     // "up" for spin/level: world up, or the wall normal in a vert air
  spin: number;         // accumulated rotation (rad)
  flip: number;
  roll: number;
  maxTilt: number;      // largest angle the bike's up got from level (rad)
  maxRoll: number;      // largest |sideways lean| (rad)
  tableTime: number;    // seconds spent leaned past tabletopMinRoll
}

export interface RotInput {
  yaw: number;          // + = left spin
  yawAboutBody?: number; // 0 = spin about the frame's up axis (flat spin), 1 = about the bike's own up axis (off-axis mixes)
  pitch: number;        // + = backflip
  roll: number;         // + = roll right
  brace: number;        // 0..1 spread out (slows rotation)
  tuck: number;         // 0..1 pulled in (speeds rotation)
  extraInertia?: number; // limbs out (superman etc.)
  assist?: Vector3;     // body-frame angular acceleration from the stabiliser (rad/s²)
}

export const makeRot = (): RotState => ({
  q: new Quaternion(), omega: new Vector3(), omegaB: new Vector3(), alphaB: new Vector3(), inertia: 1,
  frameUp: new Vector3(0, 1, 0), spin: 0, flip: 0, roll: 0, maxTilt: 0, maxRoll: 0, tableTime: 0,
});

export function resetRot(rs: RotState, q: Quaternion, omegaWorld: Vector3, frameUp: Vector3) {
  rs.q.copy(q);
  rs.omega.copy(omegaWorld);
  rs.omegaB.set(0, 0, 0);
  rs.alphaB.set(0, 0, 0);
  rs.inertia = 1;
  rs.frameUp.copy(frameUp);
  rs.spin = rs.flip = rs.roll = 0;
  rs.maxTilt = rs.maxRoll = rs.tableTime = 0;
}

const _qi = new Quaternion(), _dq = new Quaternion();
const _x = new Vector3(), _y = new Vector3(), _z = new Vector3();
const _wb = new Vector3(), _ub = new Vector3(), _al = new Vector3(), _ax = new Vector3();

const _L = new Vector3(), _cr = new Vector3();
/**
 * Bike lean about its own forward axis (rad, + = right side down, −π..π): the angle from the "level"
 * up for the way the nose is pointing (world up with the nose component removed) to the bike's real up.
 * Unlike asin(left·up) this stays meaningful with the nose pitched up or down, and past 90°.
 */
export function bikeRoll(rs: RotState): number {
  _z.set(0, 0, 1).applyQuaternion(rs.q);
  _y.set(0, 1, 0).applyQuaternion(rs.q);
  _L.copy(rs.frameUp).addScaledVector(_z, -_z.dot(rs.frameUp));
  if (_L.lengthSq() < 0.04) { // nose near vertical: fall back to the lateral axis
    _x.set(1, 0, 0).applyQuaternion(rs.q);
    return Math.asin(Math.max(-1, Math.min(1, _x.dot(rs.frameUp))));
  }
  _L.normalize();
  return Math.atan2(_cr.crossVectors(_L, _y).dot(_z), _L.dot(_y));
}

/** Nose elevation relative to level (rad, + = nose up). */
export function bikePitch(rs: RotState): number {
  _z.set(0, 0, 1).applyQuaternion(rs.q);
  return Math.asin(Math.max(-1, Math.min(1, _z.dot(rs.frameUp))));
}

/** One fixed step of the rotation model. */
export function stepRotation(rs: RotState, inp: RotInput, dt: number): void {
  const R = TUNING.rot;

  // posture → moment of inertia; conserve angular momentum while it changes
  const target = 1 + (R.braceInertia - 1) * inp.brace - (1 - R.tuckInertia) * inp.tuck + (inp.extraInertia ?? 0);
  const next = rs.inertia + (target - rs.inertia) * (1 - Math.exp(-R.inertiaRate * dt));
  if (Math.abs(next - rs.inertia) > 1e-6) { rs.omega.multiplyScalar(rs.inertia / next); rs.inertia = next; }
  const s = rs.inertia;

  // body-frame quantities
  _qi.copy(rs.q).invert();
  _wb.copy(rs.omega).applyQuaternion(_qi);
  _ub.copy(rs.frameUp).applyQuaternion(_qi);
  const T = R.torque, M = R.maxRate, I = R.inertia;

  // torque from the rider, in body axes. Plain spins turn about the frame's up axis (so they stay flat
  // however the nose is pitched); when pitch/roll are mixed in, everything acts about body-fixed axes,
  // which makes a steady rotation about one tilted axis, i.e. an off-axis spin.
  const mix = inp.yawAboutBody ?? 0;
  _ax.set(0, 1, 0).lerp(_ub, 1 - mix);
  if (_ax.lengthSq() > 1e-8) _ax.normalize();
  _al.set(-inp.pitch * T.pitch, 0, inp.roll * T.roll).addScaledVector(_ax, inp.yaw * T.yaw).divideScalar(s);
  // the rider's drive fades out toward the per-axis limit (counter-torque is unaffected)
  const fade = (a: number, w: number, m: number) => (a * w > 0 ? a * Math.max(0, 1 - (w / m) * (w / m)) : a);
  _al.x = fade(_al.x, _wb.x, M.pitch);
  _al.y = fade(_al.y, _wb.y, M.yaw);
  _al.z = fade(_al.z, _wb.z, M.roll);

  // gyroscopic coupling  α -= I⁻¹ (ω × Iω)
  const Iwx = I.pitch * _wb.x, Iwy = I.yaw * _wb.y, Iwz = I.roll * _wb.z;
  const cx = _wb.y * Iwz - _wb.z * Iwy, cy = _wb.z * Iwx - _wb.x * Iwz, cz = _wb.x * Iwy - _wb.y * Iwx;
  _al.x -= (R.gyro * cx) / I.pitch;
  _al.y -= (R.gyro * cy) / I.yaw;
  _al.z -= (R.gyro * cz) / I.roll;

  // air resistance (light) + bracing against it
  const lin = R.linearDrag + R.braceDamping * inp.brace;
  _al.addScaledVector(_wb, -lin);

  if (inp.assist) _al.add(inp.assist);

  rs.alphaB.copy(_al);
  _wb.addScaledVector(_al, dt);
  const wmax = 1.3 * Math.max(M.pitch, M.yaw, M.roll);
  if (_wb.length() > wmax) _wb.multiplyScalar(wmax / _wb.length());
  rs.omegaB.copy(_wb);
  rs.omega.copy(_wb).applyQuaternion(rs.q);

  // accumulate rotation amounts about the three named axes (using the axes at the start of the step)
  _x.set(1, 0, 0).applyQuaternion(rs.q);
  _z.set(0, 0, 1).applyQuaternion(rs.q);
  rs.spin += rs.omega.dot(rs.frameUp) * dt;
  rs.flip += -rs.omega.dot(_x) * dt;
  rs.roll += rs.omega.dot(_z) * dt;

  // integrate the orientation (exact rotation for this step)
  const w = rs.omega.length();
  if (w > 1e-6) {
    _dq.setFromAxisAngle(_ax.copy(rs.omega).divideScalar(w), w * dt);
    rs.q.premultiply(_dq).normalize();
  }

  // trick statistics
  _y.set(0, 1, 0).applyQuaternion(rs.q);
  rs.maxTilt = Math.max(rs.maxTilt, Math.acos(Math.max(-1, Math.min(1, _y.dot(rs.frameUp)))));
  const roll = Math.abs(bikeRoll(rs));
  rs.maxRoll = Math.max(rs.maxRoll, roll);
  if (roll >= R.tabletopMinRoll * DEG) rs.tableTime += dt;
}

// ------------------------------------------------------------------------------ naming

export interface AirRotationStats {
  spinDeg: number; flipDeg: number; rollDeg: number; maxTiltDeg: number; maxRollDeg: number; tableTime: number;
}

export type RotKind = 'none' | 'spin' | 'flip' | 'cork' | 'rodeo' | 'misty' | 'roll' | 'tabletop';

export interface NamedRotation {
  kind: RotKind;
  spin: number;   // horizontal spin in whole 180s (0, 180, 360…)
  flips: number;  // signed whole flips (+ back, − front); 0 if none
  rolls: number;
  label: string;  // e.g. "CORK 720", "RODEO 540", "540 BACKFLIP", "" (nothing)
}

const flipName = (n: number) => {
  const a = Math.abs(n);
  const mult = a === 1 ? '' : a === 2 ? 'DOUBLE ' : a === 3 ? 'TRIPLE ' : `${a}x `;
  return `${mult}${n > 0 ? 'BACKFLIP' : 'FRONTFLIP'}`;
};

/**
 * Name an air from how the bike actually rotated (not from which keys were pressed).
 * The "rotation axis" is the mix of spin, flip and roll amounts: close to vertical = flat spin,
 * well off vertical while the bike really tipped over = corked; the off-axis family splits on
 * which way the axis leans (sideways = cork, back = rodeo, forward = misty).
 */
export function classifyRotation(st: AirRotationStats): NamedRotation {
  const R = TUNING.rot;
  const s = Math.abs(st.spinDeg), f = Math.abs(st.flipDeg), r = Math.abs(st.rollDeg);
  const spin = s >= R.spinMin ? Math.round(s / 180) * 180 : 0;
  const nFlip = Math.floor((f + (360 - R.fullFlip)) / 360) * (st.flipDeg < 0 ? -1 : 1);
  const nRoll = Math.floor((r + (360 - R.fullFlip)) / 360);
  const tilt = Math.atan2(Math.hypot(f, r), s) / DEG;
  const out = (kind: RotKind, label: string): NamedRotation => ({ kind, spin, flips: nFlip, rolls: nRoll, label });

  if (spin >= 360 && tilt >= R.axisTiltMin && tilt <= R.axisTiltMax && st.maxTiltDeg >= R.offAxisTilt) {
    const pitchDominant = f >= r * 0.9 && f >= 90;
    if (!pitchDominant) return out('cork', `CORK ${spin}`);
    return out(st.flipDeg > 0 ? 'rodeo' : 'misty', `${st.flipDeg > 0 ? 'RODEO' : 'MISTY'} ${spin}`);
  }
  if (nFlip !== 0) {
    if (Math.abs(nFlip) === 1 && spin === 180 && st.flipDeg > 0) return out('flip', 'FLAIR');
    return out('flip', `${spin ? spin + ' ' : ''}${flipName(nFlip)}`);
  }
  if (nRoll > 0 && f < 120) return out('roll', nRoll === 1 ? 'BARREL ROLL' : `${nRoll}x BARREL ROLL`);
  if (spin > 0) return out('spin', String(spin));
  // tabletop: really laid over for a while, without flipping or going upside down
  if (st.maxRollDeg >= R.tabletopMinRoll && st.tableTime >= R.tabletopHold && f < 100 && st.maxTiltDeg <= 125) return out('tabletop', 'TABLETOP');
  return out('none', '');
}

// ------------------------------------------------------------------------------ controls → torques

export interface AirKeys {
  steer: number;     // -1 left … +1 right (A/D, left stick)
  pedal: number;     // 0..1 (W / RT) → frontflip
  brake: number;     // 0..1 (S / LT) → backflip
  flair: boolean;    // ↑ / B: coordinated off-axis torque (flair, cork, rodeo, misty)
  roll: boolean;     // modifier: steer rolls the bike instead of spinning it
  lastDir: number;   // last non-zero steer sign, for ↑ alone
}

/**
 * Map the controls onto torque commands (yaw + = left, pitch + = backflip, roll + = right).
 * These are plain torque mixes; what the bike actually does comes from the physics:
 *   A/D                  flat spin about the frame's up axis
 *   W / S                front / back flip
 *   Shift + A/D          roll sideways
 *   ↑ alone              flair: a backflip with a little spin
 *   ↑ + A/D              cork: spin about an axis tilted sideways
 *   ↑ + A/D + S          rodeo: spin about an axis tipped back
 *   ↑ + A/D + W          misty: spin about an axis tipped forward
 * Holding A/D and W/S together (no ↑) mixes them by hand, and gives the same off-axis rotations.
 */
export function mixAirInput(k: AirKeys): { yaw: number; pitch: number; roll: number; yawAboutBody: number } {
  const R = TUNING.rot;
  const steer = Math.abs(k.steer) > 0.1 ? k.steer : 0;
  const flipIn = k.brake - k.pedal;
  const side = Math.sign(steer);
  if (k.flair) {
    const back = k.brake > 0.3, front = k.pedal > 0.3;
    if (!steer) return { yaw: -k.lastDir * R.flairYaw, pitch: Math.abs(flipIn) > 0.3 ? flipIn : 1, roll: 0, yawAboutBody: 1 };
    if (back) return { yaw: -steer, pitch: R.rodeoPitch, roll: side * R.rodeoRoll, yawAboutBody: 1 };
    if (front) return { yaw: -steer, pitch: -R.mistyPitch, roll: -side * R.mistyRoll, yawAboutBody: 1 };
    return { yaw: -steer, pitch: R.corkPitch, roll: side * R.corkRoll, yawAboutBody: 1 };
  }
  if (k.roll) return { yaw: 0, pitch: flipIn, roll: steer, yawAboutBody: 1 };
  const mixed = Math.abs(flipIn) > 0.15 ? 1 : 0; // hand-mixed spin + flip: about body axes
  return { yaw: -steer, pitch: flipIn, roll: 0, yawAboutBody: mixed };
}
