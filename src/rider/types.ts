import type { Quaternion, Vector3 } from 'three';
import type { InputState } from '../core/input/actions';
import type { RiderController } from './RiderController';

export type StateName = 'GROUNDED' | 'AIRBORNE' | 'GRINDING' | 'MANUALING' | 'BAILED';

export interface RiderState {
  readonly name: StateName;
  enter(r: RiderController): void;
  update(r: RiderController, dt: number, input: InputState): void;
  exit?(r: RiderController): void;
}

export type PopLabel = 'PERFECT' | 'EARLY' | 'LATE' | 'HOP';
export interface PopInfo { label: PopLabel; factor: number; strength: number }

export interface LandingCheck {
  yawErr: number;      // degrees from nearest of forward/fakie
  pitchErr: number;    // degrees between wheels and surface
  fakie: boolean;
  inverted: boolean;
  holding: boolean;    // trick inputs still pressed
  impact: number;      // m/s into the surface
  yawTol: number;
  pitchTol: number;
  ok: boolean;
  stomped: boolean;
  reason: string;      // bail reason if !ok
}

export interface LandingResult extends LandingCheck {
  trick: string;
  airTime: number;
  spinDeg: number;
  flipDeg: number;
}

export interface DebrisBody {
  pos: Vector3;
  vel: Vector3;
  quat: Quaternion;
  angVel: Vector3;
  radius: number;
}

export interface RiderEvents {
  pop: PopInfo;
  takeoff: { popped: boolean };
  landed: LandingResult;
  bail: { reason: string; landing: LandingResult | null };
  respawn: Record<string, never>;
}
