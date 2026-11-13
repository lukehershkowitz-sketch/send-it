import { Quaternion, Vector3 } from 'three';
import { TUNING } from '../../tuning';
import type { InputState } from '../../core/input/actions';
import { DEG, clamp, damp, quatFromForwardUp, wrapAngle, yawFromTangent } from '../../core/math';
import { bikeRoll, mixAirInput, stepRotation } from '../aero';
import type { RiderController } from '../RiderController';
import { VARIATIONS, type LandingResult, type RiderState } from '../types';
import { describeAir } from '../../tricks/scoring';
import { applyLatePop, Grounded } from './Grounded';
import { tryGrind } from './Grinding';

const TWO_PI = Math.PI * 2;
const _seg = new Vector3(), _dir = new Vector3(), _vt = new Vector3(), _pa = new Vector3(), _pb = new Vector3();
const _qPrev = new Quaternion(), _qt = new Quaternion(), _qi = new Quaternion(), _qe = new Quaternion(), _qg = new Quaternion();
const _X = new Vector3(), _Y = new Vector3(), _Z = new Vector3(), _h = new Vector3(), _fT = new Vector3(), _uT = new Vector3();
const _e = new Vector3(), _vh = new Vector3(), _assist = new Vector3(), _nb = new Vector3(), _fp = new Vector3();
const _w2 = new Vector3(), _hit = new Vector3(), _shift = new Vector3();
const smooth = (x: number) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

/** Points on the bike + rider (bike space) that can touch the ground. */
const WHEELS: [string, Vector3][] = [['front', new Vector3(0, 0, 0.49)], ['rear', new Vector3(0, 0, -0.49)]];
const BODY: Vector3[] = [new Vector3(0, 1.05, 0.28), new Vector3(0, 1.62, -0.02)]; // bars, head

export const Airborne = {
  name: 'AIRBORNE' as const,

  enter(r: RiderController) {
    r.lean = 0;
    r.assistCalm = 0;
    r.tableDir = 1;
    r.airCmd.yaw = r.airCmd.pitch = r.airCmd.roll = r.airCmd.mix = 0;
  },

  update(r: RiderController, dt: number, input: InputState) {
    const A = TUNING.air, P = TUNING.physics;
    const rs = r.rot;
    r.airTime += dt;

    // ---------------------------------------------------------------- late pop (release just after leaving the lip)
    if (r.lateTimer > 0) {
      r.lateTimer -= dt;
      if (!input.pop && r.popWasHeld) applyLatePop(r);
    }
    const braceIn = input.pop && r.lateTimer <= 0 && r.airTime > 0.12 ? 1 : 0; // hold Space: spread out, slow the rotation
    r.popWasHeld = input.pop;
    r.compression = Math.max(0, r.compression - dt / 0.1);

    // bunny hop: front wheel first, then the rear wheel follows
    if (r.hopT > 0) {
      r.hopT -= dt;
      if (r.hopT <= 0) rs.omega.addScaledVector(_X.set(1, 0, 0).applyQuaternion(rs.q), TUNING.pop.hopFrontLift * 0.85);
    }

    // ---------------------------------------------------------------- controls → torques
    if (r.pedalLatched && input.pedal < 0.1) r.pedalLatched = false;
    const pedal = r.pedalLatched ? 0 : input.pedal;
    if (Math.abs(input.steer) > 0.1) r.lastSpinDir = Math.sign(input.steer);
    const mix = mixAirInput({ steer: input.steer, pedal, brake: input.brake, flair: input.flair, roll: input.roll, lastDir: r.lastSpinDir });
    if (input.tabletop && !r.tablePressed) r.tableDir = Math.abs(input.steer) > 0.1 ? Math.sign(input.steer) : r.lastSpinDir;
    r.tablePressed = input.tabletop;

    // ---------------------------------------------------------------- stabiliser (light assist on pitch + roll only)
    const assist = computeAssist(r, mix, input, dt);

    // ---------------------------------------------------------------- rotation physics
    _qPrev.copy(rs.q);
    const extra = 0.12 * r.varBlend.superman + 0.07 * r.varBlend.cancan;
    // landing prep: with nothing driving the rotation, the rider reaches for the ground (arms and legs out),
    // which raises the moment of inertia and bleeds off the spin. Scales with the landing-assist setting.
    const tl = r.predicted.valid ? r.predicted.time : 99;
    const driving = Math.abs(mix.yaw) > 0.1 || Math.abs(mix.pitch) > 0.1 || Math.abs(mix.roll) > 0.1;
    const prep = driving ? 0 : A.autoLevel * smooth((A.prepTime - tl) / (A.prepTime * 0.6));
    // keys ramp the torque in and ease it out (no on/off step), so spins build and settle fluidly
    const cmd = r.airCmd, R = TUNING.rot;
    const ease = (cur: number, to: number) => cur + (to - cur) * (1 - Math.exp(-(Math.abs(to) >= Math.abs(cur) && Math.sign(to) === Math.sign(cur || to) ? R.cmdAttack : R.cmdRelease) * dt));
    cmd.yaw = ease(cmd.yaw, mix.yaw); cmd.pitch = ease(cmd.pitch, mix.pitch); cmd.roll = ease(cmd.roll, mix.roll);
    cmd.mix += (mix.yawAboutBody - cmd.mix) * (1 - Math.exp(-14 * dt));
    stepRotation(rs, {
      yaw: cmd.yaw, yawAboutBody: cmd.mix, pitch: cmd.pitch, roll: cmd.roll,
      brace: Math.max(braceIn, prep), tuck: r.varBlend.tuck, extraInertia: extra, assist,
    }, dt);
    r.quat.copy(rs.q);

    // ---------------------------------------------------------------- tailwhips / barspins
    const barIn = Math.abs(input.barspin) > 0.3 ? Math.sign(input.barspin) : 0;
    if (barIn) r.barDir = barIn;
    [r.whipAngle, r.whipVel] = rotatePart(r.whipAngle, r.whipVel, input.tailwhip ? 1 : 0, A.whipRate * DEG, dt);
    [r.barAngle, r.barVel] = rotatePart(r.barAngle, r.barVel, barIn, A.barRate * DEG, dt);
    // a turn counts once it's within the final few degrees (the catch finishes it)
    const done = (a: number) => Math.floor((Math.abs(a) + A.completeWithin * DEG) / TWO_PI);
    const whips = done(r.whipAngle), bars = done(r.barAngle);
    while (r.whipsDone < whips) { r.whipsDone++; r.chain.push('WHIP'); }
    while (r.barsDone < bars) { r.barsDone++; r.chain.push('BAR'); }
    r.feetOff = damp(r.feetOff, input.tailwhip || Math.abs(r.whipVel) > 0.5 || angleOff(r.whipAngle) > 0.15 ? 1 : 0, 14, dt);
    r.handsOff = damp(r.handsOff, barIn || Math.abs(r.barVel) > 0.5 || angleOff(r.barAngle) > 0.15 ? 1 : 0, 14, dt);

    // ---------------------------------------------------------------- grabs / variations
    for (const v of VARIATIONS) {
      const held = input[v];
      r.varBlend[v] = damp(r.varBlend[v], held ? 1 : 0, held ? A.variationBlendIn : A.variationBlendOut, dt);
      if (held) { r.varHold[v] += dt; r.varBest[v] = Math.max(r.varBest[v], r.varHold[v]); }
      else r.varHold[v] = 0;
    }

    // ---------------------------------------------------------------- landing prediction
    if (++r.predictCounter % 5 === 0) r.predictLanding();
    else r.predicted.time = Math.max(0, r.predicted.time - dt);
    if (r.predicted.valid) r.airGroundNormal.lerp(r.predicted.normal, 1 - Math.exp(-A.groundSampleRate * dt)).normalize();

    // ---------------------------------------------------------------- ballistic motion (momentum is kept)
    r.vel.y -= P.gravity * dt;
    r.vel.multiplyScalar(1 - A.airDrag * r.vel.length() * dt);
    _seg.copy(r.vel).multiplyScalar(dt);

    // rails first: they sit above the ground
    const g = tryGrind(r, input);
    if (g === 'grind' || g === 'bail') return;

    // sweep the wheels (and the rider's head/bars) through the step: rotating fast can't tunnel through the ground
    const posPrev = _pa.copy(r.pos);
    r.pos.add(_seg);
    if (r.airTime > TUNING.landing.contactMinAir) {
      const c = sweepContacts(r, posPrev, _qPrev, rs.q);
      if (c) {
        if (c.kind === 'obstacle') { r.bail('Clipped the rail'); return; }
        r.pos.add(c.shift);
        if (c.kind === 'body') { r.bail(c.what === 'head' ? 'Landed on your head' : 'Landed on the bars'); return; }
        land(r, c.normal, input, c.point);
        return;
      }
    }
  },
} satisfies RiderState;

// =================================================================================== stabiliser

/**
 * Light help, never a script. Acts on pitch and roll only (spin is never touched), and only:
 *  - gently follows the flight path while you aren't doing a flip/roll trick;
 *  - in the last half second, nudges toward the landing surface — and only if you're already
 *    within `alignWindow` of a clean landing, so it never drags a half-finished flip back.
 * Everything scales with `autoLevel` (Settings → landing assist; 0 = off).
 */
function computeAssist(r: RiderController, mix: { yaw: number; pitch: number; roll: number }, input: InputState, dt: number): Vector3 {
  const A = TUNING.air, R = TUNING.rot;
  const rs = r.rot;
  _assist.set(0, 0, 0);
  const master = A.autoLevel;
  const wb = rs.omegaB;
  const U = rs.frameUp;

  // the facing direction only turns with spin (so it stays defined while the bike is upside down)
  _qt.setFromAxisAngle(U, rs.omega.dot(U) * dt);
  r.airHeading.applyQuaternion(_qt).addScaledVector(U, -r.airHeading.dot(U)).normalize();
  _h.copy(r.airHeading);

  // tabletop key: PD-roll the bike toward its tabletop angle (torque, not a pose)
  if (input.tabletop) {
    const target = r.tableDir * R.tabletopAngle * DEG;
    _assist.z += R.tabletopGain * (target - bikeRoll(rs)) - R.tabletopDamp * wb.z;
  }

  _X.set(1, 0, 0).applyQuaternion(rs.q);
  _Y.set(0, 1, 0).applyQuaternion(rs.q);
  _Z.set(0, 0, 1).applyQuaternion(rs.q);
  const tl = r.predicted.valid ? r.predicted.time : 99;
  const wLand = master > 0 && r.predicted.valid ? smooth((A.alignTime - tl) / A.alignTime) : 0;

  // ---- where the nose would be with no trick: along the flight path, blending to the landing slope near touchdown
  const vU = r.vel.dot(U);
  _vh.copy(r.vel).addScaledVector(U, -vU);
  const hs = _vh.length();
  const facing = hs > 0.1 ? _h.dot(_vh) / hs : 1;
  // the flight path only defines a nose angle when there's real speed across the plane (not at the top of a vert air)
  const pTraj = Math.atan2(vU, hs) * facing * smooth(hs / 3.5);
  // how fast that flight-path angle is turning (gravity bends it); the nose tracks it with this as feedforward
  const gU = -TUNING.physics.gravity * U.y;                       // gravity component along the frame's up
  const hsDot = -TUNING.physics.gravity * _vh.y / Math.max(hs, 0.1); // …and along the horizontal velocity
  const pRate = ((hs * gU - vU * hsDot) / Math.max(1, hs * hs + vU * vU)) * facing * smooth(hs / 3.5);
  const n = r.airGroundNormal;
  const slope = Math.atan2(-n.dot(_h), n.dot(U));
  const wBlend = master > 0 && r.predicted.valid ? smooth((A.blendTime - tl) / A.blendTime) : 0; // the target eases onto the landing slope early
  const gw = 0.2 + 0.8 * wBlend;
  const pT = pTraj + (slope - pTraj) * gw;
  const wTx = -(1 - gw) * pRate; // target angular rate about body X (nose-up = −X)
  r.naturalPitch = pT;           // also the reference flips are counted against

  const upright = _Y.dot(U) > -0.15; // not upside down (a steep nose-up is fine: the facing direction is tracked separately)
  const flipDeg = Math.abs(r.flipEff) / DEG, rollDeg = Math.abs(rs.roll) / DEG;
  const inputting = Math.abs(mix.pitch) > 0.1 || Math.abs(mix.roll) > 0.1;
  // settled: not driving a flip/roll and not in a fast roll (a tabletop that was let go of comes back level; a barrel roll in progress keeps going)
  const calm = !inputting && !input.tabletop && flipDeg < A.followMaxFlip && rollDeg < A.followMaxRoll &&
    Math.abs(wb.x) < A.followMaxPitchRate && Math.abs(wb.z) < A.followMaxRollRate && upright;
  r.assistCalm = damp(r.assistCalm, calm ? 1 : 0, calm ? A.followEngage : 7, dt);

  if (master > 0 && upright) {
    _fT.copy(_h).multiplyScalar(Math.cos(pT)).addScaledVector(U, Math.sin(pT));
    _uT.copy(U).lerp(n, wBlend).normalize();
    quatFromForwardUp(_fT, _uT, _qt);
    // rotation error to the target, in body axes, with the spin component removed
    _qi.copy(rs.q).invert();
    _qe.copy(_qt).multiply(_qi);
    if (_qe.w < 0) { _qe.x = -_qe.x; _qe.y = -_qe.y; _qe.z = -_qe.z; _qe.w = -_qe.w; }
    const ang = 2 * Math.acos(clamp(_qe.w, -1, 1));
    const sinH = Math.sqrt(Math.max(1e-12, 1 - _qe.w * _qe.w));
    _e.set(_qe.x, _qe.y, _qe.z).multiplyScalar(ang / sinH).applyQuaternion(_qi);
    _e.y = 0;

    // (1) follow the flight path while calm
    if (r.assistCalm > 0.01) {
      const k = master * r.assistCalm;
      const ax = A.followGain * _e.x - A.followDamp * (wb.x - wTx);
      const az = input.tabletop ? 0 : A.followGainRoll * _e.z - A.followDampRoll * wb.z;
      _assist.x += k * ax;
      _assist.z += k * az;
    }
    // (2) landing nudge: only when already near a clean landing
    if (wLand > 0 && Math.hypot(_e.x, _e.z) < A.alignWindow * DEG && !input.tabletop) {
      const k = master * wLand * (inputting ? 0.35 : 1);
      let ax = A.alignGain * _e.x - A.alignDamp * (wb.x - wTx);
      let az = A.alignGain * _e.z - A.alignDamp * wb.z;
      const m = Math.hypot(ax, az), cap = A.alignMax * master;
      if (m > cap) { ax *= cap / m; az *= cap / m; }
      _assist.x += k * (1 - r.assistCalm * 0.25) * ax;
      _assist.z += k * (1 - r.assistCalm * 0.25) * az;
    }
  }

  // (3) yaw nudge near touchdown: ease an almost-clean spin onto the travel direction (or fakie). Only without spin input.
  const wYaw = Math.max(wLand, 0.55 * wBlend); // starts earlier (and gentler) than the pitch/roll nudge: yaw drift takes longer to correct
  if (wYaw > 0 && Math.abs(mix.yaw) < 0.1 && master > 0) {
    _vt.copy(r.vel).addScaledVector(n, -r.vel.dot(n));
    _fp.copy(_Z).addScaledVector(n, -_Z.dot(n));
    if (_vt.lengthSq() > 1 && _fp.lengthSq() > 0.1) {
      _vt.normalize(); _fp.normalize();
      _w2.crossVectors(_fp, _vt);
      let psi = Math.atan2(_w2.dot(n), _fp.dot(_vt)); // angle from the bike's heading to the travel direction about n
      psi = wrapAngle(psi);
      if (Math.abs(psi) > Math.PI / 2) psi = wrapAngle(psi - Math.sign(psi) * Math.PI); // fakie: nearest of forward/backward
      if (Math.abs(psi) < A.yawWindow * DEG) {
        _nb.copy(n).applyQuaternion(_qi.copy(rs.q).invert());
        const yawRate = rs.omega.dot(n);
        const a = master * wYaw * (A.yawNudge * psi - A.yawDamp * yawRate);
        _assist.addScaledVector(_nb, a);
      }
    }
  }
  return _assist;
}

// =================================================================================== contacts

interface Contact { kind: 'wheel' | 'body' | 'obstacle'; what: string; normal: Vector3; point: Vector3; shift: Vector3 }

/** Sweep wheel and body points from the previous pose to the new one; return the earliest contact. */
function sweepContacts(r: RiderController, posPrev: Vector3, qPrev: Quaternion, qNew: Quaternion): Contact | null {
  let best: Contact | null = null, bestT = Infinity;
  const test = (local: Vector3, kind: 'wheel' | 'body', what: string) => {
    _pb.copy(local).applyQuaternion(qNew).add(r.pos);               // end of step
    const a = _hit.copy(local).applyQuaternion(qPrev).add(posPrev); // start of step
    _dir.copy(_pb).sub(a);
    const len = _dir.length();
    if (len < 1e-6) return;
    _dir.divideScalar(len);
    const hit = r.world.raycast(a, _dir, len + 0.01);
    if (!hit) return;
    if (hit.kind === 'obstacle' && r.ignoreRailTime > 0) return; // still clearing the rail we just popped off
    const t = hit.distance / len;
    if (t >= bestT) return;
    bestT = t;
    best = {
      kind: hit.kind === 'obstacle' ? 'obstacle' : kind, what, normal: hit.normal, point: hit.point,
      shift: _shift.copy(hit.point).sub(_pb).clone(),
    };
  };
  for (const [name, local] of WHEELS) test(local, 'wheel', name);
  if (!best && r.airTime > TUNING.landing.contactMinAir * 2) for (const local of BODY) test(local, 'body', local.y > 1.3 ? 'head' : 'bars');
  return best;
}

// =================================================================================== helpers

/** Distance (rad) from the nearest whole turn. */
function angleOff(a: number) {
  const m = Math.abs(a) % TWO_PI;
  return Math.min(m, TWO_PI - m);
}

/**
 * Whip/bar rotation: spins while held; on release it's "caught" toward the nearest full
 * turn if within the catch window, otherwise it stops where it is.
 */
function rotatePart(angle: number, vel: number, input: number, rate: number, dt: number): [number, number] {
  const A = TUNING.air;
  if (input) {
    vel = damp(vel, input * rate, A.rotAccelRate * 1.5, dt);
    return [angle + vel * dt, vel];
  }
  const target = Math.round(angle / TWO_PI) * TWO_PI;
  const diff = target - angle;
  if (Math.abs(diff) > 1e-4 && Math.abs(diff) < A.catchWindow * DEG) {
    const step = diff * (1 - Math.exp(-A.catchRate * dt));
    return [Math.abs(diff) < 0.002 ? target : angle + step, step / dt];
  }
  vel = damp(vel, 0, A.rotStopRate * 2, dt);
  return [Math.abs(diff) < 1e-4 ? target : angle + vel * dt, vel];
}

// =================================================================================== landing

function land(r: RiderController, n: Vector3, input: InputState, contact: Vector3) {
  const L = TUNING.landing;
  // seat the contact point (between the wheels) on the surface so ground-following starts from it, not from a few cm above
  r.pos.addScaledVector(n, _hit.copy(contact).sub(r.pos).dot(n));
  const check = r.checkLanding(n, input);
  const air = r.airData();
  const result: LandingResult = {
    ...check,
    trick: describeAir(air),
    air,
    intoManual: check.ok && input.manual,
  };
  r.lastLanding = result;
  if (!check.ok) {
    r.bail(check.reason, result);
    return;
  }

  // ride away with the speed the landing deserves: crooked and front-wheel landings scrub speed
  _vt.copy(r.vel).addScaledVector(n, -r.vel.dot(n));
  const sev = clamp(check.severity, 0, 2.6);
  let loss = check.stomped ? 0.005 : L.severitySpeedLoss * Math.pow(Math.min(sev, 1.5), 1.2) * (sev > 1 ? 0.7 + 0.3 * sev : 1);
  if (check.wheelFirst === 'front') loss += L.frontWheelLoss * (0.4 + sev);
  loss += Math.max(0, check.impact - 9) * 0.008;
  r.speed = _vt.length() * (1 - clamp(loss, 0, 0.45));
  const travelYaw = yawFromTangent(_vt.normalize(), n);
  r.travelYaw = r.heading = travelYaw;
  r.fakie = check.fakie;
  r.fakieVis = r.fakie ? Math.PI : 0;
  // a crooked landing straightens out smoothly instead of snapping to the travel direction
  _hit.set(0, 0, 1).applyQuaternion(r.rot.q);
  _hit.addScaledVector(n, -_hit.dot(n));
  if (_hit.lengthSq() > 1e-4) {
    let off = wrapAngle(yawFromTangent(_hit.normalize(), n) - travelYaw);
    if (Math.abs(off) > Math.PI / 2) off = wrapAngle(off - Math.sign(off) * Math.PI);
    r.yawVisOffset = clamp(off, -1.6, 1.6);
  } else r.yawVisOffset = 0;
  r.normal.copy(n);
  r.steer = 0;
  r.compression = 0;
  r.whipAngle = r.barAngle = 0;

  // whatever the bike's orientation was versus the ground becomes a wobble that settles out
  r.wobble.set(0, 0, 0);
  r.wobbleV.set(0, 0, 0);
  Grounded.orient(r, 0);
  _qg.copy(r.quat);
  _qe.copy(_qg).invert().multiply(r.rot.q);
  if (_qe.w < 0) { _qe.x = -_qe.x; _qe.y = -_qe.y; _qe.z = -_qe.z; _qe.w = -_qe.w; }
  const ang = 2 * Math.acos(clamp(_qe.w, -1, 1));
  const sinH = Math.sqrt(Math.max(1e-12, 1 - _qe.w * _qe.w));
  const cap = L.wobbleMax * DEG;
  r.wobble.set(_qe.x, _qe.y, _qe.z).multiplyScalar(ang / sinH);
  if (r.wobble.length() > cap) r.wobble.setLength(cap);
  r.wobbleV.copy(r.rot.omegaB).multiplyScalar(L.wobbleCarry).clampLength(0, 5);
  r.wobbleV.x *= 0.3; r.wobbleV.y *= 0.3; // mostly pitch/roll carry into the wobble; spin mostly doesn't
  r.wobbleV.z *= 0.3;

  // the rider takes the hit: legs compress, torso jolts toward the wheel that landed first
  const jolt = check.wheelFirst === 'front' ? 0.9 : check.wheelFirst === 'rear' ? -0.9 : 0;
  r.body.kick(Math.min(7, 1.5 + check.impact * 0.55), jolt * (0.4 + sev), 0);

  r.setState('GROUNDED');
  Grounded.orient(r, 0);
  r.events.emit('landed', result);
  if (result.intoManual) {
    r.manualNose = false;
    r.setState('MANUALING');
  }
}
