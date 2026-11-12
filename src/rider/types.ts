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
  whipErr: number;     // degrees the frame is away from straight
  barErr: number;      // degrees the bars are away from centre
  variation: number;   // 0..1 how far into a grab pose the rider still is
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

export type Variation = 'tuck' | 'superman' | 'cancan';
export const VARIATIONS: Variation[] = ['tuck', 'superman', 'cancan'];

/** Everything that happened in one air, for naming + scoring. */
export interface AirData {
  airTime: number;
  spinDeg: number;          // signed (+ = left / counter-clockwise from above)
  flipDeg: number;          // signed (+ = backflip)
  chain: ('WHIP' | 'BAR')[]; // completed whips/barspins in order
  barDir: number;           // +1 right, -1 left (last barspin direction)
  variations: Partial<Record<Variation, number>>; // longest hold (s) per variation
  takeoffFakie: boolean;
  fromGrind: boolean;
}

export interface LandingResult extends LandingCheck {
  trick: string;
  air: AirData;
  intoManual: boolean;
}

export type GrindType = 'DOUBLE PEG' | 'FEEBLE' | 'SMITH' | 'ICEPICK';

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
  grindStart: { type: GrindType };
  grindEnd: { type: GrindType; time: number };
  manualStart: { nose: boolean };
  manualEnd: { nose: boolean; time: number };
}
