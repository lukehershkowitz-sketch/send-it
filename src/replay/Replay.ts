import { PerspectiveCamera, Vector3 } from 'three';
import { clamp, damp } from '../core/math';
import { lerpSnapshot, makeSnapshot, type RigSnapshot } from '../rider/RiderRig';
import type { ChaseCam, CamTarget } from '../camera/ChaseCam';
import type { World } from '../world/World';

export const CAM_MODES = ['follow', 'orbit', 'fixed'] as const;
export type CamMode = (typeof CAM_MODES)[number];

/** A HUD moment to re-show during playback (landings, bails, banked lines). */
export interface ReplayEvent { t: number; title: string; sub: string; cls: string }

const HZ = 30;
const MAX_FRAMES = HZ * 240;

/** Records rig snapshots at 30 Hz for the current run. */
export class Recorder {
  frames: RigSnapshot[] = [];
  events: ReplayEvent[] = [];
  time = 0;
  private acc = 0;

  clear() { this.frames = []; this.events = []; this.time = 0; this.acc = 0; }

  /** Call every sim step with the current (alpha = 1) snapshot. */
  step(dt: number, snap: RigSnapshot) {
    this.time += dt;
    this.acc += dt;
    if (this.acc < 1 / HZ && this.frames.length) return;
    this.acc = 0;
    if (this.frames.length >= MAX_FRAMES) this.frames.shift();
    this.frames.push(cloneSnap(snap));
  }

  event(title: string, sub: string, cls: string) { this.events.push({ t: this.time, title, sub, cls }); }
  get duration() { return Math.max(0, this.frames.length - 1) / HZ; }
}

function cloneSnap(s: RigSnapshot): RigSnapshot {
  const o = makeSnapshot();
  o.pos.copy(s.pos); o.quat.copy(s.quat); o.bailed = s.bailed;
  o.bikePos.copy(s.bikePos); o.bikeQuat.copy(s.bikeQuat); o.riderPos.copy(s.riderPos); o.riderQuat.copy(s.riderQuat);
  Object.assign(o.pose, s.pose);
  o.speed = s.speed; o.motionYaw = s.motionYaw; o.airborne = s.airborne;
  return o;
}

/**
 * Plays a recording back: interpolates snapshots, drives one of three cameras, and
 * re-fires HUD events as playback passes them.
 */
export class ReplayPlayer {
  active = false;
  playing = true;
  time = 0;
  speed = 1;
  mode: CamMode = 'follow';
  private frames: RigSnapshot[] = [];
  private events: ReplayEvent[] = [];
  private startT = 0;
  private nextEvent = 0;
  private out = makeSnapshot();
  private orbitAngle = 0;
  private tripods: Vector3[] = [];
  private tripod = -1;
  private camPos = new Vector3();
  private look = new Vector3();
  private camTarget: CamTarget = { pos: new Vector3(), speed: 0, motionYaw: 0, airborne: false, bailed: false };

  constructor(private camera: PerspectiveCamera, private chase: ChaseCam) {}

  start(rec: Recorder, world: World) {
    this.frames = rec.frames.slice();
    this.events = rec.events.slice();
    this.startT = rec.time - rec.duration; // recorder time of frame 0
    this.time = 0;
    this.playing = true;
    this.speed = 1;
    this.active = this.frames.length > 1;
    this.nextEvent = 0;
    this.tripods = buildTripods(world);
    this.tripod = -1;
    this.chase.snap(this.target(this.sample()));
  }

  stop() { this.active = false; }
  get duration() { return Math.max(0, this.frames.length - 1) / HZ; }

  cycleCamera() {
    this.mode = CAM_MODES[(CAM_MODES.indexOf(this.mode) + 1) % CAM_MODES.length];
    this.tripod = -1;
    if (this.mode === 'follow') this.chase.snap(this.target(this.sample()));
  }

  seek(dt: number) {
    this.time = clamp(this.time + dt, 0, this.duration);
    this.nextEvent = this.events.findIndex((e) => e.t - this.startT >= this.time);
    if (this.nextEvent < 0) this.nextEvent = this.events.length;
  }

  /** Advance playback; returns the snapshot to draw and any HUD events to show. */
  update(realDt: number): { snap: RigSnapshot; fired: ReplayEvent[] } {
    const fired: ReplayEvent[] = [];
    if (this.playing) {
      this.time += realDt * this.speed;
      if (this.time >= this.duration) { this.time = 0; this.nextEvent = 0; } // loop
    }
    while (this.nextEvent < this.events.length && this.events[this.nextEvent].t - this.startT <= this.time) {
      fired.push(this.events[this.nextEvent++]);
    }
    const snap = this.sample();
    this.updateCamera(snap, realDt);
    return { snap, fired };
  }

  private sample(): RigSnapshot {
    const f = this.time * HZ;
    const i = Math.max(0, Math.min(this.frames.length - 2, Math.floor(f)));
    return lerpSnapshot(this.frames[i], this.frames[i + 1] ?? this.frames[i], f - i, this.out);
  }

  private target(s: RigSnapshot): CamTarget {
    const c = this.camTarget;
    c.pos.copy(s.bailed ? s.riderPos : s.pos);
    c.speed = s.speed; c.motionYaw = s.motionYaw; c.airborne = s.airborne; c.bailed = s.bailed;
    return c;
  }

  private updateCamera(s: RigSnapshot, dt: number) {
    const focus = s.bailed ? s.riderPos : s.pos;
    const cam = this.camera;
    if (this.mode === 'follow') {
      this.chase.update(this.playing ? dt * this.speed : 0, this.target(s), { dx: 0, dy: 0, active: false });
      return;
    }
    if (this.mode === 'orbit') {
      this.orbitAngle += dt * 0.35;
      this.camPos.set(focus.x + Math.sin(this.orbitAngle) * 7, focus.y + 2.6, focus.z + Math.cos(this.orbitAngle) * 7);
      cam.position.copy(this.camPos);
      this.look.set(focus.x, focus.y + 0.9, focus.z);
      cam.lookAt(this.look);
      setFov(cam, 55);
      return;
    }
    // fixed tripods: stay on one until the rider gets far away, then cut to the nearest
    if (this.tripod < 0 || this.tripods[this.tripod].distanceTo(focus) > 34) {
      let best = 0, bd = Infinity;
      this.tripods.forEach((p, i) => { const d = p.distanceTo(focus); if (d < bd) { bd = d; best = i; } });
      this.tripod = best;
    }
    cam.position.copy(this.tripods[this.tripod]);
    this.look.lerp(new Vector3(focus.x, focus.y + 0.9, focus.z), 1 - Math.exp(-8 * dt));
    if (this.look.distanceTo(focus) > 10) this.look.set(focus.x, focus.y + 0.9, focus.z);
    cam.lookAt(this.look);
    const d = cam.position.distanceTo(focus);
    setFov(cam, clamp(damp(cam.fov, (2 * Math.atan(5 / Math.max(d, 1)) * 180) / Math.PI, 3, dt), 18, 70));
  }
}

function setFov(cam: PerspectiveCamera, fov: number) {
  if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
}

/** Tripod spots: beside the riding path and around the park's edges, a few metres up. */
function buildTripods(world: World): Vector3[] {
  const pts: Vector3[] = [];
  const path = world.path;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    if (len < 4) continue;
    const nx = dz / len, nz = -dx / len, side = i % 2 ? 1 : -1;
    pts.push(new Vector3((a.x + b.x) / 2 + nx * 9 * side, 2.5, (a.z + b.z) / 2 + nz * 9 * side));
  }
  const bb = world.bounds;
  if (!bb.isEmpty()) {
    for (const x of [bb.min.x - 6, (bb.min.x + bb.max.x) / 2, bb.max.x + 6])
      for (const z of [bb.min.z - 6, (bb.min.z + bb.max.z) / 2, bb.max.z + 6]) pts.push(new Vector3(x, Math.max(3, bb.max.y + 2), z));
  }
  return pts.length ? pts : [new Vector3(10, 4, 10)];
}
