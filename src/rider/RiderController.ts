import { Quaternion, Vector3 } from 'three';
import { TUNING } from '../tuning';
import type { Emitter } from '../core/events';
import { type InputState, emptyInput } from '../core/input/actions';
import { DEG, UP, clamp, projectOnPlane, wrapAngle } from '../core/math';
import type { World } from '../world/World';
import {
  VARIATIONS, type AirData, type DebrisBody, type GrindType, type LandingCheck, type LandingResult, type PopInfo,
  type RiderEvents, type RiderState, type StateName, type Variation,
} from './types';
import type { RailSeg } from '../world/World';
import { describeAir } from '../tricks/scoring';
import { bikeRoll, makeRot, resetRot, type RotState } from './aero';
import { RiderBody } from './RiderBody';
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

  // --- pop: preload (hold) → extension (release) → takeoff. The push is spread over the extension.
  compression = 0;
  preloadTime = 0;
  popWasHeld = false;
  popExtending = false;
  extendT = 0;
  popStrength = 0;          // the full push this pop would give (m/s)
  popApplied = 0;           // how much of it has been delivered so far
  popIsHop = false;
  popDir = new Vector3(0, 1, 0);
  extendPose = 0;           // 0..1 visual push-off extension (rises during the push, fades after takeoff)
  shiftX = 0;               // body-weight shift intent while loaded (−1 left … +1 right)
  shiftZ = 0;               // (−1 back … +1 forward)
  hopT = 0;                 // front-wheel-lift timer for bunny hops
  lateTimer = 0;
  lateCompression = 0;
  takeoffNormal = new Vector3(0, 1, 0);
  lastPop: PopInfo | null = null;
  travelPitchRate = 0;      // smoothed pitch rate of the travel direction (ramp curvature × speed)
  wheelPitchOff = 0;        // smoothed pitch of the wheel-to-wheel line vs the surface tangent
  groundPitchRate = 0;      // rad/s the ground is rotating the bike nose-up (ramp curvature × speed)
  load = 1;                 // g-load from ramp curvature (1 = flat ground)

  // --- air: a real rigid-body rotation (see aero.ts); rider's own motion lives in `body`
  rot: RotState = makeRot();
  body = new RiderBody();
  /** Air rotation frame: identity off kickers; off a vert wall its "up" is the wall normal. */
  airFrame = new Quaternion();
  airFrameInv = new Quaternion();
  vertAir = false;
  airGroundNormal = new Vector3(0, 1, 0); // smoothed normal of the predicted landing surface
  /** Ballistic prediction of where we'll touch down (refreshed ~30 Hz while airborne). */
  predicted = { valid: false, point: new Vector3(), normal: new Vector3(0, 1, 0), time: 99 };
  get spinAngle() { return this.rot.spin; }   // accumulated horizontal rotation (rad, + = left)
  get flipAngle() { return this.rot.flip; }   // accumulated flip (rad, + = backflip)
  get rollAngle() { return this.rot.roll; }   // accumulated roll (rad, + = right side down)
  /** Nose elevation at takeoff, and where the bike would be pitched with no flip at all (flight path → landing slope). */
  airHeading = new Vector3(0, 0, 1); // horizontal facing (in the frame), turned only by spin: stays defined through flips
  noseAtTakeoff = 0;
  naturalPitch = 0;
  /** Flip amount (rad) relative to that natural attitude change: a kicker launches nose-up and the landing wants nose-down, so a clean backflip is ~300° of raw rotation but counts as 360°. */
  get flipEff() { return this.rot.flip - (this.naturalPitch - this.noseAtTakeoff); }
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
  lastSpinDir = 1;
  assistCalm = 0;           // 0..1: how much the stabiliser is following the flight path (off while you're tricking)
  airCmd = { yaw: 0, pitch: 0, roll: 0, mix: 0 }; // smoothed rotation commands (keys ramp in and out instead of stepping)
  tableDir = 1;             // which side the tabletop rolls toward
  tablePressed = false;
  varBlend: Record<Variation, number> = { tuck: 0, superman: 0, cancan: 0 };
  varHold: Record<Variation, number> = { tuck: 0, superman: 0, cancan: 0 };
  varBest: Record<Variation, number> = { tuck: 0, superman: 0, cancan: 0 };
  feetOff = 0;      // visual: feet off the pedals (whips)
  handsOff = 0;     // visual: hands off the bars (barspins)

  // --- landing wobble: rotation of the bike relative to the ground (body-frame rotation vector, rad)
  wobble = new Vector3();
  wobbleV = new Vector3();
  private lastVel = new Vector3();
  accelB = new Vector3();   // felt acceleration in the bike frame (m/s²), for the rider's inertia

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
    this.updateWobble(dt);
    this.lastVel.copy(this.vel);
    this.current.update(this, dt, input);

    if (this.state !== 'AIRBORNE') {
      for (const v of VARIATIONS) this.varBlend[v] = Math.max(0, this.varBlend[v] - dt * 6);
      this.feetOff = Math.max(0, this.feetOff - dt * 6);
      this.handsOff = Math.max(0, this.handsOff - dt * 6);
    }
    if (this.state !== 'MANUALING') this.visOffset.set(0, 0, 0);
    this.ignoreRailTime = Math.max(0, this.ignoreRailTime - dt);
    this.manualWasHeld = input.manual;

    this.updateBody(dt);

    if (this.state !== 'BAILED' && this.pos.y < TUNING.physics.killY) this.respawn();
    if (this.state !== 'BAILED') this.trackProgress();
  }

  /** Landing wobble: a spring pulling the bike's orientation back onto the ground. */
  private updateWobble(dt: number) {
    const L = TUNING.landing;
    if (this.state !== 'GROUNDED' && this.state !== 'MANUALING') { this.wobble.set(0, 0, 0); this.wobbleV.set(0, 0, 0); return; }
    this.wobbleV.addScaledVector(this.wobble, -L.wobbleStiffness * dt).addScaledVector(this.wobbleV, -L.wobbleDamping * dt);
    this.wobble.addScaledVector(this.wobbleV, dt);
  }

  /** Rider body targets from what the bike is doing. */
  private updateBody(dt: number) {
    const P = TUNING.pop;
    const st = this.state;
    const B = this.body;
    // push-off extension: rises through the push, fades after takeoff
    this.extendPose = this.popExtending
      ? Math.min(1, this.extendT / P.extendTime)
      : Math.max(0, this.extendPose - dt * 4);
    // felt acceleration in the bike frame (gravity removed), for the rider's inertia
    this.accelB.copy(this.vel).sub(this.lastVel).divideScalar(dt);
    if (st === 'AIRBORNE') this.accelB.set(0, 0, 0);
    else this.accelB.y += TUNING.physics.gravity;
    this.accelB.clampLength(0, 60).applyQuaternion(_q.copy(this.quat).invert());

    let crouch = 0, sx = 0, sz = 0, table = 0;
    if (st === 'AIRBORNE') {
      const w = this.rot.omegaB;
      const curl = 0.5 * clamp(Math.abs(w.x) / 6, 0, 1) + 0.22 * clamp(Math.abs(w.y) / 9, 0, 1) + 0.12 * clamp(Math.abs(w.z) / 7, 0, 1);
      const tl = this.predicted.valid ? this.predicted.time : 99;
      const prep = clamp((0.42 - tl) / 0.28, 0, 1) * (1 - 0.7 * clamp(this.rot.omega.length() / 5, 0, 1));
      // jump phases from the flight itself: stretched out leaving the lip, knees drawn up and weight centred at the
      // apex (the bike floats), then arms and legs reaching for the ground on the way down
      const vy = this.vel.y;
      const rise = clamp(vy / 7, 0, 1), fall = clamp(-vy / 9, 0, 1);
      const apex = 1 - clamp(Math.abs(vy) / 4.5, 0, 1);
      const sinceTakeoff = clamp(this.airTime / 0.35, 0, 1);
      const phase = -0.22 * rise * (1 - sinceTakeoff * 0.5) + 0.2 * apex - 0.2 * fall * (1 - prep);
      crouch = (0.3 + curl + phase) * (1 - prep) + -0.18 * prep - this.extendPose * 0.55;
      const roll = bikeRoll(this.rot);
      // torso leans back going up, forward onto the bars coming down; a slow drift keeps long airs alive
      const sway = Math.sin(this.airTime * 2.3) * 0.015 * apex;
      sz = clamp(-w.x * 0.0125 - 0.06 * rise + 0.05 * fall + sway, -0.16, 0.16);
      sx = clamp(-w.y * 0.01 + 0.12 * Math.sin(roll) + Math.cos(this.airTime * 1.7) * 0.012 * apex, -0.14, 0.14);
      table = clamp((Math.abs(roll) - 35 * DEG) / (37 * DEG), 0, 1);
    } else if (st === 'GRINDING') {
      crouch = 0.35;
      sx = -this.balance * 0.08;
    } else {
      const preload = this.compression * (this.popExtending ? 1 - Math.min(1, this.extendT / P.extendTime) : 1);
      const loadComp = clamp((this.load - 1) * P.loadCompress, 0, P.loadMaxCompress);
      crouch = Math.max(preload, loadComp) - this.extendPose * 0.5 + (st === 'MANUALING' ? 0.15 : 0);
      sz = clamp(this.shiftZ * 0.12 - this.accelB.z * 0.003, -0.16, 0.16);
      sx = clamp(-this.shiftX * 0.1 - this.accelB.x * 0.002, -0.14, 0.14);
    }
    B.update(dt, { crouch, shiftX: sx, shiftZ: sz, table });
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
    this.preloadTime = 0;
    this.popWasHeld = false;
    this.popExtending = false;
    this.extendPose = 0;
    this.shiftX = this.shiftZ = 0;
    this.hopT = 0;
    this.lateTimer = 0;
    this.groundPitchRate = 0;
    this.wheelPitchOff = 0;
    this.travelPitchRate = 0;
    this.load = 1;
    this.rot.omega.set(0, 0, 0);
    this.body.reset();
    this.wobble.set(0, 0, 0);
    this.wobbleV.set(0, 0, 0);
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

  /**
   * Leave the ground with the current `vel`. If a pop was extending, whatever push had built up by
   * now is added (a lip that arrives early cuts it short; `ended` = the extension finished first).
   */
  takeoff(popped: boolean, ended = false): void {
    const A = TUNING.air, P = TUNING.pop;
    const wasHop = this.popIsHop && this.popExtending;
    if (this.popExtending) {
      const applied = ended ? this.popStrength : this.popApplied;
      this.vel.addScaledVector(this.popDir, applied);
      const frac = this.popStrength > 0 ? applied / this.popStrength : 0;
      const label: PopInfo['label'] = wasHop ? 'HOP' : ended ? 'EARLY' : frac >= 0.92 ? 'PERFECT' : 'LATE';
      const info: PopInfo = { label, factor: frac, strength: applied };
      this.lastPop = info;
      this.events.emit('pop', info);
      this.popExtending = false;
      popped = true;
    }
    // vert: leaving a near-vertical wall going up → spin/flip in the wall's frame, come back down it
    this.vertAir = this.normal.y < A.vertNormalY && this.vel.y > 0.5;
    if (this.vertAir) {
      _u.set(this.normal.x, 0, this.normal.z).normalize();
      this.airFrame.setFromUnitVectors(UP, _u);
      this.vel.addScaledVector(_u, A.vertOutSpeed - this.vel.dot(_u));
    } else this.airFrame.identity();
    this.airFrameInv.copy(this.airFrame).invert();

    // the bike keeps the rotation the ramp was giving it (v · curvature), plus the rider's weight shift
    const q0 = this.groundQuatNoLean();
    const xb = _f.set(1, 0, 0).applyQuaternion(q0).clone();
    const zb = _u.set(0, 0, 1).applyQuaternion(q0).clone();
    const omega = new Vector3()
      .addScaledVector(xb, -this.groundPitchRate * P.pitchRateKeep)          // nose-up rate = backflip direction (−X)
      .addScaledVector(xb, this.shiftZ * P.shiftRate)                         // forward lean → frontflip direction
      .addScaledVector(zb, this.shiftX * P.shiftRate * 0.7);                  // sideways lean → roll
    if (wasHop && popped) omega.addScaledVector(xb, -P.hopFrontLift);        // bunny hop: front wheel first
    resetRot(this.rot, q0, omega, _pv.copy(UP).applyQuaternion(this.airFrame));
    this.noseAtTakeoff = this.naturalPitch = Math.asin(clamp(zb.dot(this.rot.frameUp), -1, 1));
    this.airHeading.copy(zb).addScaledVector(this.rot.frameUp, -zb.dot(this.rot.frameUp));
    if (this.airHeading.lengthSq() < 1e-4) this.airHeading.set(0, 0, 1).applyQuaternion(this.airFrame);
    this.airHeading.normalize();
    this.hopT = wasHop && popped ? P.hopLiftTime : 0;
    this.popIsHop = false;
    this.shiftX = this.shiftZ = 0;

    this.airGroundNormal.copy(this.normal);
    this.predictLanding();
    this.airTime = 0;
    this.takeoffFakie = this.fakie;
    this.fromGrind = this.state === 'GRINDING';
    this.resetTricks();
    this.takeoffNormal.copy(this.normal);
    this.pedalLatched = TUNING.air.latchPedalAtTakeoff && this.input.pedal > 0.2;
    if (!popped && this.input.pop && this.compression >= P.minCompression) {
      this.lateTimer = P.lateWindow;
      this.lateCompression = this.compression;
    } else this.lateTimer = 0;
    this.setState('AIRBORNE');
    this.events.emit('takeoff', { popped });
  }

  resetTricks(): void {
    this.whipAngle = this.whipVel = this.barAngle = this.barVel = 0;
    this.whipsDone = this.barsDone = 0;
    this.chain = [];
    for (const v of VARIATIONS) { this.varHold[v] = 0; this.varBest[v] = 0; }
  }

  /** Snapshot of the current air, for naming/scoring. */
  airData(): AirData {
    const variations: AirData['variations'] = {};
    for (const v of VARIATIONS) if (this.varBest[v] > 0) variations[v] = this.varBest[v];
    return {
      airTime: this.airTime,
      spinDeg: this.rot.spin / DEG,
      flipDeg: this.flipEff / DEG,
      rollDeg: this.rot.roll / DEG,
      maxTiltDeg: this.rot.maxTilt / DEG,
      maxRollDeg: this.rot.maxRoll / DEG,
      tableTime: this.rot.tableTime,
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

  /** Air orientation. */
  airQuat(out: Quaternion): Quaternion {
    return out.copy(this.rot.q);
  }

  /** Evaluate a landing against surface normal `n` with the current orientation + velocity. */
  checkLanding(n: Vector3, input: InputState): LandingCheck {
    const L = TUNING.landing;
    _q.copy(this.rot.q);
    _f.set(0, 0, 1).applyQuaternion(_q);
    _u.set(0, 1, 0).applyQuaternion(_q);
    const xb = _pd.set(1, 0, 0).applyQuaternion(_q);
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
    const rollErr = Math.asin(clamp(Math.abs(xb.dot(n)), 0, 1)) / DEG;
    const inverted = _u.dot(n) < 0.2;
    // which wheel touches first: nose rising away from the ground = rear first (relative to the riding direction)
    const rideDir = _f.dot(this.vel) >= 0 ? 1 : -1;
    const pitchSigned = _f.dot(n) * rideDir;
    const wheelFirst: LandingCheck['wheelFirst'] = pitchErr < 4 ? 'both' : pitchSigned > 0 ? 'rear' : 'front';
    // tiny unintended airs (rolling over a knuckle) don't need released inputs
    const holding = L.requireInputsReleased && this.airTime >= L.smallAirTime && this.trickInputHeld(input);
    const whipErr = angleToTurn(this.whipAngle) / DEG;
    const barErr = angleToTurn(this.barAngle) / DEG;
    const variation = Math.max(...VARIATIONS.map((v) => this.varBlend[v]));
    const impact = Math.max(0, -this.vel.dot(n));
    // short drops and steep curved transitions (the surface normal changes under you) are more forgiving
    const scale = (this.airTime < L.smallAirTime ? L.smallAirToleranceScale : 1) * (n.y < 0.75 ? L.steepToleranceScale : 1);
    const yawTol = L.yawTolerance * scale, pitchTol = L.pitchTolerance * scale, rollTol = L.rollTolerance * scale;

    const horiz = Math.hypot(this.vel.x, this.vel.z) || 1;
    const facesUs = (n.x * this.vel.x + n.z * this.vel.z) / horiz < -L.casedSlope;
    let reason = '';
    const severity0 = Math.max(pitchErr / pitchTol, rollErr / rollTol, yawErr / yawTol);
    if (facesUs && (inverted || pitchErr > pitchTol || impact > L.casedImpact)) reason = 'Cased it — needs more speed or pop';
    else if (inverted) reason = 'Landed upside down';
    else if (severity0 > L.bailSeverity) reason = pitchErr / pitchTol >= Math.max(rollErr / rollTol, yawErr / yawTol) ? this.noseOrTail(n) : rollErr / rollTol > yawErr / yawTol ? 'Landed on the side' : 'Landed sideways';
    else if (impact > L.maxImpactSpeed) reason = 'Too hard — flat landing';
    const ok = reason === '';
    const stomped = ok && !holding && yawErr <= L.stompYaw && pitchErr <= L.stompPitch && rollErr <= L.stompPitch && whipErr <= L.whipTolerance && barErr <= L.barTolerance && variation <= L.variationMaxBlend;
    // unfinished whips/bars, grabs and held keys no longer bail: they just make it a sketchy save
    const messy = holding || whipErr > L.whipTolerance || barErr > L.barTolerance || variation > L.variationMaxBlend;
    const severity = Math.max(severity0, messy ? L.sketchyAt * 0.8 : 0);
    const sketchy = ok && severity >= L.sketchyAt;
    return { sketchy, yawErr, pitchErr, rollErr, rollTol, severity, wheelFirst, whipErr, barErr, variation, fakie, inverted, holding, impact, yawTol, pitchTol, ok, stomped, reason };
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
      input.tailwhip || input.flair || input.tuck || input.superman || input.cancan || input.tabletop
    );
  }

  bail(reason: string, landing: LandingResult | null = null): void {
    const B = TUNING.bail;
    this.bailReason = reason;
    const q = this.state === 'AIRBORNE' ? this.airQuat(new Quaternion()) : this.quat.clone();
    const w0 = this.state === 'AIRBORNE' ? this.rot.omega.clone() : new Vector3();
    const rnd = (k: number) => (Math.random() * 2 - 1) * k;
    const bike = this.debrisBike, rider = this.debrisRider;
    bike.pos.copy(this.pos).add(new Vector3(0, 0.45, 0).applyQuaternion(q));
    bike.vel.copy(this.vel).multiplyScalar(0.85).add(new Vector3(rnd(1), B.throwUp * 0.5, rnd(1)));
    bike.quat.copy(q);
    bike.angVel.set(rnd(B.tumbleSpin), rnd(B.tumbleSpin), rnd(B.tumbleSpin)).addScaledVector(w0, 0.7);
    rider.pos.copy(this.pos).add(new Vector3(0, 1.0, 0).applyQuaternion(q));
    rider.vel.copy(this.vel).multiplyScalar(1.05).add(new Vector3(rnd(1.5), B.throwUp, rnd(1.5)));
    rider.quat.copy(q);
    rider.angVel.set(rnd(B.tumbleSpin), rnd(B.tumbleSpin * 0.5), rnd(B.tumbleSpin)).addScaledVector(w0, 0.5);
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

