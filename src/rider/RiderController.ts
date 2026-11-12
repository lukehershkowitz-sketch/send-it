import { Quaternion, Vector3 } from 'three';
import { TUNING } from '../tuning';
import type { Emitter } from '../core/events';
import { type InputState, emptyInput } from '../core/input/actions';
import { DEG, UP, clamp, projectOnPlane, quatFromYawPitch, wrapAngle, yawOf } from '../core/math';
import type { World } from '../world/World';
import {
  VARIATIONS, type AirData, type DebrisBody, type GrindType, type LandingCheck, type LandingResult, type PopInfo,
  type RiderEvents, type RiderState, type StateName, type Variation,
} from './types';
import type { RailSeg } from '../world/World';
import { describeAir } from '../tricks/scoring';
import { Grounded } from './states/Grounded';
import { Airborne } from './states/Airborne';
import { Bailed } from './states/Bailed';
import { Grinding } from './states/Grinding';
import { Manualing } from './states/Manualing';

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
    GRINDING: Grinding,
    MANUALING: Manualing,
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
  /** Air rotation frame: identity off kickers; off a vert wall its "up" is the wall normal. */
  airFrame = new Quaternion();
  airFrameInv = new Quaternion();
  vertAir = false;
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
  fromGrind = false;
  // whips / barspins / flair / variations
  whipAngle = 0;    // frame rotation around the steering axis (rad)
  whipVel = 0;
  barAngle = 0;     // bar rotation (rad, + = right)
  barVel = 0;
  barDir = 1;
  whipsDone = 0;
  barsDone = 0;
  chain: AirData['chain'] = [];
  flairActive = false;
  flairDir = 1;
  lastSpinDir = 1;
  varBlend: Record<Variation, number> = { tuck: 0, superman: 0, cancan: 0 };
  varHold: Record<Variation, number> = { tuck: 0, superman: 0, cancan: 0 };
  varBest: Record<Variation, number> = { tuck: 0, superman: 0, cancan: 0 };
  feetOff = 0;      // visual: feet off the pedals (whips)
  handsOff = 0;     // visual: hands off the bars (barspins)

  // --- balance (grinds + manuals): -1..1, |b| ≥ 1 = bail
  balance = 0;
  balanceVel = 0;
  balanceDrift = 0;

  // --- grind
  rail: RailSeg | null = null;
  ignoreRail: RailSeg | null = null; // the rail we just left (no re-lock / clip for a moment)
  ignoreRailTime = 0;
  railT = 0;
  railSign = 1;
  grindType: GrindType = 'DOUBLE PEG';
  grindTime = 0;
  grindYaw = 0;     // visual yaw offset for the grind type
  grindFakie = false;
  grindSide = 1;    // which side of the rail the bike rides on (+1 = right of travel)

  // --- manual
  manualNose = false;
  manualTime = 0;
  manualWasHeld = false;
  manualBrakeLatched = false;
  /** Visual-only root offset (manual pivots around a wheel). */
  visOffset = new Vector3();

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

  /** Index of the last checkpoint rolled past (-1 = park spawn). */
  checkpoint = -1;
  private finished = false;

  constructor(public world: World, readonly events: Emitter<RiderEvents>) {
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

    if (this.state !== 'AIRBORNE') {
      for (const v of VARIATIONS) this.varBlend[v] = Math.max(0, this.varBlend[v] - dt * 6);
      this.feetOff = Math.max(0, this.feetOff - dt * 6);
      this.handsOff = Math.max(0, this.handsOff - dt * 6);
    }
    if (this.state !== 'MANUALING') this.visOffset.set(0, 0, 0);
    this.ignoreRailTime = Math.max(0, this.ignoreRailTime - dt);
    this.manualWasHeld = input.manual;

    // suspension / body spring (visual only)
    this.visCompVel += (-140 * this.visComp - 16 * this.visCompVel) * dt;
    this.visComp = clamp(this.visComp + this.visCompVel * dt, -0.2, 1);

    if (this.state !== 'BAILED' && this.pos.y < TUNING.physics.killY) this.respawn();
    if (this.state !== 'BAILED') this.trackProgress();
  }

  /** Checkpoints + finish line. */
  private trackProgress() {
    const cps = this.world.checkpoints;
    for (let i = this.checkpoint + 1; i < cps.length; i++) {
      const c = cps[i].pos;
      if (Math.hypot(c.x - this.pos.x, c.z - this.pos.z) < 6) {
        this.checkpoint = i;
        this.events.emit('checkpoint', { index: i });
      }
    }
    const f = this.world.finish;
    if (f && !this.finished && Math.hypot(f.pos.x - this.pos.x, f.pos.z - this.pos.z) < f.radius &&
        (!f.dir || f.dir.x * this.vel.x + f.dir.z * this.vel.z > 1)) {
      this.finished = true;
      this.events.emit('finish', {});
    }
  }

  /** Swap parks (keeps listeners). */
  setWorld(world: World) {
    this.world = world;
    this.checkpoint = -1;
    this.respawn();
  }

  /** Back to the very start of the park (new run / finished the line). */
  respawnAtStart() {
    this.checkpoint = -1;
    this.respawn();
  }

  respawn(): void {
    const w = this.world;
    const cp = this.checkpoint >= 0 ? w.checkpoints[this.checkpoint] : null;
    this.pos.copy(cp ? cp.pos : w.spawnPos);
    this.finished = false;
    const g = w.groundBelow(this.pos);
    if (g) { this.pos.copy(g.point); this.normal.copy(g.normal); } else this.normal.set(0, 1, 0);
    this.heading = this.travelYaw = cp ? cp.yaw : w.spawnYaw;
    this.speed = cp ? cp.speed : w.spawnSpeed;
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
    this.resetTricks();
    for (const v of VARIATIONS) this.varBlend[v] = 0;
    this.feetOff = this.handsOff = 0;
    this.balance = this.balanceVel = 0;
    this.visOffset.set(0, 0, 0);
    this.rail = null;
    this.current = Grounded;
    this.stateTime = 0;
    Grounded.enter(this);
    Grounded.orient(this, 0);
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this.events.emit('respawn', { checkpoint: this.checkpoint });
  }

  // ------------------------------------------------------------------ transitions

  /** Leave the ground with the current `vel`. */
  takeoff(popped: boolean): void {
    // vert: leaving a near-vertical wall going up → spin/flip in the wall's frame, come back down it
    const A = TUNING.air;
    this.vertAir = this.normal.y < A.vertNormalY && this.vel.y > 0.5;
    if (this.vertAir) {
      _u.set(this.normal.x, 0, this.normal.z).normalize();
      this.airFrame.setFromUnitVectors(UP, _u);
      this.vel.addScaledVector(_u, A.vertOutSpeed - this.vel.dot(_u));
    } else this.airFrame.identity();
    this.airFrameInv.copy(this.airFrame).invert();
    // orientation at takeoff (without lean), in the air frame
    _f.copy(FWD).applyQuaternion(this.groundQuatNoLean()).applyQuaternion(this.airFrameInv);
    this.airYaw = yawOf(_f);
    this.basePitch = Math.asin(clamp(_f.y, -1, 1));
    this.airGroundNormal.copy(this.normal);
    this.predictLanding();
    this.pitchOffset = this.basePitch - this.autoLevelTarget();
    this.flipAngle = this.spinAngle = 0;
    this.spinVel = this.flipVel = 0;
    this.airTime = 0;
    this.takeoffFakie = this.fakie;
    this.fromGrind = this.state === 'GRINDING';
    this.resetTricks();
    this.takeoffNormal.copy(this.normal);
    this.pedalLatched = TUNING.air.latchPedalAtTakeoff && this.input.pedal > 0.2;
    if (!popped && this.input.pop && this.compression >= TUNING.pop.minCompression) {
      this.lateTimer = TUNING.pop.lateWindow;
      this.lateCompression = this.compression;
    } else this.lateTimer = 0;
    this.setState('AIRBORNE');
    this.events.emit('takeoff', { popped });
  }

  resetTricks(): void {
    this.whipAngle = this.whipVel = this.barAngle = this.barVel = 0;
    this.whipsDone = this.barsDone = 0;
    this.chain = [];
    this.flairActive = false;
    for (const v of VARIATIONS) { this.varHold[v] = 0; this.varBest[v] = 0; }
  }

  /** Snapshot of the current air, for naming/scoring. */
  airData(): AirData {
    const variations: AirData['variations'] = {};
    for (const v of VARIATIONS) if (this.varBest[v] > 0) variations[v] = this.varBest[v];
    return {
      airTime: this.airTime,
      spinDeg: this.spinAngle / DEG,
      flipDeg: this.flipAngle / DEG,
      chain: [...this.chain],
      barDir: this.barDir,
      variations,
      takeoffFakie: this.takeoffFakie,
      fromGrind: this.fromGrind,
    };
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
    const v = _pv.copy(this.vel).applyQuaternion(this.airFrameInv); // frame space
    const horiz = Math.max(0.01, Math.hypot(v.x, v.z));
    const facing = (fx * v.x + fz * v.z) / horiz; // cos(facing vs travel)
    const traj = Math.atan2(v.y, horiz) * facing;
    const n = _ps.copy(this.airGroundNormal).applyQuaternion(this.airFrameInv);
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
      const hit = len > 0 ? this.world.raycast(p, _pd.copy(_ps).divideScalar(len), len, ['surface']) : null;
      if (hit && hit.normal.dot(_pd) < 0) { // only surfaces we're moving into (not the one we just left)
        pr.valid = true;
        pr.point.copy(hit.point);
        pr.normal.copy(hit.normal);
        pr.time = t + (hit.distance / len) * dtp;
        return;
      }
      p.add(_ps);
      v.y -= g * dtp;
    }
    // nothing found: keep a recent close prediction rather than dropping the landing alignment
    if (pr.valid && pr.time < 0.3) return;
    pr.valid = false;
    pr.time = 99;
  }

  /** Air orientation from yaw / base pitch / flip. */
  airQuat(out: Quaternion): Quaternion {
    return quatFromYawPitch(this.airYaw, this.basePitch + this.flipAngle, out).premultiply(this.airFrame);
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
    // tiny unintended airs (rolling over a knuckle) don't need released inputs
    const holding = L.requireInputsReleased && this.airTime >= L.smallAirTime && this.trickInputHeld(input);
    const whipErr = angleToTurn(this.whipAngle) / DEG;
    const barErr = angleToTurn(this.barAngle) / DEG;
    const variation = Math.max(...VARIATIONS.map((v) => this.varBlend[v]));
    const impact = Math.max(0, -this.vel.dot(n));
    const scale = this.airTime < L.smallAirTime ? L.smallAirToleranceScale : 1;
    const yawTol = L.yawTolerance * scale, pitchTol = L.pitchTolerance * scale;

    const horiz = Math.hypot(this.vel.x, this.vel.z) || 1;
    const facesUs = (n.x * this.vel.x + n.z * this.vel.z) / horiz < -L.casedSlope;
    let reason = '';
    if (facesUs && (inverted || pitchErr > pitchTol || impact > L.casedImpact)) reason = 'Cased it — needs more speed or pop';
    else if (inverted) reason = 'Landed upside down';
    else if (holding) reason = 'Still holding the trick';
    else if (whipErr > L.whipTolerance) reason = 'Frame not caught — tailwhip unfinished';
    else if (barErr > L.barTolerance) reason = 'Bars not caught — barspin unfinished';
    else if (variation > L.variationMaxBlend) reason = 'Still in the grab — let go sooner';
    else if (pitchErr > pitchTol) reason = this.noseOrTail(n);
    else if (yawErr > yawTol) reason = 'Landed sideways';
    else if (impact > L.maxImpactSpeed) reason = 'Too hard — flat landing';
    const ok = reason === '';
    const stomped = ok && yawErr <= L.stompYaw && pitchErr <= L.stompPitch;
    return { yawErr, pitchErr, whipErr, barErr, variation, fakie, inverted, holding, impact, yawTol, pitchTol, ok, stomped, reason };
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
      input.brake > 0.2 ||
      Math.abs(input.barspin) > 0.2 ||
      input.tailwhip || input.flair || input.tuck || input.superman || input.cancan
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
    const rail = this.world.railNear(_pp, _pv, C.bikeCapsuleRadius);
    return !!rail && !(rail === this.ignoreRail && this.ignoreRailTime > 0);
  }

  /** Live name of the current air (HUD). */
  describeAir(): string {
    return describeAir(this.airData(), true);
  }

  /** Signed yaw of the current motion (used by the camera). */
  motionYaw(): number {
    if (this.state === 'GROUNDED' || this.state === 'MANUALING') return this.travelYaw;
    const h = Math.hypot(this.vel.x, this.vel.z);
    return h > 0.5 ? Math.atan2(this.vel.x, this.vel.z) : this.travelYaw;
  }

  visualYaw(): number { return wrapAngle(this.heading + this.fakieVis + this.yawVisOffset); }
}

/** Distance (rad) from an angle to the nearest whole turn. */
export function angleToTurn(a: number): number {
  const r = Math.abs(a) % (2 * Math.PI);
  return Math.min(r, 2 * Math.PI - r);
}

function makeBody(radius: number): DebrisBody {
  return { pos: new Vector3(), vel: new Vector3(), quat: new Quaternion(), angVel: new Vector3(), radius };
}

