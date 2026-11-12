import { PerspectiveCamera, Vector3 } from 'three';
import { TUNING } from '../tuning';
import { clamp, damp, dampFactor, dirFromYaw, lerp, wrapAngle } from '../core/math';
import type { World } from '../world/World';

export interface CamTarget {
  pos: Vector3;      // rider contact point (interpolated)
  speed: number;     // m/s
  motionYaw: number; // direction of travel
  airborne: boolean;
  bailed: boolean;
}

const _desired = new Vector3(), _look = new Vector3(), _fwd = new Vector3();

/** Lagging chase cam: swings lazily on turns, pulls back with speed, widens in the air. */
export class ChaseCam {
  private yaw = 0;
  private airBlend = 0;
  private speedBlend = 0;
  private freeYaw = 0;
  private freePitch = 0;
  private bigAir = 0;
  private shake = 0;
  private shakeV = 0;
  private fovKick = 0;
  private fovKickV = 0;
  private pos = new Vector3();
  private look = new Vector3();
  private initialized = false;

  constructor(readonly camera: PerspectiveCamera, public world: World) {}

  /** A hard landing: dip the camera and punch the FOV, then let it settle (springs, never a snap). */
  kick(impact: number) {
    const C = TUNING.camera;
    this.shakeV -= Math.min(C.landKickMax, impact * C.landKick) * 18;
    this.fovKickV += Math.min(5, impact * C.landKickFov) * 14;
  }

  snap(t: CamTarget) {
    this.yaw = t.motionYaw;
    this.initialized = false;
    this.update(1, t, { dx: 0, dy: 0, active: false });
  }

  update(dt: number, t: CamTarget, look: { dx: number; dy: number; active: boolean }) {
    const C = TUNING.camera;
    if (!t.bailed) this.yaw += wrapAngle(t.motionYaw - this.yaw) * dampFactor(C.yawLagRate * (t.airborne ? 0.4 : 1), dt);
    this.airBlend = damp(this.airBlend, t.airborne ? 1 : 0, t.airborne ? 2.5 : 4, dt);
    // big jumps widen the framing, in proportion to how high above the ground we actually are
    const gnd = this.world.groundBelow(t.pos);
    const above = gnd ? Math.max(0, t.pos.y - gnd.point.y) : 0;
    this.bigAir = damp(this.bigAir, t.airborne ? Math.min(1, above / C.bigAirHeight) : 0, t.airborne ? 2.2 : 3, dt);
    // landing punch springs
    this.shakeV += (-C.landStiffness * this.shake - C.landDamping * this.shakeV) * dt;
    this.shake += this.shakeV * dt;
    this.fovKickV += (-C.landStiffness * this.fovKick - C.landDamping * this.fovKickV) * dt;
    this.fovKick += this.fovKickV * dt;
    this.speedBlend = damp(this.speedBlend, clamp(t.speed / 16, 0, 1), 2, dt);

    if (look.active) {
      this.freeYaw = wrapAngle(this.freeYaw - look.dx);
      this.freePitch = clamp(this.freePitch + look.dy, -0.6, 0.9);
    } else {
      this.freeYaw = damp(this.freeYaw, 0, C.freeLookReturnRate, dt);
      this.freePitch = damp(this.freePitch, 0, C.freeLookReturnRate, dt);
    }

    const dist = lerp(C.distMin, C.distMax, this.speedBlend) + C.airPullBack * this.airBlend + C.bigAirPull * this.bigAir;
    const height = lerp(C.heightMin, C.heightMax, this.speedBlend) + C.airRaise * this.airBlend + C.bigAirRaise * this.bigAir;
    const elev = Math.atan2(height, dist) + this.freePitch;
    const r = Math.hypot(height, dist);
    const yaw = this.yaw + this.freeYaw;
    dirFromYaw(yaw, _fwd);
    _desired.set(
      t.pos.x - _fwd.x * Math.cos(elev) * r,
      t.pos.y + Math.sin(elev) * r,
      t.pos.z - _fwd.z * Math.cos(elev) * r,
    );
    _look.copy(t.pos).addScaledVector(_fwd, C.lookAhead * (1 - this.airBlend * 0.5) + C.airLookAhead * this.airBlend * Math.min(1, t.speed / 12));
    _look.y += C.lookHeight;

    if (!this.initialized) {
      this.pos.copy(_desired);
      this.look.copy(_look);
      this.initialized = true;
    } else {
      const kh = dampFactor(C.posLagRate, dt), kv = dampFactor(C.verticalLagRate, dt);
      this.pos.x += (_desired.x - this.pos.x) * kh;
      this.pos.z += (_desired.z - this.pos.z) * kh;
      this.pos.y += (_desired.y - this.pos.y) * kv;
      this.look.lerp(_look, dampFactor(14, dt));
    }

    // keep the camera above the ground
    const g = this.world.groundBelow(this.pos);
    if (g && this.pos.y < g.point.y + 0.5) this.pos.y = g.point.y + 0.5;

    this.camera.position.copy(this.pos);
    this.camera.position.y += this.shake;
    this.camera.lookAt(this.look);
    const fov = C.baseFov + C.speedFovBoost * this.speedBlend + C.airFovBoost * this.airBlend + C.bigAirFov * this.bigAir + this.fovKick;
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
