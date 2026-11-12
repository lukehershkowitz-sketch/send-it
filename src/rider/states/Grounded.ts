import { Quaternion, Vector3 } from 'three';
import { TUNING } from '../../tuning';
import type { InputState } from '../../core/input/actions';
import { DEG, UP, clamp, damp, dirFromYaw, lerp, projectOnPlane, quatFromForwardUp, wrapAngle } from '../../core/math';
import type { RiderController } from '../RiderController';
import type { PopInfo, RiderState } from '../types';

const _a = new Vector3(), _t = new Vector3(), _np = new Vector3(), _o = new Vector3(), _d = new Vector3();
const _f = new Vector3(), _rel = new Vector3(), _ql = new Quaternion();
const FWD = new Vector3(0, 0, 1);

export interface RideMode {
  pedal: boolean;      // W pedals (off in manuals: W/S balance instead)
  brake: boolean;
  steerScale: number;
  extraDrag: number;   // m/s²
}
const FULL: RideMode = { pedal: true, brake: true, steerScale: 1, extraDrag: 0 };

export const Grounded = {
  name: 'GROUNDED' as const,

  enter(r: RiderController) {
    r.prevGroundPitch = Math.asin(clamp(travelDir(r, _t).y, -1, 1));
  },

  update(r: RiderController, dt: number, input: InputState) {
    // B = manual, B + S = nose manual
    if (input.manual && !r.manualWasHeld && r.speed > TUNING.manual.minSpeed) {
      r.manualNose = input.brake > 0.3;
      r.setState('MANUALING');
      return;
    }
    rideStep(r, dt, input, FULL);
  },

  /** Build the bike's orientation from heading + surface normal, plus lean. */
  orient(r: RiderController, lean: number) {
    projectOnPlane(dirFromYaw(r.visualYaw(), _a), r.normal, _f);
    if (_f.lengthSq() < 1e-6) _f.set(0, 0, 1);
    quatFromForwardUp(_f.normalize(), r.normal, r.quat);
    r.quat.multiply(_ql.setFromAxisAngle(FWD, lean));
  },
} satisfies RiderState & { orient(r: RiderController, lean: number): void };

/** One step of riding on a surface (shared by GROUNDED and MANUALING). Returns false if the state changed. */
export function rideStep(r: RiderController, dt: number, input: InputState, mode: RideMode): boolean {
    const P = TUNING.physics, R = TUNING.ride, POP = TUNING.pop;

    // ---------------------------------------------------------------- steering / carve
    r.steer = damp(r.steer, input.steer * mode.steerScale, R.steerResponse, dt);
    const sf = clamp(r.speed / R.maxPedalSpeed, 0, 1);
    const turnRate = lerp(R.turnRateSlow, R.turnRateFast, sf) * DEG;
    r.heading = wrapAngle(r.heading - r.steer * turnRate * dt); // right = clockwise = -yaw
    const slip = wrapAngle(r.heading - r.travelYaw);
    r.travelYaw = wrapAngle(r.travelYaw + slip * (1 - Math.exp(-lerp(R.gripSlow, R.gripFast, sf) * dt)));
    r.speed -= r.speed * R.carveScrub * Math.abs(Math.sin(slip)) * dt;

    const tDir = travelDir(r, _t);

    // ---------------------------------------------------------------- longitudinal forces
    r.speed += -P.gravity * P.groundGravityScale * tDir.y * dt;

    const pitchNow = Math.asin(clamp(tDir.y, -1, 1));
    const dPitch = pitchNow - r.prevGroundPitch;
    r.prevGroundPitch = pitchNow;

    if (mode.pedal && input.pedal > 0.05) {
      if (r.fakie) {
        if (r.speed < R.fakieTurnSpeed) r.fakie = false; // pivot back to forward
      } else {
        if (r.speed < R.maxPedalSpeed)
          r.speed = Math.min(R.maxPedalSpeed, r.speed + R.pedalAccel * input.pedal * (1 - 0.6 * sf) * dt);
        if (dPitch > 0) r.speed += R.pumpGain * dPitch * input.pedal; // pumping a transition
      }
    }
    if (mode.brake && input.brake > 0.05) r.speed = Math.max(0, r.speed - R.brakeDecel * input.brake * dt);
    if (r.speed > 0) r.speed = Math.max(0, r.speed - (R.rollingResistance + mode.extraDrag + R.airDrag * r.speed * r.speed) * dt);
    r.speed = Math.min(r.speed, R.maxSpeed);
    if (r.speed < 0) {
      // rolled backwards (stalled on a ramp) → now riding fakie
      r.speed = -r.speed;
      r.heading = wrapAngle(r.heading + Math.PI);
      r.travelYaw = wrapAngle(r.travelYaw + Math.PI);
      r.fakie = !r.fakie;
      r.fakieVis = r.fakie ? Math.PI : 0;
      travelDir(r, tDir);
    }

    // ---------------------------------------------------------------- pop (load & release)
    if (input.pop) r.compression = Math.min(1, r.compression + dt / POP.compressTime);
    const released = !input.pop && r.popWasHeld;
    r.popWasHeld = input.pop;
    if (released && r.compression >= POP.minCompression) {
      doPop(r, tDir, popTiming(r));
      return false;
    }
    if (!input.pop) r.compression = Math.max(0, r.compression - dt / 0.08);

    // ---------------------------------------------------------------- move + ground follow
    const stepLen = r.speed * dt;
    if (stepLen > 0) {
      for (const h of P.wallProbeHeights) {
        _o.copy(r.pos).addScaledVector(r.normal, h);
        const wall = r.world.raycast(_o, tDir, stepLen + P.wallProbeAhead);
        if (wall && (wall.kind === 'obstacle' || wall.normal.dot(r.normal) < Math.cos(P.maxSlopeChangeDeg * DEG))) {
          if (r.speed > P.wallCrashSpeed) {
            r.bail(wall.kind === 'obstacle' ? 'Rode into the rail' : 'Hit a wall');
            return false;
          }
          r.speed = 0;
          break;
        }
      }
    }

    _np.copy(r.pos).addScaledVector(tDir, r.speed * dt);
    _o.copy(_np).addScaledVector(r.normal, P.probeHeight);
    _d.copy(r.normal).negate();
    const hit = r.world.raycast(_o, _d, P.probeHeight + P.groundSnapDist, ['surface']);
    r.vel.copy(tDir).multiplyScalar(r.speed);

    if (!hit) {
      r.pos.copy(_np);
      r.takeoff(false); // rolled off an edge / lip
      return false;
    }
    const change = hit.normal.angleTo(r.normal);
    if (change > P.maxSlopeChangeDeg * DEG || hit.normal.y < P.minGroundNormalY) {
      if (r.speed > P.wallCrashSpeed) { r.bail('Hit a wall'); return false; }
      r.speed = 0;
    } else {
      // convex crest: if the ground drops away faster than gravity can pull us down, go light
      const drop = _rel.copy(_np).sub(hit.point).dot(r.normal);
      if (drop > 0.002 && (2 * drop) / (dt * dt) > P.gravity * r.normal.y * P.convexStick) {
        r.pos.copy(_np);
        r.takeoff(false);
        return false;
      }
      r.pos.copy(hit.point);
      r.normal.copy(hit.normal);
    }

    if (r.bikeTouchesRail(r.quat)) {
      if (r.speed > P.wallCrashSpeed) { r.bail('Rode into the rail'); return false; }
      r.pos.copy(r.prevPos);
      r.speed = 0;
    }

    // ---------------------------------------------------------------- visuals
    r.fakieVis = damp(r.fakieVis, r.fakie ? Math.PI : 0, 10, dt);
    r.yawVisOffset = damp(r.yawVisOffset, 0, 8, dt);
    r.lean = damp(r.lean, r.steer * sf * R.maxLeanDeg * DEG, 8, dt);
    r.wheelAngle += (r.speed / 0.255) * dt * (r.fakie ? -1 : 1);
    Grounded.orient(r, r.lean);
  return true;
}

function travelDir(r: RiderController, out: Vector3): Vector3 {
  projectOnPlane(dirFromYaw(r.travelYaw, _a), r.normal, out);
  if (out.lengthSq() < 1e-6) out.copy(_a);
  return out.normalize();
}

/** How well-timed is a release right now? Looks for a kicker lip ahead of us. */
function popTiming(r: RiderController): { label: PopInfo['label']; factor: number } {
  const POP = TUNING.pop;
  const travel = dirFromYaw(r.travelYaw, _a);
  for (const lip of r.world.lips) {
    _rel.copy(lip.pos).sub(r.pos);
    const along = _rel.dot(lip.dir); // metres before the edge (horizontal)
    const lateral = Math.abs(_rel.dot(lip.right));
    if (lateral > lip.width / 2 + 0.4 || along < -0.3 || along > lip.length + 0.3) continue;
    if (travel.dot(lip.dir) < 0.5) continue;
    if (along <= POP.perfectWindow) return { label: 'PERFECT', factor: 1 };
    const t = clamp((along - POP.perfectWindow) / Math.max(0.1, lip.length - POP.perfectWindow), 0, 1);
    return { label: 'EARLY', factor: lerp(1, POP.earlyMinFactor, t) };
  }
  return { label: 'HOP', factor: POP.flatHopScale };
}

const _pd = new Vector3();
function doPop(r: RiderController, tDir: Vector3, timing: { label: PopInfo['label']; factor: number }) {
  const POP = TUNING.pop;
  const strength = POP.popSpeed * timing.factor * (POP.baseFraction + (1 - POP.baseFraction) * r.compression);
  _pd.copy(r.normal).lerp(UP, POP.popUpBias).normalize();
  r.vel.copy(tDir).multiplyScalar(r.speed).addScaledVector(_pd, strength);
  r.pos.addScaledVector(r.normal, 0.02);
  r.visCompVel -= 3 * r.compression; // extend legs
  const info: PopInfo = { label: timing.label, factor: timing.factor, strength };
  r.lastPop = info;
  r.compression = 0;
  r.events.emit('pop', info);
  r.takeoff(true);
}

/** Exposed for the late-pop path in the air. */
export function applyLatePop(r: RiderController) {
  const POP = TUNING.pop;
  const strength = POP.popSpeed * POP.lateFactor * (POP.baseFraction + (1 - POP.baseFraction) * r.lateCompression);
  _pd.copy(r.takeoffNormal).lerp(UP, POP.popUpBias).normalize();
  r.vel.addScaledVector(_pd, strength);
  const info: PopInfo = { label: 'LATE', factor: POP.lateFactor, strength };
  r.lastPop = info;
  r.compression = 0;
  r.lateTimer = 0;
  r.events.emit('pop', info);
}
