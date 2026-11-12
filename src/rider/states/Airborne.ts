import { Vector3 } from 'three';
import { TUNING } from '../../tuning';
import type { InputState } from '../../core/input/actions';
import { DEG, damp, wrapAngle } from '../../core/math';
import type { RiderController } from '../RiderController';
import type { LandingResult, RiderState } from '../types';
import { applyLatePop, Grounded } from './Grounded';

const _seg = new Vector3(), _dir = new Vector3(), _vt = new Vector3();

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

    // ---------------------------------------------------------------- rotation input
    if (r.pedalLatched && input.pedal < 0.1) r.pedalLatched = false;
    const pedal = r.pedalLatched ? 0 : input.pedal;

    const spinIn = Math.abs(input.steer) > 0.1 ? input.steer : 0;
    r.spinVel = damp(r.spinVel, -spinIn * A.spinRate * DEG, spinIn ? A.rotAccelRate : A.rotStopRate, dt);
    const flipIn = input.brake - pedal; // S = backflip (+), W = frontflip (-)
    const flipActive = Math.abs(flipIn) > 0.1;
    r.flipVel = damp(r.flipVel, (flipActive ? flipIn : 0) * A.flipRate * DEG, flipActive ? A.rotAccelRate : A.rotStopRate, dt);

    r.airYaw = wrapAngle(r.airYaw + r.spinVel * dt);
    r.spinAngle += r.spinVel * dt;
    r.flipAngle += r.flipVel * dt;

    // snap assists toward clean multiples once a real rotation has happened
    if (!spinIn && Math.abs(r.spinAngle) >= A.spinSnapMin * DEG) {
      const target = Math.round(r.spinAngle / Math.PI) * Math.PI;
      const diff = target - r.spinAngle;
      if (Math.abs(diff) < A.spinSnapWindow * DEG) {
        const adj = diff * (1 - Math.exp(-A.spinSnapRate * dt));
        r.spinAngle += adj;
        r.airYaw = wrapAngle(r.airYaw + adj);
      }
    }
    if (!flipActive && Math.abs(r.flipAngle) >= A.flipSnapMin * DEG) {
      const target = Math.round(r.flipAngle / (2 * Math.PI)) * 2 * Math.PI;
      const diff = target - r.flipAngle;
      if (Math.abs(diff) < A.flipSnapWindow * DEG) r.flipAngle += diff * (1 - Math.exp(-A.flipSnapRate * dt));
    }

    // auto-level: predict the touchdown surface, blend the nose from takeoff pitch toward it
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

    const hit = len > 0 ? r.world.raycast(r.pos, _dir, len + 0.01) : null;
    if (hit && r.airTime > TUNING.landing.minAirTime && hit.normal.dot(r.vel) < 0) {
      r.pos.copy(hit.point);
      r.airQuat(r.quat);
      if (hit.kind === 'obstacle') {
        r.bail('Clipped the rail (grinds come in Phase 2)');
        return;
      }
      land(r, hit.normal, input);
      return;
    }
    r.pos.add(_seg);
    r.airQuat(r.quat);
    if (r.airTime > 0.05 && r.bikeTouchesRail(r.quat)) r.bail('Clipped the rail (grinds come in Phase 2)');
  },
} satisfies RiderState;

function land(r: RiderController, n: Vector3, input: InputState) {
  const L = TUNING.landing;
  const check = r.checkLanding(n, input);
  const result: LandingResult = {
    ...check,
    trick: r.describeAir(),
    airTime: r.airTime,
    spinDeg: r.spinAngle / DEG,
    flipDeg: r.flipAngle / DEG,
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
  const travelYaw = Math.atan2(_vt.x, _vt.z);
  const visYaw = r.airYaw;
  r.travelYaw = r.heading = travelYaw;
  r.fakie = check.fakie;
  r.fakieVis = r.fakie ? Math.PI : 0;
  r.yawVisOffset = wrapAngle(visYaw - (r.heading + r.fakieVis));
  r.normal.copy(n);
  r.steer = 0;
  r.compression = 0;
  r.visCompVel += Math.min(6, check.impact * 0.5);
  r.setState('GROUNDED');
  Grounded.orient(r, 0);
  r.events.emit('landed', result);
}
