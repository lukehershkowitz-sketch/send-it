import { Quaternion, Vector3 } from 'three';
import { TUNING } from '../../tuning';
import type { RiderController } from '../RiderController';
import type { DebrisBody, RiderState } from '../types';

const _dq = new Quaternion(), _axis = new Vector3();

/** Ragdoll-lite: bike and rider become two tumbling bodies, then respawn. */
export const Bailed = {
  name: 'BAILED' as const,
  enter(r: RiderController) {
    r.speed = 0;
    r.compression = 0;
  },
  update(r: RiderController, dt: number) {
    integrate(r, r.debrisBike, dt);
    integrate(r, r.debrisRider, dt);
    r.pos.copy(r.debrisRider.pos).y -= 0.9;
    r.vel.copy(r.debrisRider.vel);
    if (r.stateTime > TUNING.bail.respawnDelay) r.respawn();
  },
} satisfies RiderState;

function integrate(r: RiderController, b: DebrisBody, dt: number) {
  const B = TUNING.bail;
  b.vel.y -= TUNING.physics.gravity * dt;
  b.pos.addScaledVector(b.vel, dt);
  const w = b.angVel.length();
  if (w > 1e-4) {
    _axis.copy(b.angVel).divideScalar(w);
    b.quat.premultiply(_dq.setFromAxisAngle(_axis, w * dt));
  }
  const g = r.world.groundBelow(b.pos);
  if (g && b.pos.y - b.radius < g.point.y) {
    b.pos.y = g.point.y + b.radius;
    const vn = b.vel.dot(g.normal);
    if (vn < 0) b.vel.addScaledVector(g.normal, -vn * (1 + B.bounce));
    const f = Math.pow(B.groundFriction, dt * 60 * 0.25);
    b.vel.x *= f; b.vel.z *= f;
    b.angVel.multiplyScalar(Math.pow(0.6, dt * 60 * 0.25));
  }
}
