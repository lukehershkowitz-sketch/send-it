import { Quaternion, Vector3 } from 'three';
import { TUNING } from '../../tuning';
import type { InputState } from '../../core/input/actions';
import { DEG } from '../../core/math';
import type { RiderController } from '../RiderController';
import type { RiderState } from '../types';
import { rideStep } from './Grounded';
import { updateBalance } from './Grinding';

const AX = new Vector3(1, 0, 0);
const _q = new Quaternion(), _pivot = new Vector3(), _a = new Vector3(), _b = new Vector3();

/** Manual (rear wheel) / nose manual (front wheel). W/S balance, release B to drop back down. */
export const Manualing = {
  name: 'MANUALING' as const,

  enter(r: RiderController) {
    r.manualTime = 0;
    r.balance = r.manualNose ? 0.05 : -0.05;
    r.balanceVel = 0;
    r.balanceDrift = 0;
    r.manualBrakeLatched = r.input.brake > 0.2;
    r.events.emit('manualStart', { nose: r.manualNose });
  },

  exit(r: RiderController) {
    r.events.emit('manualEnd', { nose: r.manualNose, time: r.manualTime });
  },

  update(r: RiderController, dt: number, input: InputState) {
    const M = TUNING.manual;
    r.manualTime += dt;
    if (r.manualBrakeLatched && input.brake < 0.1) r.manualBrakeLatched = false;
    const brake = r.manualBrakeLatched ? 0 : input.brake;
    // regular: + = too far back (looping out) → W pushes it forward. Nose: + = too far forward → S pulls back.
    const push = r.manualNose ? input.pedal - brake : brake - input.pedal;
    if (!updateBalance(r, dt, push, r.manualTime, M)) {
      r.bail(r.manualNose ? (r.balance > 0 ? 'Endo — went over the bars' : 'Dropped the nose manual')
        : r.balance > 0 ? 'Looped out' : 'Dropped the front wheel');
      return;
    }
    if (!input.manual) {
      r.setState('GROUNDED');
      return;
    }
    if (!rideStep(r, dt, input, { pedal: false, brake: false, steerScale: M.steerScale, extraDrag: M.friction })) return;
    if (r.state !== 'MANUALING') return;

    // visual: pivot the bike around the wheel that's down
    const angle = ((r.manualNose ? -M.nosePitch : M.pitch) + r.balance * M.pitchPerBalance * (r.manualNose ? -1 : 1)) * DEG;
    const zSign = r.manualNose ? 1 : -1;
    _pivot.set(0, 0, 0.49 * zSign);
    _a.copy(_pivot).applyQuaternion(r.quat);
    r.quat.multiply(_q.setFromAxisAngle(AX, -angle));
    _b.copy(_pivot).applyQuaternion(r.quat);
    r.visOffset.copy(_a).sub(_b);
  },
} satisfies RiderState;
