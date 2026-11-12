import { Quaternion, Vector3 } from 'three';
import { TUNING } from '../../tuning';
import type { InputState } from '../../core/input/actions';
import { DEG, UP, clamp, quatFromYawPitch, segSegDistance, yawOf } from '../../core/math';
import type { RiderController } from '../RiderController';
import { angleToTurn } from '../RiderController';
import { VARIATIONS, type GrindType, type RiderState } from '../types';

const FWD = new Vector3(0, 0, 1);
const _f = new Vector3(), _u = new Vector3(), _rear = new Vector3(), _front = new Vector3();
const _railDir = new Vector3(), _railPt = new Vector3(), _peg = new Vector3(), _tmp = new Vector3();
const _travel = new Vector3(), _q = new Quaternion(), _qr = new Quaternion();
const _st = { s: 0, t: 0 };
const AXLE_Y = 0.257, AXLE_Z = 0.49, PEG_R = 0.022, PEG_OFFSET = 0.15;

/**
 * Called every air step. Locks onto a rail when the pegs come down onto it roughly in line;
 * returns 'bail' if the bike hits a rail any other way, or null if no rail is involved.
 */
export function tryGrind(r: RiderController, input: InputState): 'grind' | 'bail' | null {
  const G = TUNING.grind;
  if (r.airTime < 0.06 || r.world.rails.length === 0) return null;
  _f.copy(FWD).applyQuaternion(r.quat);
  _u.copy(UP).applyQuaternion(r.quat);
  _rear.copy(r.pos).addScaledVector(_u, AXLE_Y).addScaledVector(_f, -AXLE_Z);
  _front.copy(r.pos).addScaledVector(_u, AXLE_Y).addScaledVector(_f, AXLE_Z);

  for (const rail of r.world.rails) {
    if (rail === r.ignoreRail && r.ignoreRailTime > 0) continue;
    const d = segSegDistance(_rear, _front, rail.a, rail.b, _st);
    _railPt.lerpVectors(rail.a, rail.b, _st.t);
    _peg.lerpVectors(_rear, _front, _st.s);
    _railDir.subVectors(rail.b, rail.a).normalize();
    const horiz = Math.hypot(r.vel.x, r.vel.z);
    const along = r.vel.dot(_railDir);
    const alignCos = horiz > 0.1 ? Math.abs(r.vel.x * _railDir.x + r.vel.z * _railDir.z) / horiz / Math.hypot(_railDir.x, _railDir.z) : 0;
    const lockable = d <= G.snapRadius && _peg.y >= _railPt.y - 0.1 && _u.y > 0.45 &&
      alignCos >= Math.cos(G.maxEntryAngle * DEG) && Math.abs(along) > 1;
    if (!lockable) {
      // not a clean lock: only a crash if the bike actually hits it
      if (r.bikeTouchesRail(r.quat)) { r.bail(d <= G.snapRadius && alignCos < Math.cos(G.maxEntryAngle * DEG) ? 'Hit the rail too sideways' : 'Clipped the rail'); return 'bail'; }
      continue;
    }
    // mid-trick? the frame/bars/grab have to be done before you lock in
    if (angleToTurn(r.whipAngle) > 25 * DEG || angleToTurn(r.barAngle) > 30 * DEG ||
        Math.max(...VARIATIONS.map((v) => r.varBlend[v])) > 0.5 || input.tailwhip || Math.abs(input.barspin) > 0.2) {
      r.bail('Hit the rail mid-trick');
      return 'bail';
    }
    enterGrind(r, rail, _st.t, Math.sign(along) || 1, input.brake > 0.5);
    return 'grind';
  }
  return null;
}

function enterGrind(r: RiderController, rail: NonNullable<RiderController['rail']>, t: number, sign: number, pullUp: boolean) {
  const G = TUNING.grind;
  r.rail = rail;
  r.railT = t;
  r.railSign = sign;
  _railDir.subVectors(rail.b, rail.a).normalize();
  _travel.copy(_railDir).multiplyScalar(sign);
  r.speed = Math.abs(r.vel.dot(_railDir)) * 0.95;

  // facing vs travel (horizontal)
  const travelYaw = yawOf(_travel);
  _f.copy(FWD).applyQuaternion(r.quat); // world forward (air frame may be tilted off vert)
  let rel = wrapPi(yawOf(_f) - travelYaw);
  r.grindFakie = Math.abs(rel) > Math.PI / 2;
  if (r.grindFakie) rel = wrapPi(rel - Math.PI);
  const nosePitch = Math.asin(clamp(_f.y, -1, 1)); // nose-up relative to horizontal

  // which side did we come from? (right = travel × up)
  _tmp.crossVectors(_travel, UP).normalize();
  _railPt.lerpVectors(rail.a, rail.b, t);
  const side = _tmp.dot(_peg.copy(r.pos).sub(_railPt));
  r.grindSide = side >= 0 ? 1 : -1;
  let type: GrindType;
  if (pullUp || nosePitch * (r.grindFakie ? -1 : 1) > G.icepickPitch * DEG) type = 'ICEPICK';
  else if (Math.abs(rel) < G.doublePegAngle * DEG) type = 'DOUBLE PEG';
  else {
    // rel > 0 = nose turned left. Nose pointing over the far side of the rail = feeble, near side = smith.
    const noseLeft = rel > 0, cameFromRight = side > 0;
    type = Math.abs(side) < 0.05 || noseLeft === cameFromRight ? 'FEEBLE' : 'SMITH';
  }
  r.grindType = type;
  r.grindYaw = type === 'FEEBLE' || type === 'SMITH' ? Math.sign(rel) * G.feebleSmithYaw * DEG : 0;
  r.grindTime = 0;
  r.balance = (Math.random() - 0.5) * 0.1;
  r.balanceVel = (Math.random() - 0.5) * 0.2;
  r.balanceDrift = 0;
  r.compression = 0;
  r.popWasHeld = false;
  r.rot.omega.set(0, 0, 0);
  r.body.kick(2);
  r.lastLanding = null;
  r.setState('GRINDING');
  poseOnRail(r);
  r.events.emit('grindStart', { type });
}

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Shared balance-meter dynamics. Returns true while still balanced. */
export function updateBalance(
  r: RiderController, dt: number, input: number, time: number,
  B: { balanceInstability: number; instabilityGrowth: number; balanceNoise: number; balanceControl: number; balanceDamping: number },
): boolean {
  r.balanceDrift += (Math.random() - 0.5) * B.balanceNoise * 8 * dt;
  r.balanceDrift *= Math.exp(-2 * dt);
  const inst = B.balanceInstability + B.instabilityGrowth * time;
  r.balanceVel += (inst * r.balance + r.balanceDrift + input * B.balanceControl) * dt;
  r.balanceVel *= Math.exp(-B.balanceDamping * dt);
  r.balance += r.balanceVel * dt;
  return Math.abs(r.balance) < 1;
}

function poseOnRail(r: RiderController) {
  const G = TUNING.grind;
  const rail = r.rail!;
  _railDir.subVectors(rail.b, rail.a).normalize();
  _travel.copy(_railDir).multiplyScalar(r.railSign);
  _railPt.lerpVectors(rail.a, rail.b, clamp(r.railT, 0, 1));
  const facingYaw = yawOf(_travel) + (r.grindFakie ? Math.PI : 0) + r.grindYaw;
  const slope = Math.asin(clamp(_travel.y, -1, 1)) * (r.grindFakie ? -1 : 1);
  const pitch = r.grindType === 'ICEPICK' ? G.icepickNoseUp * DEG + slope : slope;
  quatFromYawPitch(facingYaw, pitch, r.quat);
  r.lean = r.balance * 0.45;
  r.quat.multiply(_qr.setFromAxisAngle(FWD, r.lean));
  // pegs sit on top of the rail: rear peg (or between both for double peg)
  const pegLocal = _tmp.set(0, AXLE_Y, r.grindType === 'DOUBLE PEG' ? 0 : -AXLE_Z);
  _peg.copy(pegLocal).applyQuaternion(r.quat);
  r.pos.copy(_railPt).addScaledVector(UP, rail.radius + PEG_R).sub(_peg);
  // pegs stick out sideways: the bike rides beside the rail, on the side we came from
  _tmp.crossVectors(_travel, UP).normalize();
  r.pos.addScaledVector(_tmp, r.grindSide * PEG_OFFSET);
  r.vel.copy(_travel).multiplyScalar(r.speed);
}

export const Grinding = {
  name: 'GRINDING' as const,
  enter() {},
  exit(r: RiderController) {
    r.events.emit('grindEnd', { type: r.grindType, time: r.grindTime });
  },
  update(r: RiderController, dt: number, input: InputState) {
    const G = TUNING.grind, P = TUNING.physics, POP = TUNING.pop;
    const rail = r.rail!;
    const len = rail.a.distanceTo(rail.b);
    r.grindTime += dt;
    _railDir.subVectors(rail.b, rail.a).normalize();
    _travel.copy(_railDir).multiplyScalar(r.railSign);

    r.speed += (-P.gravity * G.gravityScale * _travel.y - G.friction) * dt;
    r.railT += (r.railSign * r.speed * dt) / len;

    if (!updateBalance(r, dt, input.steer, r.grindTime, G)) {
      r.bail(r.balance > 0 ? 'Fell off the rail (right)' : 'Fell off the rail (left)');
      return;
    }

    // pop off: load + release Space
    if (input.pop) r.compression = Math.min(1, r.compression + dt / POP.compressTime);
    const released = !input.pop && r.popWasHeld;
    r.popWasHeld = input.pop;
    if (released && r.compression >= POP.minCompression) {
      const strength = POP.popSpeed * G.popScale * (POP.baseFraction + (1 - POP.baseFraction) * r.compression);
      leave(r, strength);
      r.events.emit('pop', { label: 'HOP', factor: G.popScale, strength });
      return;
    }

    if (r.railT < 0 || r.railT > 1 || r.speed < G.minSpeed) {
      leave(r, 0);
      return;
    }
    poseOnRail(r);
  },
} satisfies RiderState;

/** Exit the rail into the air, facing straight along the travel direction. */
function leave(r: RiderController, popStrength: number) {
  poseOnRail(r);
  r.vel.copy(_travel).multiplyScalar(Math.max(r.speed, 1)).addScaledVector(UP, popStrength);
  r.pos.addScaledVector(UP, 0.03);
  r.normal.copy(UP);
  r.fakie = r.grindFakie;
  r.lean = 0;
  const facing = yawOf(_travel) + (r.grindFakie ? Math.PI : 0);
  quatFromYawPitch(facing, 0, _q);
  r.quat.copy(_q);
  r.compression = 0;
  r.ignoreRail = r.rail;
  r.ignoreRailTime = 0.35;
  r.takeoff(popStrength > 0);
}
