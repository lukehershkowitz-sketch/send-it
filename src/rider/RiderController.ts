import { Quaternion, Vector3 } from 'three';
import { TUNING } from '../tuning';
import type { Emitter } from '../core/events';
import { type InputState, emptyInput } from '../core/input/actions';
import { DEG, UP, clamp, projectOnPlane, quatFromYawPitch, wrapAngle, yawOf } from '../core/math';
import type { World } from '../world/World';
import type { DebrisBody, LandingCheck, LandingResult, PopInfo, RiderEvents, RiderState, StateName } from './types';
import { Grounded } from './states/Grounded';
import { Airborne } from './states/Airborne';
import { Bailed } from './states/Bailed';

const FWD = new Vector3(0, 0, 1);
const _f = new Vector3(), _u = new Vector3(), _vt = new Vector3(), _fp = new Vector3(), _q = new Quaternion();
const _pp = new Vector3(), _pv = new Vector3(), _ps = new Vector3(), _pd = new Vector3();

/**
 * Arcade kinematic rider. Owns all simulation state; per-state behaviour lives in ./states.
 * `pos` is the wheel contact point (between the wheels), `quat` the bike's visual orientation.
 */
export class RiderController {
  private states: Partial<Record<StateName, RiderState>> = {
    GROUNDED: Grounded,
    AIRBORNE: Airborne,
    BAILED: Bailed,
  };
  current: RiderState = Grounded;
  get state(): StateName { return this.current.name; }
  stateTime = 0;

  // --- kinematics
  pos = new Vector3();
  vel = new Vector3();
  normal = new Vector3(0, 1, 0);
  heading = 0;      // where the bars point (travel frame, ignores fakie)
  travelYaw = 0;    // direction of motion on the ground
  speed = 0;        // ground speed along travel direction (≥ 0)
  steer = 0;        // smoothed steer input
  fakie = false;
  fakieVis = 0;     // visual yaw offset (0 or π, animates on pivots)
  yawVisOffset = 0; // residual yaw from landing slightly crooked, eases out
  prevGroundPitch = 0;

  // --- pop
  compression = 0;
  popWasHeld = false;
  lateTimer = 0;
  lateCompression = 0;
  takeoffNormal = new Vector3(0, 1, 0);
  lastPop: PopInfo | null = null;

  // --- air
  airYaw = 0;
  basePitch = 0;    // pitch from trajectory-follow (+ takeoff offset), excludes flips
  pitchOffset = 0;  // takeoff pitch relative to the auto-level target; eases to 0
  airGroundNormal = new Vector3(0, 1, 0); // smoothed normal of the predicted landing surface
  /** Ballistic prediction of where we'll touch down (refreshed ~30 Hz while airborne). */
  predicted = { valid: false, point: new Vector3(), normal: new Vector3(0, 1, 0), time: 99 };
  flipAngle = 0;    // input-driven pitch rotation (rad, backflip +)
  spinAngle = 0;    // input-driven yaw rotation (rad, signed)
  spinVel = 0;
  flipVel = 0;
  airTime = 0;
  predictCounter = 0;
  takeoffFakie = false;
  pedalLatched = false;

  // --- visuals (read by the rig)
  quat = new Quaternion();
  prevPos = new Vector3();
  prevQuat = new Quaternion();
  lean = 0;
  wheelAngle = 0;
  visComp = 0;
  visCompVel = 0;

  // --- results / bail
  lastLanding: LandingResult | null = null;
  bailReason = '';
  debrisBike: DebrisBody = makeBody(0.45);
  debrisRider: DebrisBody = makeBody(0.45);
  input: InputState = emptyInput();

  constructor(readonly world: World, readonly events: Emitter<RiderEvents>) {
    this.respawn();
  }

  setState(name: StateName): void {
    const next = this.states[name];
    if (!next) throw new Error(`State ${name} not implemented yet`);
    this.current.exit?.(this);
    this.current = next;
    this.stateTime = 0;
    next.enter(this);
  }

  step(dt: number, input: InputState): void {
    this.input = input;
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this.stateTime += dt;
    this.current.update(this, dt, input);

    // suspension / body spring (visual only)
    this.visCompVel += (-140 * this.visComp - 16 * this.visCompVel) * dt;
    this.visComp = clamp(this.visComp + this.visCompVel * dt, -0.2, 1);

    if (this.state !== 'BAILED' && this.pos.y < TUNING.physics.killY) this.respawn();
  }

  respawn(): void {
    const w = this.world;
    this.pos.copy(w.spawnPos);
    const g = w.groundBelow(this.pos);
    if (g) { this.pos.copy(g.point); this.normal.copy(g.normal); } else this.normal.set(0, 1, 0);
    this.heading = this.travelYaw = w.spawnYaw;
    this.speed = 0;
    this.vel.set(0, 0, 0);
    this.fakie = false;
    this.fakieVis = 0;
    this.yawVisOffset = 0;
    this.compression = 0;
    this.popWasHeld = false;
    this.lateTimer = 0;
    this.spinVel = this.flipVel = 0;
    this.visComp = this.visCompVel = 0;
    this.lean = 0;
    this.current = Grounded;
    this.stateTime = 0;
    Grounded.enter(this);
    Grounded.orient(this, 0);
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this.events.emit('respawn', {});
  }

  // ------------------------------------------------------------------ transitions

  /** Leave the ground with the current `vel`. */
  takeoff(popped: boolean): void {
    // orientation at takeoff (without lean)
    _f.copy(FWD).applyQuaternion(this.groundQuatNoLean());
    this.airYaw = yawOf(_f);
    this.basePitch = Math.asin(clamp(_f.y, -1, 1));
    this.airGroundNormal.copy(this.normal);
    this.predictLanding();
    this.pitchOffset = this.basePitch - this.autoLevelTarget();
    this.flipAngle = this.spinAngle = 0;
    this.spinVel = this.flipVel = 0;
    this.airTime = 0;
    this.takeoffFakie = this.fakie;
    this.takeoffNormal.copy(this.normal);
    this.pedalLatched = TUNING.air.latchPedalAtTakeoff && this.input.pedal > 0.2;
    if (!popped && this.input.pop && this.compression >= TUNING.pop.minCompression) {
      this.lateTimer = TUNING.pop.lateWindow;
      this.lateCompression = this.compression;
    } else this.lateTimer = 0;
    this.setState('AIRBORNE');
    this.events.emit('takeoff', { popped });
  }

  /** Ground orientation ignoring lean (used for takeoff). */
  groundQuatNoLean(): Quaternion {
    return this.quat.clone().multiply(_q.setFromAxisAngle(FWD, -this.lean));
  }

  /**
   * Where the auto-level wants the nose (rad), for the current facing: follows the trajectory
   * high up, and lines up with the surface below as you come down to it.
   */
  autoLevelTarget(): number {
    const A = TUNING.air;
    const fx = Math.sin(this.airYaw), fz = Math.cos(this.airYaw);
    const horiz = Math.max(0.01, Math.hypot(this.vel.x, this.vel.z));
    const facing = (fx * this.vel.x + fz * this.vel.z) / horiz; // cos(facing vs travel)
    const traj = Math.atan2(this.vel.y, horiz) * facing;
    const n = this.airGroundNormal;
    const ground = Math.atan2(-(n.x * fx + n.z * fz), n.y);
    const w = clamp(1 - this.predicted.time / A.alignTime, A.groundAlignMin, 1);
    return A.autoLevel * (traj + (ground - traj) * w);
  }

  /** Step the ballistic path forward and raycast it to find the touchdown surface. */
  predictLanding(maxTime = 3, dtp = 0.04): void {
    const g = TUNING.physics.gravity;
    const p = _pp.copy(this.pos), v = _pv.copy(this.vel);
    const pr = this.predicted;
    for (let t = 0; t < maxTime; t += dtp) {
      _ps.copy(v).multiplyScalar(dtp);
      _ps.y -= 0.5 * g * dtp * dtp;
      const len = _ps.length();
      const hit = len > 0 ? this.world.raycast(p, _pd.copy(_ps).divideScalar(len), len) : null;
      if (hit && (t > 0 || hit.distance > 0.05)) {
        pr.valid = true;
        pr.point.copy(hit.point);
        pr.normal.copy(hit.normal);
        pr.time = t + (hit.distance / len) * dtp;
        return;
      }
      p.add(_ps);
      v.y -= g * dtp;
    }
    pr.valid = false;
    pr.time = 99;
  }

  /** Air orientation from yaw / base pitch / flip. */
  airQuat(out: Quaternion): Quaternion {
    return quatFromYawPitch(this.airYaw, this.basePitch + this.flipAngle, out);
  }

  /** Evaluate a landing against surface normal `n` with the current orientation + velocity. */
  checkLanding(n: Vector3, input: InputState): LandingCheck {
    const L = TUNING.landing;
    this.airQuat(_q);
    _f.copy(FWD).applyQuaternion(_q);
    _u.copy(UP).applyQuaternion(_q);
    projectOnPlane(this.vel, n, _vt);
    if (_vt.lengthSq() < 0.01) projectOnPlane(_f, n, _vt);
    _vt.normalize();
    projectOnPlane(_f, n, _fp);
    const fpLen = _fp.length();
    let yawRaw = 90;
    if (fpLen > 1e-3) yawRaw = Math.acos(clamp(_fp.dot(_vt) / fpLen, -1, 1)) / DEG;
    const fakie = yawRaw > 90;
    const yawErr = fakie ? 180 - yawRaw : yawRaw;
    const pitchErr = Math.asin(clamp(Math.abs(_f.dot(n)), 0, 1)) / DEG;
    const inverted = _u.dot(n) < 0.2;
    const holding = L.requireInputsReleased && this.trickInputHeld(input);
    const impact = Math.max(0, -this.vel.dot(n));
    const scale = this.airTime < L.smallAirTime ? L.smallAirToleranceScale : 1;
    const yawTol = L.yawTolerance * scale, pitchTol = L.pitchTolerance * scale;

    const horiz = Math.hypot(this.vel.x, this.vel.z) || 1;
    const facesUs = (n.x * this.vel.x + n.z * this.vel.z) / horiz < -L.casedSlope;
    let reason = '';
    if (facesUs && (inverted || pitchErr > pitchTol || impact > L.casedImpact)) reason = 'Cased it — needs more speed or pop';
    else if (inverted) reason = 'Landed upside down';
    else if (holding) reason = 'Still holding the trick';
    else if (pitchErr > pitchTol) reason = this.noseOrTail(n);
    else if (yawErr > yawTol) reason = 'Landed sideways';
    else if (impact > L.maxImpactSpeed) reason = 'Too hard — flat landing';
    const ok = reason === '';
    const stomped = ok && yawErr <= L.stompYaw && pitchErr <= L.stompPitch;
    return { yawErr, pitchErr, fakie, inverted, holding, impact, yawTol, pitchTol, ok, stomped, reason };
  }

  private noseOrTail(n: Vector3): string {
    // _f is the bike's forward from checkLanding; positive dot with n = nose pointing away from surface.
    const d = _f.dot(n);
    const rideDir = _f.dot(this.vel) >= 0 ? 1 : -1; // fakie flips which wheel leads
    return d * rideDir > 0 ? 'Back wheel first — over-rotated' : 'Nose dive — under-rotated';
  }

  trickInputHeld(input: InputState): boolean {
    return (
      Math.abs(input.steer) > 0.2 ||
      (input.pedal > 0.2 && !this.pedalLatched) ||
      input.brake > 0.2
    );
  }

  bail(reason: string, landing: LandingResult | null = null): void {
    const B = TUNING.bail;
    this.bailReason = reason;
    const q = this.state === 'AIRBORNE' ? this.airQuat(new Quaternion()) : this.quat.clone();
    const rnd = (k: number) => (Math.random() * 2 - 1) * k;
    const bike = this.debrisBike, rider = this.debrisRider;
    bike.pos.copy(this.pos).add(new Vector3(0, 0.45, 0).applyQuaternion(q));
    bike.vel.copy(this.vel).multiplyScalar(0.85).add(new Vector3(rnd(1), B.throwUp * 0.5, rnd(1)));
    bike.quat.copy(q);
    bike.angVel.set(rnd(B.tumbleSpin), rnd(B.tumbleSpin), rnd(B.tumbleSpin));
    rider.pos.copy(this.pos).add(new Vector3(0, 1.0, 0).applyQuaternion(q));
    rider.vel.copy(this.vel).multiplyScalar(1.05).add(new Vector3(rnd(1.5), B.throwUp, rnd(1.5)));
    rider.quat.copy(q);
    rider.angVel.set(rnd(B.tumbleSpin), rnd(B.tumbleSpin * 0.5), rnd(B.tumbleSpin));
    this.setState('BAILED');
    this.events.emit('bail', { reason, landing });
  }

  /** Does the bike's body (a capsule from rear to front wheel, ~0–0.75 m up) touch a rail? */
  bikeTouchesRail(q: Quaternion): boolean {
    const C = TUNING.physics;
    _f.copy(FWD).applyQuaternion(q);
    _u.copy(UP).applyQuaternion(q);
    _pp.copy(this.pos).addScaledVector(_u, C.bikeCapsuleHeight).addScaledVector(_f, -0.45);
    _pv.copy(this.pos).addScaledVector(_u, C.bikeCapsuleHeight).addScaledVector(_f, 0.45);
    return !!this.world.railNear(_pp, _pv, C.bikeCapsuleRadius);
  }

  /** Name the air for HUD feedback (Phase 2 replaces this with the full trick system). */
  describeAir(): string {
    const spin = Math.round(Math.abs(this.spinAngle) / Math.PI) * 180;
    const flips = Math.round(this.flipAngle / (2 * Math.PI));
    const parts: string[] = [];
    if (this.takeoffFakie) parts.push('FAKIE');
    if (spin >= 180) parts.push(String(spin));
    if (flips !== 0) {
      const n = Math.abs(flips);
      parts.push(`${n === 2 ? 'DOUBLE ' : n === 3 ? 'TRIPLE ' : n > 3 ? n + 'x ' : ''}${flips > 0 ? 'BACKFLIP' : 'FRONTFLIP'}`);
    }
    if (parts.length === 0 || (parts.length === 1 && parts[0] === 'FAKIE')) parts.push(this.airTime > 0.5 ? 'AIR' : 'HOP');
    return parts.join(' ');
  }

  /** Signed yaw of the current motion (used by the camera). */
  motionYaw(): number {
    if (this.state === 'GROUNDED') return this.travelYaw;
    const h = Math.hypot(this.vel.x, this.vel.z);
    return h > 0.5 ? Math.atan2(this.vel.x, this.vel.z) : this.travelYaw;
  }

  visualYaw(): number { return wrapAngle(this.heading + this.fakieVis + this.yawVisOffset); }
}

function makeBody(radius: number): DebrisBody {
  return { pos: new Vector3(), vel: new Vector3(), quat: new Quaternion(), angVel: new Vector3(), radius };
}

