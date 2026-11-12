import type { Action } from '../core/input/actions';

const BUTTONS: { action: Action; label: string; cls: string }[] = [
  { action: 'pop', label: 'POP', cls: 'big pop' },
  { action: 'tailwhip', label: 'WHIP', cls: 'b1' },
  { action: 'flair', label: 'FLAIR', cls: 'b2' },
  { action: 'barspinLeft', label: '↺ BAR', cls: 'b3' },
  { action: 'barspinRight', label: 'BAR ↻', cls: 'b4' },
  { action: 'tuck', label: 'TUCK', cls: 'g1' },
  { action: 'superman', label: 'SUPER', cls: 'g2' },
  { action: 'cancan', label: 'CAN', cls: 'g3' },
  { action: 'manual', label: 'MANUAL', cls: 'b5' },
  { action: 'roll', label: 'ROLL', cls: 'g4' },
  { action: 'tabletop', label: 'TABLE', cls: 'g5' },
];

export const isTouchDevice = () =>
  new URLSearchParams(location.search).has('touch') || matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

/**
 * On-screen controls: a floating stick on the left (x = steer/spin, up = pedal/frontflip,
 * down = brake/backflip) and trick buttons on the right. Writes into `values`, which Input
 * merges with keyboard + gamepad.
 */
export class TouchControls {
  readonly values: Partial<Record<Action, number>> = {};
  readonly root: HTMLElement;
  private stickId: number | null = null;
  private origin = { x: 0, y: 0 };
  private base: HTMLElement;
  private knob: HTMLElement;
  private R = 56;

  constructor(parent: HTMLElement) {
    const root = (this.root = document.createElement('div'));
    root.id = 'touch';
    root.innerHTML = `
      <div class="stick-zone"><div class="stick-base"><div class="stick-knob"></div></div></div>
      <div class="buttons">${BUTTONS.map((b) => `<button class="tbtn ${b.cls}" data-action="${b.action}">${b.label}</button>`).join('')}</div>
      <button class="tbtn pause" data-action="pause">❚❚</button>`;
    parent.appendChild(root);
    this.base = root.querySelector('.stick-base')!;
    this.knob = root.querySelector('.stick-knob')!;
    const zone = root.querySelector<HTMLElement>('.stick-zone')!;

    zone.addEventListener('pointerdown', (e) => {
      if (this.stickId !== null) return;
      this.stickId = e.pointerId;
      zone.setPointerCapture(e.pointerId);
      this.origin = { x: e.clientX, y: e.clientY };
      this.base.style.left = `${e.clientX - this.R}px`;
      this.base.style.top = `${e.clientY - this.R}px`;
      this.base.classList.add('active');
      this.move(e.clientX, e.clientY);
      e.preventDefault();
    });
    zone.addEventListener('pointermove', (e) => { if (e.pointerId === this.stickId) this.move(e.clientX, e.clientY); });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.base.classList.remove('active');
      this.knob.style.transform = '';
      this.values.steerLeft = this.values.steerRight = this.values.pedal = this.values.brake = 0;
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);

    root.querySelectorAll<HTMLElement>('.tbtn').forEach((btn) => {
      const a = btn.dataset.action as Action;
      const down = (e: PointerEvent) => { btn.setPointerCapture(e.pointerId); this.values[a] = 1; btn.classList.add('down'); e.preventDefault(); };
      const up = () => { this.values[a] = 0; btn.classList.remove('down'); };
      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });
  }

  private move(x: number, y: number) {
    let dx = x - this.origin.x, dy = y - this.origin.y;
    const d = Math.hypot(dx, dy);
    if (d > this.R) { dx *= this.R / d; dy *= this.R / d; }
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const nx = dx / this.R, ny = dy / this.R;
    const dz = (v: number) => (Math.abs(v) < 0.18 ? 0 : (Math.abs(v) - 0.18) / 0.82);
    this.values.steerRight = nx > 0 ? dz(nx) : 0;
    this.values.steerLeft = nx < 0 ? dz(-nx) : 0;
    this.values.pedal = ny < 0 ? dz(-ny) : 0;
    this.values.brake = ny > 0 ? dz(ny) : 0;
  }

  setVisible(v: boolean) { this.root.classList.toggle('hidden', !v); }
}
