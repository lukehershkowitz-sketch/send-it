/// <reference types="node" />
/** Shared "player" logic for the headless tests: timed pops and momentum-aware rotation control. */
import { TUNING } from '../src/tuning';
import { DEG } from '../src/core/math';
import type { InputState } from '../src/core/input/actions';
import type { RiderController } from '../src/rider/RiderController';
import type { Lip } from '../src/world/World';

/** Hold Space on the approach and let go early enough that the push finishes at the lip. `lead` = extra metres early. */
export function popRelease(r: RiderController, lip: Lip, i: InputState, lead = 0, window = 3.4) {
  const hv = Math.hypot(r.vel.x, r.vel.z) || r.speed;
  const rel = hv * TUNING.pop.extendTime + lead;
  const d = (lip.pos.x - r.pos.x) * lip.dir.x + (lip.pos.z - r.pos.z) * lip.dir.z;
  i.pop = d < rel + window && d > rel;
}

/**
 * Bang-bang rotation control a player would use: accelerate toward the target angle, then
 * counter-steer early enough to stop on it. Returns −1..1 (sign = direction of the angle change).
 */
export function rotCmd(angle: number, rate: number, target: number, accel: number, band = 2 * DEG): number {
  const err = target - angle;
  const stop = (rate * Math.abs(rate)) / (2 * accel);
  if (Math.abs(err) < band && Math.abs(rate) < 0.6) return 0;
  const want = err - stop;
  if (Math.abs(want) < band) return 0;
  return Math.sign(want);
}

/** Flat spin to `deg` (positive = right, i.e. D). */
export function spinPilot(r: RiderController, i: InputState, deg: number, margin = 6) {
  if (r.airTime < 0.05 || (r.predicted.valid && r.predicted.time < 0.22)) return; // let go before touchdown
  const rate = r.rot.omega.dot(r.rot.frameUp);                 // + = left
  const cmd = rotCmd(r.rot.spin, rate, -deg * DEG + Math.sign(deg) * margin * DEG * 0, TUNING.rot.torque.yaw * 1.0);
  i.steer = -cmd;                                              // left-positive yaw → steer sign flips
}

/** Flip to `deg` (positive = backflip). */
export function flipPilot(r: RiderController, i: InputState, deg: number) {
  if (r.airTime < 0.05 || (r.predicted.valid && r.predicted.time < 0.22)) return;
  const rate = -r.rot.omegaB.x;                                // + = backflip
  const cmd = rotCmd(r.flipEff, rate, deg * DEG, TUNING.rot.torque.pitch * 1.0);
  if (cmd > 0) i.brake = 1; else if (cmd < 0) i.pedal = 1;
}
