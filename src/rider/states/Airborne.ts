import { Vector3 } from 'three';
import { TUNING } from '../../tuning';
import type { InputState } from '../../core/input/actions';
import { DEG, damp, wrapAngle, yawFromTangent } from '../../core/math';
import type { RiderController } from '../RiderController';
import { VARIATIONS, type LandingResult, type RiderState } from '../types';
import { applyLatePop, Grounded } from './Grounded';
import { tryGrind } from './Grinding';
import { describeAir } from '../../tricks/scoring';

const _seg = new Vector3(), _dir = new Vector3(), _vt = new Vector3();
const TWO_PI = Math.PI * 2;

export const Airborne = {
  name: 'AIRBORNE' as const,

  enter(r: RiderController) {
    r.lean = 0;
  },

  update(r: RiderController, dt: number, input: InputState) {
    const A = TUNING.air, P = TUNING.physics;
    r.airTime += dt;

    // ---------------------------------------------------------------- late pop
    if (r.lateTimer > 0) {
      r.lateTimer -= dt;
      if (!input.pop && r.popWasHeld) applyLatePop(r);
    }
    r.popWasHeld = input.pop;
    r.compression = Math.max(0, r.compression - dt / 0.1);

    // ---------------------------------------------------------------- spins / flips / flair
    if (r.pedalLatched && input.pedal < 0.1) r.pedalLatched = false;
    const pedal = r.pedalLatched ? 0 : input.pedal;

    if (input.flair && !r.flairActive) {
      r.flairActive = true;
      r.flairDir = Math.abs(input.steer) > 0.1 ? Math.sign(input.steer) : r.lastSpinDir;
    } else if (!input.flair) r.flairActive = false;

    const steerIn = Math.abs(input.steer) > 0.1 ? input.steer : 0;
    if (steerIn) r.lastSpinDir = Math.sign(steerIn);
    const spinIn = r.flairActive ? r.flairDir * A.flairSpinRatio * (A.flipRate / A.spinRate) : steerIn;
    r.spinVel = damp(r.spinVel, -spinIn * A.spinRate * DEG, spinIn ? A.rotAccelRate : A.rotStopRate, dt);
    const flipIn = r.flairActive ? 1 : input.brake - pedal; // S = backflip (+), W = frontflip (-)
    const flipActive = Math.abs(flipIn) > 0.1;
    r.flipVel = damp(r.flipVel, (flipActive ? flipIn : 0) * A.flipRate * DEG, flipActive ? A.rotAccelRate : A.rotStopRate, dt);

    r.airYaw = wrapAngle(r.airYaw + r.spinVel * dt);
    r.spinAngle += r.spinVel * dt;
    r.flipAngle += r.flipVel * dt;

    // snap assists toward clean multiples once a real rotation has happened
    if (!spinIn && Math.abs(r.spinAngle) >= A.spinSnapMin * DEG) {
      const diff = Math.round(r.spinAngle / Math.PI) * Math.PI - r.spinAngle;
      if (Math.abs(diff) < A.spinSnapWindow * DEG) {
        const adj = diff * (1 - Math.exp(-A.spinSnapRate * dt));
        r.spinAngle += adj;
        r.airYaw = wrapAngle(r.airYaw + adj);
      }
    }
    if (!flipActive && Math.abs(r.flipAngle) >= A.flipSnapMin * DEG) {
      const diff = Math.round(r.flipAngle / TWO_PI) * TWO_PI - r.flipAngle;
      if (Math.abs(diff) < A.flipSnapWindow * DEG) r.flipAngle += diff * (1 - Math.exp(-A.flipSnapRate * dt));
    }

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

    // ---------------------------------------------------------------- auto-level
    if (++r.predictCounter % 4 === 0) r.predictLanding();
    else r.predicted.time = Math.max(0, r.predicted.time - dt);
    if (r.predicted.valid) r.airGroundNormal.lerp(r.predicted.normal, 1 - Math.exp(-A.groundSampleRate * dt)).normalize();
    r.pitchOffset = damp(r.pitchOffset, 0, A.pitchFollowRate, dt);
    r.basePitch = r.autoLevelTarget() + r.pitchOffset;

    // ---------------------------------------------------------------- ballistic motion
    r.vel.y -= P.gravity * dt;
    r.vel.multiplyScalar(1 - A.airDrag * r.vel.length() * dt);
    _seg.copy(r.vel).multiplyScalar(dt);
    const len = _seg.length();
    _dir.copy(_seg).divideScalar(len || 1);
    r.airQuat(r.quat);

    // rails first: they sit above the ground
    const g = tryGrind(r, input);
    if (g === 'grind') return;
    if (g === 'bail') return;

    const hit = len > 0 ? r.world.raycast(r.pos, _dir, len + 0.01) : null;
    if (hit && r.airTime > TUNING.landing.minAirTime && hit.normal.dot(r.vel) < 0) {
      r.pos.copy(hit.point);
      if (hit.kind === 'obstacle') {
        r.bail('Clipped the rail');
        return;
      }
      land(r, hit.normal, input);
      return;
    }
    r.pos.add(_seg);
    r.airQuat(r.quat);
  },
} satisfies RiderState;

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

function land(r: RiderController, n: Vector3, input: InputState) {
  const L = TUNING.landing;
  const check = r.checkLanding(n, input);
  const result: LandingResult = {
    ...check,
    trick: describeAir(r.airData()),
    air: r.airData(),
    intoManual: check.ok && input.manual,
  };
  r.lastLanding = result;
  if (!check.ok) {
    r.bail(check.reason, result);
    return;
  }

  // ride away: keep the tangential part of velocity
  _vt.copy(r.vel).addScaledVector(n, -r.vel.dot(n));
  const keep = check.stomped ? L.stompSpeedKeep : L.cleanSpeedKeep;
  r.speed = _vt.length() * keep;
  const travelYaw = yawFromTangent(_vt.normalize(), n);
  const visYaw = r.airYaw;
  r.travelYaw = r.heading = travelYaw;
  r.fakie = check.fakie;
  r.fakieVis = r.fakie ? Math.PI : 0;
  r.yawVisOffset = wrapAngle(visYaw - (r.heading + r.fakieVis));
  r.normal.copy(n);
  r.steer = 0;
  r.compression = 0;
  r.whipAngle = r.barAngle = 0;
  r.visCompVel += Math.min(6, check.impact * 0.5);
  r.setState('GROUNDED');
  Grounded.orient(r, 0);
  r.events.emit('landed', result);
  if (result.intoManual) {
    r.manualNose = false;
    r.setState('MANUALING');
  }
}
