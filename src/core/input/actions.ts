export const ACTIONS = [
  'steerLeft', 'steerRight', 'pedal', 'brake', 'pop',
  'barspinLeft', 'barspinRight', 'tailwhip', 'flair',
  'tuck', 'superman', 'cancan', 'manual',
  'freeLook', 'restart', 'pause', 'debug', 'help', 'camera', 'endRun',
] as const;
export type Action = (typeof ACTIONS)[number];

/** What the simulation sees each step. Axes are -1..1 / 0..1, buttons are booleans. */
export interface InputState {
  steer: number;   // -1 left .. +1 right (ground steer / air spin)
  pedal: number;   // 0..1 (ground pedal / air frontflip)
  brake: number;   // 0..1 (ground brake / air backflip)
  pop: boolean;
  barspin: number; // -1 left .. +1 right
  tailwhip: boolean;
  flair: boolean;
  tuck: boolean;
  superman: boolean;
  cancan: boolean;
  manual: boolean;
}

export const emptyInput = (): InputState => ({
  steer: 0, pedal: 0, brake: 0, pop: false, barspin: 0,
  tailwhip: false, flair: false, tuck: false, superman: false, cancan: false, manual: false,
});
