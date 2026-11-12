import { ACTIONS, type Action } from './actions';

/** Gamepad binding (standard mapping). axis bindings read one direction of an axis. */
export type PadBinding = { button: number } | { axis: number; dir: 1 | -1 };

export interface Bindings {
  keys: Record<Action, string[]>; // KeyboardEvent.code values
  pad: Record<Action, PadBinding[]>;
}

// Standard gamepad: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 8 View, 9 Menu, 10 L3, 11 R3, 12-15 dpad
export const DEFAULT_BINDINGS: Bindings = {
  keys: {
    steerLeft: ['KeyA'], steerRight: ['KeyD'],
    pedal: ['KeyW'], brake: ['KeyS'], pop: ['Space'],
    barspinLeft: ['ArrowLeft'], barspinRight: ['ArrowRight'],
    tailwhip: ['ArrowDown'], flair: ['ArrowUp'],
    tuck: ['ShiftLeft', 'ShiftRight'], superman: ['KeyQ'], cancan: ['KeyE'], manual: ['KeyB'],
    freeLook: [], restart: ['KeyR'], pause: ['Escape', 'KeyP'],
    debug: ['Backquote', 'F3'], help: ['KeyH'], camera: ['KeyC'], endRun: ['Enter'],
  },
  pad: {
    steerLeft: [{ axis: 0, dir: -1 }], steerRight: [{ axis: 0, dir: 1 }],
    pedal: [{ button: 7 }], brake: [{ button: 6 }], pop: [{ button: 0 }],
    barspinLeft: [{ axis: 2, dir: -1 }], barspinRight: [{ axis: 2, dir: 1 }],
    tailwhip: [{ axis: 3, dir: 1 }], flair: [{ button: 1 }],
    tuck: [{ button: 4 }], superman: [{ button: 2 }], cancan: [{ button: 3 }], manual: [{ button: 10 }],
    freeLook: [{ button: 11 }], restart: [{ button: 8 }], pause: [{ button: 9 }],
    debug: [], help: [], camera: [{ button: 12 }], endRun: [{ button: 13 }],
  },
};

const STORAGE_KEY = 'sendit.bindings.v1';

export function loadBindings(): Bindings {
  const b: Bindings = structuredClone(DEFAULT_BINDINGS);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Bindings>;
      for (const a of ACTIONS) {
        if (Array.isArray(saved.keys?.[a])) b.keys[a] = saved.keys[a];
        if (Array.isArray(saved.pad?.[a])) b.pad[a] = saved.pad[a];
      }
    }
  } catch { /* storage blocked or corrupt → defaults */ }
  return b;
}

export function saveBindings(b: Bindings): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(b)); } catch { /* ignore */ }
}
