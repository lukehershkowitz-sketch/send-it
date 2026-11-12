import { TUNING } from '../../tuning';
import { ACTIONS, type Action, type InputState, emptyInput } from './actions';
import { type Bindings, loadBindings } from './bindings';

const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'F3']);

/** Merges keyboard + gamepad into action values (0..1) once per frame. */
export class Input {
  bindings: Bindings = loadBindings();
  readonly values = {} as Record<Action, number>;
  private prev = {} as Record<Action, number>;
  private keys = new Set<string>();
  private tapped = new Set<string>(); // pressed since last poll (catches sub-frame taps)
  readonly state: InputState = emptyInput();
  /** Free-look deltas this frame (radians-ish), plus whether free-look is held. */
  look = { dx: 0, dy: 0, active: false };
  padConnected = false;
  private mouseDown = false;
  private mdx = 0;
  private mdy = 0;

  constructor(canvas: HTMLElement) {
    for (const a of ACTIONS) { this.values[a] = 0; this.prev[a] = 0; }
    window.addEventListener('keydown', (e) => {
      if (PREVENT.has(e.code)) e.preventDefault();
      this.keys.add(e.code);
      this.tapped.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => { if (e.button === 2) this.mouseDown = true; });
    window.addEventListener('mouseup', (e) => { if (e.button === 2) this.mouseDown = false; });
    window.addEventListener('mousemove', (e) => {
      if (this.mouseDown) { this.mdx += e.movementX; this.mdy += e.movementY; }
    });
  }

  poll(realDt: number): void {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected) ?? null;
    this.padConnected = !!pad;
    const { stickDeadzone, triggerDeadzone } = TUNING.input;

    for (const a of ACTIONS) {
      this.prev[a] = this.values[a];
      let v = 0;
      for (const code of this.bindings.keys[a]) if (this.keys.has(code) || this.tapped.has(code)) v = 1;
      if (pad) {
        for (const b of this.bindings.pad[a]) {
          let pv = 0;
          if ('button' in b) {
            const btn = pad.buttons[b.button];
            // Analog triggers report a 0..1 value; digital buttons report 0/1.
            if (btn) pv = btn.value > triggerDeadzone ? btn.value : btn.pressed ? 1 : 0;
          } else {
            const raw = (pad.axes[b.axis] ?? 0) * b.dir;
            pv = raw > stickDeadzone ? (raw - stickDeadzone) / (1 - stickDeadzone) : 0;
          }
          v = Math.max(v, pv);
        }
      }
      this.values[a] = v;
    }

    this.tapped.clear();
    const s = this.state, val = this.values;
    s.steer = val.steerRight - val.steerLeft;
    s.pedal = val.pedal;
    s.brake = val.brake;
    s.pop = val.pop > 0.5;
    s.barspin = val.barspinRight - val.barspinLeft;
    s.tailwhip = val.tailwhip > 0.5;
    s.flair = val.flair > 0.5;
    s.tuck = val.tuck > 0.5;
    s.superman = val.superman > 0.5;
    s.cancan = val.cancan > 0.5;
    s.manual = val.manual > 0.5;

    // Free look: right mouse drag, or hold R3 + right stick.
    const sens = TUNING.camera.freeLookSensitivity;
    this.look.dx = this.mdx * sens;
    this.look.dy = this.mdy * sens;
    this.mdx = this.mdy = 0;
    const stickLook = val.freeLook > 0.5 && pad;
    if (stickLook) {
      const k = TUNING.camera.freeLookStickSpeed * realDt;
      const dz = (x: number) => (Math.abs(x) > stickDeadzone ? x : 0);
      this.look.dx += dz(pad.axes[2] ?? 0) * k;
      this.look.dy += dz(pad.axes[3] ?? 0) * k;
    }
    this.look.active = this.mouseDown || !!stickLook;
    if (stickLook) { s.barspin = 0; s.tailwhip = false; } // right stick is the camera while R3 held
  }

  /** Treat everything currently held as already-seen (after closing a menu). */
  flush(): void {
    this.tapped.clear();
    for (const a of ACTIONS) this.prev[a] = this.values[a] = this.held(a) ? 1 : 0;
  }

  justPressed(a: Action): boolean { return this.values[a] > 0.5 && this.prev[a] <= 0.5; }
  held(a: Action): boolean { return this.values[a] > 0.5; }
}
