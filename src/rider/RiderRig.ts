import {
  BoxGeometry, CircleGeometry, CylinderGeometry, Group, Material, Mesh, MeshBasicMaterial, MeshLambertMaterial,
  Object3D, Quaternion, SphereGeometry, TorusGeometry, Vector3,
} from 'three';
import { clamp } from '../core/math';
import type { RiderController } from './RiderController';
import type { RigModels } from './models';

const V = (x: number, y: number, z: number) => new Vector3(x, y, z);
const UPV = V(0, 1, 0);
const UNIT_CYL = new CylinderGeometry(1, 1, 1, 7);
const UNIT_BOX = new BoxGeometry(1, 1, 1);
const WHEEL_GEO = (() => {
  const knobs = new TorusGeometry(0.236, 0.024, 4, 40);
  return {
    tire: new TorusGeometry(0.222, 0.036, 8, 24),
    knobs, // a second, chunkier low-poly torus reads as tread
    wall: new TorusGeometry(0.2, 0.012, 4, 24),
    rim: new TorusGeometry(0.185, 0.013, 4, 24),
  };
})();

export interface PoseParams {
  crouch: number; wheelAngle: number; bar: number; whip: number;
  tuck: number; superman: number; cancan: number; feetOff: number; handsOff: number; lean: number;
  twist: number; headYaw: number; // torso / head yaw against the bike (rad)
  shiftX: number; shiftZ: number; table: number; // rider body relative to the bike (m) and tabletop blend
}

/** Everything needed to draw the rider for one moment (also what replays record). */
export interface RigSnapshot {
  pos: Vector3; quat: Quaternion; bailed: boolean;
  bikePos: Vector3; bikeQuat: Quaternion; riderPos: Vector3; riderQuat: Quaternion;
  pose: PoseParams;
  // camera hints
  speed: number; motionYaw: number; airborne: boolean;
}

export function makeSnapshot(): RigSnapshot {
  return {
    pos: new Vector3(), quat: new Quaternion(), bailed: false,
    bikePos: new Vector3(), bikeQuat: new Quaternion(), riderPos: new Vector3(), riderQuat: new Quaternion(),
    pose: { crouch: 0, wheelAngle: 0, bar: 0, whip: 0, tuck: 0, superman: 0, cancan: 0, feetOff: 0, handsOff: 0, lean: 0, shiftX: 0, shiftZ: 0, table: 0, twist: 0, headYaw: 0 },
    speed: 0, motionYaw: 0, airborne: false,
  };
}

/** Read the controller into a snapshot (alpha = render interpolation). */
export function snapshot(r: RiderController, alpha: number, out: RigSnapshot): RigSnapshot {
  out.bailed = r.state === 'BAILED';
  out.bikePos.copy(r.debrisBike.pos); out.bikeQuat.copy(r.debrisBike.quat);
  out.riderPos.copy(r.debrisRider.pos); out.riderQuat.copy(r.debrisRider.quat);
  out.pos.lerpVectors(r.prevPos, r.pos, alpha).add(r.visOffset);
  out.quat.slerpQuaternions(r.prevQuat, r.quat, alpha);
  const crouch = r.body.crouch;
  const P = out.pose;
  P.crouch = crouch;
  P.wheelAngle = r.wheelAngle;
  P.bar = r.barAngle;
  P.whip = r.whipAngle;
  P.tuck = r.varBlend.tuck;
  P.superman = r.varBlend.superman;
  P.cancan = r.varBlend.cancan;
  P.feetOff = r.feetOff;
  P.handsOff = r.handsOff;
  P.lean = r.state === 'GRINDING' ? -r.balance : 0;
  P.shiftX = r.body.shiftX;
  P.shiftZ = r.body.shiftZ;
  P.table = r.body.table;
  P.twist = r.body.twist;
  P.headYaw = r.body.head;
  out.speed = r.state === 'GROUNDED' ? r.speed : r.vel.length();
  out.motionYaw = r.motionYaw();
  out.airborne = r.state === 'AIRBORNE';
  return out;
}

/** Interpolate two snapshots (t = 0..1) into `out`. Doesn't blend across a bail or respawn jump. */
export function lerpSnapshot(a: RigSnapshot, b: RigSnapshot, k: number, out: RigSnapshot): RigSnapshot {
  const jump = a.bailed !== b.bailed || a.pos.distanceTo(b.pos) > 4;
  const t = jump ? 0 : Math.max(0, Math.min(1, k));
  out.bailed = a.bailed;
  out.pos.lerpVectors(a.pos, b.pos, t); out.quat.slerpQuaternions(a.quat, b.quat, t);
  out.bikePos.lerpVectors(a.bikePos, b.bikePos, t); out.bikeQuat.slerpQuaternions(a.bikeQuat, b.bikeQuat, t);
  out.riderPos.lerpVectors(a.riderPos, b.riderPos, t); out.riderQuat.slerpQuaternions(a.riderQuat, b.riderQuat, t);
  for (const key of Object.keys(out.pose) as (keyof PoseParams)[]) out.pose[key] = a.pose[key] + (b.pose[key] - a.pose[key]) * t;
  out.speed = a.speed + (b.speed - a.speed) * t;
  const dy = Math.atan2(Math.sin(b.motionYaw - a.motionYaw), Math.cos(b.motionYaw - a.motionYaw));
  out.motionYaw = a.motionYaw + dy * t;
  out.airborne = a.airborne;
  return out;
}

export interface RigColors { frame: number; rider: number; pants: number; helmet: number }

/**
 * Low-poly bike + rider built from separate parts so tricks can move them independently:
 *   root → bikeBody → bike → { framePivot (tailwhips), frontPivot (barspins) }
 *        → riderBody → rider (procedural two-bone IK limbs)
 * Bike-space axes: +Z forward, +Y up, +X left. Origin = ground contact between the wheels.
 */
export class RiderRig {
  readonly root = new Group();
  readonly bikeBody = new Group();
  readonly riderBody = new Group();
  private bike = new Group();
  private rider = new Group();
  private framePivot!: Group;
  private frontPivot!: Group;
  private frameInner!: Group;
  private frontInner!: Group;
  private framePivotBase = new Quaternion();
  private frontPivotBase = new Quaternion();
  private rearWheel!: Group;
  private frontWheel!: Group;
  private steerAxis = new Vector3();
  private detached = false;
  readonly shadow: Mesh;

  // rider limb meshes
  private limbs: Record<string, Mesh> = {};
  private torso!: Mesh;
  private pelvis!: Mesh;
  private joints: Record<string, Mesh> = {};
  private head!: Group;
  private feet: Mesh[] = [];
  private hands: Mesh[] = [];

  private mats: Record<string, Material>;

  constructor(colors: RigColors = { frame: 0x26292e, rider: 0x58626d, pants: 0x2b3038, helmet: 0xcfd3d8 }) {
    const L = (c: number) => new MeshLambertMaterial({ color: c });
    this.mats = {
      frame: L(colors.frame), chrome: L(0xcfd6dc), tire: L(0x1d1d1f), rim: L(0x9aa3ab), dark: L(0x2a2d31),
      shirt: L(colors.rider), pants: L(colors.pants), skin: L(0xe0a77f), helmet: L(colors.helmet),
      shoe: L(0x33363b), visor: L(0x222222), grip: L(0x111111), glove: L(0x2b2b30), sole: L(0x1a1a1a),
      accent: L(0x7d848c), goggle: L(0x2c3138), sidewall: L(0x6b4a2a), chain: L(0x55595e),
    };
    const pbr: Record<string, [number, number]> = {
      frame: [0.36, 0.35], chrome: [0.22, 0.95], tire: [0.95, 0], rim: [0.3, 0.85], dark: [0.55, 0.4], helmet: [0.32, 0],
      goggle: [0.15, 0.2], visor: [0.2, 0.1], chain: [0.45, 0.8], accent: [0.4, 0.1], sidewall: [0.9, 0], grip: [0.9, 0],
      shirt: [0.92, 0], pants: [0.95, 0], skin: [0.7, 0], shoe: [0.8, 0], glove: [0.85, 0], sole: [0.9, 0],
    };
    for (const [k, [r, mt]] of Object.entries(pbr)) if (this.mats[k]) this.mats[k].userData.pbr = { roughness: r, metalness: mt };
    this.root.add(this.bikeBody, this.riderBody);
    this.bikeBody.position.set(0, 0.45, 0);
    this.bikeBody.add(this.bike);
    this.bike.position.set(0, -0.45, 0);
    this.riderBody.position.set(0, 1.0, 0);
    this.riderBody.add(this.rider);
    this.rider.position.set(0, -1.0, 0);
    this.buildBike();
    this.buildRider();

    this.shadow = new Mesh(
      new CircleGeometry(0.75, 20).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }),
    );
    this.shadow.scale.set(0.55, 1, 1.15);
    this.shadow.userData.blob = true;
    this.shadow.renderOrder = 1;

    this.root.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
  }

  // ------------------------------------------------------------------ construction
  private tube(parent: Object3D, a: Vector3, b: Vector3, r: number, mat: Material): Mesh {
    const m = new Mesh(UNIT_CYL, mat);
    placeSeg(m, a, b, r);
    parent.add(m);
    return m;
  }

  private box(parent: Object3D, pos: Vector3, size: Vector3, mat: Material): Mesh {
    const m = new Mesh(UNIT_BOX, mat);
    m.position.copy(pos);
    m.scale.copy(size);
    parent.add(m);
    return m;
  }

  private wheel(): Group {
    const g = new Group();
    const tire = new Mesh(WHEEL_GEO.tire, this.mats.tire);
    tire.rotation.y = Math.PI / 2;
    const knobs = new Mesh(WHEEL_GEO.knobs, this.mats.tire);
    knobs.rotation.y = Math.PI / 2;
    const wall = new Mesh(WHEEL_GEO.wall, this.mats.sidewall);
    wall.rotation.y = Math.PI / 2;
    const rim = new Mesh(WHEEL_GEO.rim, this.mats.rim);
    rim.rotation.y = Math.PI / 2;
    g.add(knobs, wall);
    const hub = new Mesh(UNIT_CYL, this.mats.chrome);
    hub.scale.set(0.025, 0.11, 0.025);
    hub.rotation.z = Math.PI / 2;
    g.add(tire, rim, hub);
    for (let i = 0; i < 9; i++) {
      const s = new Mesh(UNIT_BOX, this.mats.rim);
      s.scale.set(0.004, 0.37, 0.004);
      s.rotation.x = (i * Math.PI) / 9;
      s.position.x = (i % 2 ? 1 : -1) * 0.012;
      g.add(s);
    }
    return g;
  }

  /** Pivot group whose local Y is the steering axis; `inner` cancels it so children use bike space. */
  private pivot(center: Vector3, axis: Vector3, baseOut: Quaternion): [Group, Group] {
    const p = new Group(), inner = new Group();
    p.position.copy(center);
    p.quaternion.setFromUnitVectors(UPV, axis);
    baseOut.copy(p.quaternion);
    const inv = p.quaternion.clone().invert();
    inner.quaternion.copy(inv);
    inner.position.copy(center).negate().applyQuaternion(inv);
    p.add(inner);
    return [p, inner];
  }

  private buildBike() {
    const m = this.mats;
    const RA = V(0, 0.257, -0.49), FA = V(0, 0.257, 0.49), BB = V(0, 0.3, -0.06);
    const seat = V(0, 0.74, -0.24), htTop = V(0, 0.84, 0.31), htBot = V(0, 0.65, 0.365);
    this.steerAxis.copy(htTop).sub(htBot).normalize();
    const headC = htTop.clone().add(htBot).multiplyScalar(0.5);

    // frame assembly (rotates for tailwhips)
    [this.framePivot, this.frameInner] = this.pivot(headC, this.steerAxis, this.framePivotBase);
    const F = this.frameInner;
    this.tube(F, seat, htTop, 0.022, m.frame);
    this.tube(F, BB, htBot, 0.026, m.frame);
    this.tube(F, BB, seat, 0.022, m.frame);
    this.tube(F, htBot, htTop, 0.032, m.frame);
    for (const x of [0.055, -0.055]) {
      this.tube(F, BB.clone().setX(x * 0.6), RA.clone().setX(x), 0.015, m.frame);
      this.tube(F, seat.clone().setX(x * 0.3), RA.clone().setX(x), 0.013, m.frame);
    }
    this.tube(F, seat, seat.clone().add(V(0, 0.08, -0.03)), 0.014, m.chrome);
    this.box(F, seat.clone().add(V(0, 0.1, -0.03)), V(0.08, 0.04, 0.24), m.dark);
    // cranks + pedals (regular stance: left foot forward)
    const pedL = V(0.14, 0.3, 0.115), pedR = V(-0.14, 0.3, -0.235);
    this.tube(F, BB.clone().setX(0.08), pedL.clone().setX(0.08), 0.014, m.dark);
    this.tube(F, BB.clone().setX(-0.08), pedR.clone().setX(-0.08), 0.014, m.dark);
    this.box(F, pedL, V(0.1, 0.022, 0.085), m.dark);
    this.box(F, pedR, V(0.1, 0.022, 0.085), m.dark);
    const ring = new Mesh(UNIT_CYL, m.chrome);
    ring.scale.set(0.085, 0.01, 0.085);
    ring.rotation.z = Math.PI / 2;
    ring.position.copy(BB).setX(-0.05);
    F.add(ring);
    this.rearWheel = this.wheel();
    this.rearWheel.position.copy(RA);
    F.add(this.rearWheel);
    const cog = new Mesh(UNIT_CYL, m.chrome);
    cog.scale.set(0.035, 0.01, 0.035); cog.rotation.z = Math.PI / 2; cog.position.copy(RA).setX(-0.05);
    F.add(cog);
    for (const dy of [1, -1]) {
      this.tube(F, V(-0.05, BB.y + 0.085 * dy, BB.z), V(-0.05, RA.y + 0.035 * dy, RA.z), 0.006, m.chain);
    }
    // pegs
    for (const x of [0.08, -0.08]) {
      const peg = new Mesh(UNIT_CYL, m.chrome);
      peg.scale.set(0.022, 0.11, 0.022);
      peg.rotation.z = Math.PI / 2;
      peg.position.copy(RA).setX(x + Math.sign(x) * 0.05);
      F.add(peg);
    }

    // front end (rotates for barspins)
    [this.frontPivot, this.frontInner] = this.pivot(headC, this.steerAxis, this.frontPivotBase);
    const FE = this.frontInner;
    for (const x of [0.05, -0.05]) this.tube(FE, htBot.clone().setX(x), FA.clone().setX(x), 0.016, m.chrome);
    const stem = htTop.clone().add(V(0, 0.035, 0.02));
    this.tube(FE, htTop, stem, 0.03, m.dark);
    const gripY = 1.05, gripZ = 0.27;
    for (const s of [1, -1]) {
      const base = V(0.075 * s, stem.y, stem.z + 0.01);
      const bend = V(0.27 * s, gripY, gripZ + 0.01);
      this.tube(FE, base, bend, 0.013, m.chrome);
      this.tube(FE, bend, V(0.36 * s, gripY, gripZ), 0.017, m.grip);
      this.tube(FE, V(0.36 * s, gripY, gripZ), V(0.375 * s, gripY, gripZ), 0.02, m.accent);
    }
    this.tube(FE, V(0.18, 0.97, 0.295), V(-0.18, 0.97, 0.295), 0.011, m.chrome);
    for (const x of [0.08, -0.08]) {
      const peg = new Mesh(UNIT_CYL, m.chrome);
      peg.scale.set(0.022, 0.11, 0.022);
      peg.rotation.z = Math.PI / 2;
      peg.position.copy(FA).setX(x + Math.sign(x) * 0.05);
      FE.add(peg);
    }
    this.frontWheel = this.wheel();
    this.frontWheel.position.copy(FA);
    FE.add(this.frontWheel);

    this.bike.add(this.framePivot, this.frontPivot);
  }

  private buildRider() {
    const m = this.mats;
    const limb = (name: string, mat: Material) => {
      const mesh = new Mesh(UNIT_CYL, mat);
      this.limbs[name] = mesh;
      this.rider.add(mesh);
    };
    limb('thighL', m.pants); limb('thighR', m.pants); limb('shinL', m.pants); limb('shinR', m.pants);
    limb('upperL', m.shirt); limb('upperR', m.shirt); limb('foreL', m.skin); limb('foreR', m.skin);
    limb('neck', m.skin);
    this.torso = new Mesh(UNIT_BOX, m.shirt);
    const stripe = new Mesh(UNIT_BOX, m.accent);
    stripe.position.set(0, 0.12, 0); stripe.scale.set(1.03, 0.1, 1.04);
    this.torso.add(stripe);
    this.rider.add(this.torso);
    this.pelvis = new Mesh(UNIT_BOX, m.pants);
    this.rider.add(this.pelvis);
    const jointGeo = new SphereGeometry(1, 8, 6);
    for (const [name, mat] of [['kneeL', m.pants], ['kneeR', m.pants], ['elbowL', m.shirt], ['elbowR', m.shirt], ['shL', m.shirt], ['shR', m.shirt]] as const) {
      const j = new Mesh(jointGeo, mat);
      this.joints[name] = j;
      this.rider.add(j);
    }
    this.head = new Group();
    const helmet = new Mesh(new SphereGeometry(0.145, 12, 9), m.helmet);
    const chin = new Mesh(new TorusGeometry(0.11, 0.03, 5, 10, Math.PI), m.helmet);
    chin.rotation.set(Math.PI / 2 + 0.35, 0, 0); chin.position.set(0, -0.07, 0.03);
    const goggle = new Mesh(UNIT_BOX, m.goggle);
    goggle.scale.set(0.2, 0.055, 0.05); goggle.position.set(0, 0.0, 0.125);
    const strap = new Mesh(new TorusGeometry(0.143, 0.012, 4, 16), m.visor);
    strap.rotation.x = Math.PI / 2; strap.position.y = 0.0;
    const peak = new Mesh(UNIT_BOX, m.helmet);
    peak.scale.set(0.22, 0.02, 0.12);
    peak.position.set(0, 0.075, 0.15); peak.rotation.x = -0.25;
    this.head.add(helmet, chin, goggle, strap, peak);
    this.rider.add(this.head);
    for (let i = 0; i < 2; i++) {
      const f = new Mesh(UNIT_BOX, m.shoe);
      f.scale.set(0.1, 0.07, 0.24);
      const sole = new Mesh(UNIT_BOX, m.sole);
      sole.position.y = -0.55; sole.scale.set(1.05, 0.25, 1.02);
      f.add(sole);
      this.feet.push(f);
      const h = new Mesh(new SphereGeometry(0.048, 7, 5), m.glove);
      this.hands.push(h);
      this.rider.add(f, h);
    }
  }

  /**
   * Swap the built-in procedural parts for Blender-built ones (see blender/build_rider.py).
   * Unit-space parts (limbs, torso, pelvis, shoes) keep the existing per-frame stretching.
   */
  useModels(parts: RigModels) {
    const meshes = (part: string) => (parts.get(part) ?? []).map((p) => new Mesh(p.geometry, this.mats[p.mat] ?? this.mats.dark));
    const replaceChildren = (g: Object3D, keep: Object3D[], part: string) => {
      const add = meshes(part);
      if (!add.length) return;
      for (const c of [...g.children]) if (!keep.includes(c)) g.remove(c);
      g.add(...add);
    };
    replaceChildren(this.frameInner, [this.rearWheel], 'frame');
    replaceChildren(this.frontInner, [this.frontWheel], 'front');
    replaceChildren(this.rearWheel, [], 'wheel');
    replaceChildren(this.frontWheel, [], 'wheel');
    // stretched parts: the piece with the part's main material becomes the mesh, others ride along as children
    const swap = (mesh: Mesh, part: string, main: string) => {
      const ps = parts.get(part);
      if (!ps?.length) return;
      const primary = ps.find((p) => p.mat === main) ?? ps[0];
      mesh.geometry = primary.geometry;
      mesh.material = this.mats[primary.mat];
      for (const c of [...mesh.children]) mesh.remove(c);
      for (const p of ps) if (p !== primary) mesh.add(new Mesh(p.geometry, this.mats[p.mat]));
    };
    const L = this.limbs;
    swap(L.thighL, 'thigh', 'pants'); swap(L.thighR, 'thigh', 'pants');
    swap(L.shinL, 'shin', 'pants'); swap(L.shinR, 'shin', 'pants');
    swap(L.upperL, 'upper', 'shirt'); swap(L.upperR, 'upper', 'shirt');
    swap(L.foreL, 'fore', 'shirt'); swap(L.foreR, 'fore', 'shirt');
    swap(this.torso, 'torso', 'shirt');
    swap(this.pelvis, 'pelvis', 'pants');
    for (const f of this.feet) swap(f, 'shoe', 'shoe');
    for (const h of this.hands) swap(h, 'glove', 'glove');
    if (parts.has('helmet')) { this.head.clear(); this.head.add(...meshes('helmet')); }
    // the Blender limbs are a bit fuller, so the elbow/knee spheres can shrink
    this.jointScale = 0.85;
  }
  private jointScale = 1;

  /** Make this rig a see-through multiplayer ghost. */
  setGhost(opacity: number) {
    for (const m of Object.values(this.mats)) { m.transparent = true; m.opacity = opacity; }
    (this.shadow.material as MeshBasicMaterial).opacity = 0.18;
  }

  /** Recolour the frame, jersey, pants and helmet. */
  setColors(c: { frame: string; jersey: string; pants: string; helmet: string }) {
    const set = (k: string, v: string) => (this.mats[k] as MeshLambertMaterial).color.set(v);
    set('frame', c.frame); set('shirt', c.jersey); set('pants', c.pants); set('helmet', c.helmet);
  }

  // ------------------------------------------------------------------ per-frame
  private _hip = V(0, 0, 0); private _sh = V(0, 0, 0); private _a = V(0, 0, 0); private _b = V(0, 0, 0);
  private _k = V(0, 0, 0); private _t = V(0, 0, 0); private _q = new Quaternion();

  /** Pose the rider + bike parts from blend weights (all 0..1) and part angles (rad). */
  pose(p: PoseParams) {
    this.rearWheel.rotation.x = p.wheelAngle;
    this.frontWheel.rotation.x = p.wheelAngle;
    this.frontPivot.quaternion.copy(this.frontPivotBase).multiply(this._q.setFromAxisAngle(UPV, -p.bar));
    this.framePivot.quaternion.copy(this.framePivotBase).multiply(this._q.setFromAxisAngle(UPV, p.whip));
    this.framePivot.updateMatrix(); this.frameInner.updateMatrix();
    this.frontPivot.updateMatrix(); this.frontInner.updateMatrix();

    const c = clamp(p.crouch - 0.35 * p.table, -0.35, 1.05);
    const hip = this._hip.set(0, 0.97 - 0.32 * c, -0.2 - 0.02 * c);
    // tuck: hips up toward the bars; superman: body stretched out back, flat over the bike
    hip.lerp(this._t.set(0, 1.0, -0.08), p.tuck * 0.7);
    hip.lerp(this._t.set(0, 1.12, -0.5), p.superman);
    hip.x += p.lean * 0.12 + p.shiftX;
    hip.z += p.shiftZ;
    hip.y += 0.07 * p.table;
    const sh = this._sh.copy(hip).add(this._t.set(p.shiftX * 0.7, 0.45 - 0.1 * c, 0.27 + 0.1 * c + p.shiftZ * 0.8 - 0.1 * p.table));
    sh.lerp(this._a.copy(hip).add(this._t.set(0, 0.16, 0.5)), p.superman);
    sh.lerp(this._a.copy(hip).add(this._t.set(0, 0.5, 0.06)), p.tuck);
    const L = this.limbs;

    for (let side = 0; side < 2; side++) {
      const s = side === 0 ? 1 : -1;
      // ---- legs: pedals → (whip) floating → (superman) kicked back → (can-can) swung across
      const foot = this._a.set(0.14 * s, 0.335, side === 0 ? 0.115 : -0.235)
        .applyMatrix4(this.frameInner.matrix).applyMatrix4(this.framePivot.matrix);
      foot.lerp(this._t.set(0.24 * s, hip.y - 0.62, hip.z + 0.22), p.feetOff);
      foot.lerp(this._t.set(0.13 * s, hip.y - 0.05, hip.z - 0.78), p.superman);
      if (side === 1) foot.lerp(this._t.set(0.55, 0.78, 0.22), p.cancan);
      this.feet[side].position.copy(foot).add(this._t.set(0, 0.01, 0.03));
      const hipS = this._b.copy(hip).add(this._t.set(0.1 * s, 0, 0));
      const kneePole = this._t.set(0.15 * s, 0.1 + p.superman * 0.8, 1 - p.superman * 1.6);
      solveIK(hipS, foot, 0.47, 0.46, kneePole, this._k);
      placeSeg(L[side === 0 ? 'thighL' : 'thighR'], hipS, this._k, 0.078);
      this.joints[side === 0 ? 'kneeL' : 'kneeR'].position.copy(this._k);
      this.joints[side === 0 ? 'kneeL' : 'kneeR'].scale.setScalar(0.06 * this.jointScale);
      placeSeg(L[side === 0 ? 'shinL' : 'shinR'], this._k, foot, 0.056);
      // ---- arms: grips → (barspin) let go → (tuck no-hander) thrown up and out
      const grip = this._a.set(0.34 * s, 1.05, 0.27)
        .applyMatrix4(this.frontInner.matrix).applyMatrix4(this.frontPivot.matrix);
      grip.lerp(this._t.set(0.32 * s, sh.y - 0.2, sh.z + 0.22), p.handsOff);
      grip.lerp(this._t.set(0.5 * s, sh.y + 0.32, sh.z - 0.05), p.tuck);
      this.hands[side].position.copy(grip);
      const shS = this._b.copy(sh).add(this._t.set(0.17 * s, -0.03, 0));
      solveIK(shS, grip, 0.3, 0.3, this._t.set(0.55 * s, -0.6, -0.55), this._k);
      placeSeg(L[side === 0 ? 'upperL' : 'upperR'], shS, this._k, 0.05);
      this.joints[side === 0 ? 'elbowL' : 'elbowR'].position.copy(this._k);
      this.joints[side === 0 ? 'elbowL' : 'elbowR'].scale.setScalar(0.043 * this.jointScale);
      this.joints[side === 0 ? 'shL' : 'shR'].position.copy(shS);
      this.joints[side === 0 ? 'shL' : 'shR'].scale.setScalar(0.06);
      placeSeg(L[side === 0 ? 'foreL' : 'foreR'], this._k, grip, 0.038);
    }
    // torso
    const td = this._a.copy(sh).sub(hip);
    const tl = td.length();
    this.torso.position.copy(hip).addScaledVector(td, 0.5);
    this.torso.quaternion.setFromUnitVectors(UPV, td.divideScalar(tl)).multiply(this._q.setFromAxisAngle(UPV, p.twist));
    this.torso.scale.set(0.4, tl + 0.12, this.jointScale < 1 ? 0.24 : 0.2);
    this.pelvis.position.copy(hip);
    this.pelvis.quaternion.copy(this.torso.quaternion);
    this.pelvis.scale.set(0.3, 0.16, 0.2);
    const neckTop = this._b.copy(sh).addScaledVector(td, 0.12).add(this._t.set(0, 0.02, 0.04));
    placeSeg(L.neck, sh, neckTop, 0.05);
    this.head.position.copy(neckTop).add(this._t.set(0, 0.11, 0.03));
    this.head.rotation.x = 0.25 + 0.25 * c + p.superman * 0.6 - p.shiftZ * 1.2;
    this.head.rotation.z = -p.shiftX * 1.6;
    this.head.rotation.y = p.twist + p.headYaw;
  }

  /** Copy the controller's interpolated state onto the rig. */
  sync(r: RiderController, alpha: number) {
    this.apply(snapshot(r, alpha, this.snap));
  }
  private snap = makeSnapshot();

  /** Pose the rig from a snapshot (live play or replay). */
  apply(sn: RigSnapshot) {
    if (sn.bailed) {
      if (!this.detached) this.detach();
      this.bikeBody.position.copy(sn.bikePos);
      this.bikeBody.quaternion.copy(sn.bikeQuat);
      this.riderBody.position.copy(sn.riderPos);
      this.riderBody.quaternion.copy(sn.riderQuat);
      return;
    }
    if (this.detached) this.reattach();
    this.root.position.copy(sn.pos);
    this.root.quaternion.copy(sn.quat);
    this.pose(sn.pose);
  }

  private detach() {
    const parent = this.root.parent;
    if (!parent) return;
    parent.attach(this.bikeBody);
    parent.attach(this.riderBody);
    this.detached = true;
  }

  private reattach() {
    this.root.add(this.bikeBody, this.riderBody);
    this.bikeBody.position.set(0, 0.45, 0);
    this.bikeBody.quaternion.identity();
    this.riderBody.position.set(0, 1.0, 0);
    this.riderBody.quaternion.identity();
    this.detached = false;
  }
}

const _d = new Vector3();
function placeSeg(m: Object3D, a: Vector3, b: Vector3, r: number) {
  _d.copy(b).sub(a);
  const len = _d.length() || 1e-4;
  m.position.copy(a).addScaledVector(_d, 0.5);
  m.scale.set(r, len, r);
  m.quaternion.setFromUnitVectors(UPV, _d.divideScalar(len));
}

const _dir = new Vector3(), _pole = new Vector3();
/** Two-bone IK: writes the middle joint (knee/elbow) into `out`, bending toward `pole`. */
function solveIK(root: Vector3, target: Vector3, l1: number, l2: number, pole: Vector3, out: Vector3) {
  _dir.copy(target).sub(root);
  const d = clamp(_dir.length(), 1e-4, l1 + l2 - 1e-4);
  _dir.normalize();
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _pole.copy(pole).addScaledVector(_dir, -pole.dot(_dir)).normalize();
  return out.copy(root).addScaledVector(_dir, a).addScaledVector(_pole, h);
}
