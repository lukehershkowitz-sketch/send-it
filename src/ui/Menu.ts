import { ACTIONS, type Action } from '../core/input/actions';
import { DEFAULT_BINDINGS, type Bindings, type PadBinding } from '../core/input/bindings';
import type { Settings } from '../core/settings';
import type { Lighting } from '../world/decor';
import { PARKS } from '../world/parks';

export type Screen = 'main' | 'parks' | 'settings' | 'controls' | 'pause';

export interface MenuHandlers {
  ride(parkId: string, lighting: Lighting): void;
  resume(): void;
  restart(): void;
  mainMenu(): void;
  settingsChanged(s: Settings): void;
  bindingsChanged(b: Bindings): void;
  sound(): void;
}

const LABELS: Record<Action, string> = {
  steerLeft: 'Steer / spin left', steerRight: 'Steer / spin right', pedal: 'Pedal · frontflip', brake: 'Brake · backflip',
  pop: 'Load & pop', barspinLeft: 'Barspin left', barspinRight: 'Barspin right', tailwhip: 'Tailwhip', flair: 'Flair',
  tuck: 'Tuck no-hander', superman: 'Superman', cancan: 'Can-can', manual: 'Manual (+brake = nose)',
  freeLook: 'Free look (hold)', restart: 'New run (hold)', pause: 'Pause', debug: 'Debug overlay', help: 'Controls help',
  camera: 'Camera mode', endRun: 'End run',
};
const PAD_BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'L3', 'R3', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →'];
const PAD_AXES = [['LS ←', 'LS →'], ['LS ↑', 'LS ↓'], ['RS ←', 'RS →'], ['RS ↑', 'RS ↓']];

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: 'Space', ShiftLeft: 'L Shift', ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt', Backquote: '`', Escape: 'Esc', Enter: 'Enter',
  };
  return map[code] ?? code;
}
export function padLabel(b: PadBinding): string {
  return 'button' in b ? PAD_BUTTONS[b.button] ?? `B${b.button}` : PAD_AXES[b.axis]?.[b.dir > 0 ? 1 : 0] ?? `Axis ${b.axis}`;
}

/** DOM menus with mouse, keyboard (arrows / Enter / Esc) and gamepad (d-pad or stick / A / B) navigation. */
export class Menu {
  open = false;
  screen: Screen = 'main';
  private stack: Screen[] = [];
  private focus = 0;
  private lighting: Lighting;
  private listening: { action: Action; kind: 'key' | 'pad'; armed: boolean } | null = null;
  private prevPad: boolean[] = [];
  private prevAxisY = 0;
  private prevAxisX = 0;

  constructor(private root: HTMLElement, private settings: Settings, private bindings: Bindings, private h: MenuHandlers) {
    this.lighting = settings.lighting;
    root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (el) this.act(el);
    });
    root.addEventListener('input', (e) => this.onInput(e.target as HTMLInputElement));
    window.addEventListener('keydown', (e) => this.onKey(e), true);
  }

  show(screen: Screen, push = false) {
    if (push && this.open) this.stack.push(this.screen);
    if (!push) this.stack = [];
    this.screen = screen;
    this.open = true;
    this.focus = 0;
    this.render();
    this.root.classList.remove('hidden');
  }

  hide() {
    this.open = false;
    this.listening = null;
    this.root.classList.add('hidden');
  }

  back() {
    if (this.listening) { this.listening = null; this.render(); return; }
    const prev = this.stack.pop();
    if (prev) { this.screen = prev; this.focus = 0; this.render(); return; }
    if (this.screen === 'pause') this.h.resume();
  }

  // ------------------------------------------------------------------ rendering
  private render() {
    const s = this.settings;
    const btn = (act: string, label: string, extra = '') => `<button data-nav data-act="${act}" ${extra}>${label}</button>`;
    let html = '';
    switch (this.screen) {
      case 'main':
        html = `<div class="title">SEND IT<small>arcade BMX</small></div>
          ${btn('parks', 'Ride')}${btn('settings', 'Settings')}${btn('controls', 'Controls')}`;
        break;
      case 'parks':
        html = `<h2>Choose a park</h2>
          ${PARKS.map((p) => `<button data-nav data-act="ride" data-park="${p.id}" class="park"><b>${p.name}</b><span>${p.blurb}</span><em>${bestLabel(p.def.name)}</em></button>`).join('')}
          <button data-nav data-act="lighting" class="toggle">Lighting: <b>${this.lighting === 'day' ? 'Day' : 'Night'}</b> <span class="hint">← →</span></button>
          ${btn('back', 'Back')}`;
        break;
      case 'pause':
        html = `<h2>Paused</h2>${btn('resume', 'Resume')}${btn('restart', 'Restart run')}${btn('settings', 'Settings')}${btn('controls', 'Controls')}${btn('mainmenu', 'Main menu')}`;
        break;
      case 'settings':
        html = `<h2>Settings</h2>
          <label class="row" data-nav-wrap>Volume <input data-nav type="range" min="0" max="1" step="0.05" data-set="volume" value="${s.volume}"></label>
          <button data-nav data-act="toggle" data-set="muted" class="toggle">Sound: <b>${s.muted ? 'Off' : 'On'}</b></button>
          <label class="row">Landing assist <input data-nav type="range" min="0" max="1" step="0.1" data-set="landingAssist" value="${s.landingAssist}"></label>
          <label class="row">Render quality <input data-nav type="range" min="0.5" max="1" step="0.25" data-set="renderScale" value="${s.renderScale}"></label>
          <button data-nav data-act="toggle" data-set="showDebug" class="toggle">Debug overlay: <b>${s.showDebug ? 'On' : 'Off'}</b></button>
          ${btn('remap', 'Remap controls')}${btn('back', 'Back')}`;
        break;
      case 'controls':
        html = this.controlsHtml();
        break;
    }
    this.root.innerHTML = `<div class="menu-card ${this.screen}">${html}</div>`;
    this.applyFocus();
  }

  private controlsHtml(): string {
    const rows = ACTIONS.filter((a) => a !== 'camera').map((a) => {
      const keys = this.bindings.keys[a];
      const pads = this.bindings.pad[a];
      const lk = this.listening?.action === a && this.listening.kind === 'key';
      const lp = this.listening?.action === a && this.listening.kind === 'pad';
      return `<tr><td>${LABELS[a]}</td>
        <td><button data-nav data-act="bind" data-kind="key" data-action="${a}" class="${lk ? 'listening' : ''}">${lk ? 'Press a key…' : keys.map(keyLabel).join(' / ') || '—'}</button></td>
        <td><button data-nav data-act="bind" data-kind="pad" data-action="${a}" class="${lp ? 'listening' : ''}">${lp ? 'Press a button…' : pads.map(padLabel).join(' / ') || '—'}</button></td></tr>`;
    }).join('');
    return `<h2>Controls</h2>
      <p class="hint">Click a binding (or select it and press Enter / A), then press the new key or button. Esc cancels, Backspace clears.</p>
      <table class="binds"><tr><th>Action</th><th>Keyboard</th><th>Controller</th></tr>${rows}</table>
      <button data-nav data-act="resetbinds">Reset to defaults</button>${'<button data-nav data-act="back">Back</button>'}`;
  }

  private items(): HTMLElement[] {
    return Array.from(this.root.querySelectorAll<HTMLElement>('[data-nav]'));
  }

  private applyFocus() {
    const items = this.items();
    if (!items.length) return;
    this.focus = (this.focus + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle('focused', i === this.focus));
    items[this.focus].focus({ preventScroll: false });
    items[this.focus].scrollIntoView({ block: 'nearest' });
  }

  private move(d: number) {
    this.focus += d;
    this.applyFocus();
    this.h.sound();
  }

  private adjust(d: number) {
    const el = this.items()[this.focus];
    if (!el) return;
    if (el instanceof HTMLInputElement && el.type === 'range') {
      el.value = String(Math.min(Number(el.max), Math.max(Number(el.min), Number(el.value) + d * Number(el.step))));
      this.onInput(el);
    } else if (el.dataset.act === 'lighting' || el.dataset.act === 'toggle') this.act(el);
  }

  // ------------------------------------------------------------------ actions
  private act(el: HTMLElement) {
    const a = el.dataset.act!;
    this.h.sound();
    switch (a) {
      case 'parks': this.show('parks', true); break;
      case 'settings': this.show('settings', true); break;
      case 'controls': case 'remap': this.show('controls', true); break;
      case 'back': this.back(); break;
      case 'resume': this.h.resume(); break;
      case 'restart': this.h.restart(); break;
      case 'mainmenu': this.h.mainMenu(); break;
      case 'ride':
        this.settings.park = el.dataset.park!;
        this.settings.lighting = this.lighting;
        this.h.settingsChanged(this.settings);
        this.h.ride(el.dataset.park!, this.lighting);
        break;
      case 'lighting':
        this.lighting = this.lighting === 'day' ? 'night' : 'day';
        this.rerenderKeepFocus();
        break;
      case 'toggle': {
        const k = el.dataset.set as 'muted' | 'showDebug';
        this.settings[k] = !this.settings[k];
        this.h.settingsChanged(this.settings);
        this.rerenderKeepFocus();
        break;
      }
      case 'bind':
        this.listening = { action: el.dataset.action as Action, kind: el.dataset.kind as 'key' | 'pad', armed: false };
        this.rerenderKeepFocus();
        break;
      case 'resetbinds':
        this.bindings.keys = structuredClone(DEFAULT_BINDINGS.keys);
        this.bindings.pad = structuredClone(DEFAULT_BINDINGS.pad);
        this.h.bindingsChanged(this.bindings);
        this.rerenderKeepFocus();
        break;
    }
  }

  private rerenderKeepFocus() {
    const f = this.focus;
    this.render();
    this.focus = f;
    this.applyFocus();
  }

  private onInput(el: HTMLInputElement) {
    const k = el.dataset.set as 'volume' | 'landingAssist' | 'renderScale' | undefined;
    if (!k) return;
    this.settings[k] = Number(el.value);
    this.h.settingsChanged(this.settings);
  }

  private onKey(e: KeyboardEvent) {
    if (!this.open) return;
    if (this.listening?.kind === 'key') {
      e.preventDefault(); e.stopImmediatePropagation();
      const a = this.listening.action;
      if (e.code === 'Escape') { this.listening = null; this.rerenderKeepFocus(); return; }
      this.bindings.keys[a] = e.code === 'Backspace' ? [] : [e.code];
      this.listening = null;
      this.h.bindingsChanged(this.bindings);
      this.rerenderKeepFocus();
      return;
    }
    if (this.listening?.kind === 'pad' && (e.code === 'Escape' || e.code === 'Backspace')) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.code === 'Backspace') { this.bindings.pad[this.listening.action] = []; this.h.bindingsChanged(this.bindings); }
      this.listening = null;
      this.rerenderKeepFocus();
      return;
    }
    const nav: Record<string, () => void> = {
      ArrowDown: () => this.move(1), ArrowUp: () => this.move(-1),
      ArrowLeft: () => this.adjust(-1), ArrowRight: () => this.adjust(1),
      Escape: () => this.back(), Backspace: () => this.back(),
    };
    const isRange = (document.activeElement as HTMLInputElement | null)?.type === 'range';
    if (nav[e.code] && !(isRange && (e.code === 'ArrowLeft' || e.code === 'ArrowRight'))) {
      e.preventDefault(); e.stopImmediatePropagation();
      nav[e.code]();
    } else if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault(); e.stopImmediatePropagation();
      const el = this.items()[this.focus];
      if (el && !(el instanceof HTMLInputElement)) this.act(el);
    } else {
      e.stopImmediatePropagation(); // keep the game from seeing menu keys
    }
  }

  /** Gamepad navigation + pad rebinding. Call once per frame while open. */
  update() {
    if (!this.open) return;
    const pad = Array.from(navigator.getGamepads?.() ?? []).find((p) => p && p.connected);
    if (!pad) return;
    const pressed = pad.buttons.map((b) => b.pressed || b.value > 0.5);
    const edge = (i: number) => pressed[i] && !this.prevPad[i];

    if (this.listening?.kind === 'pad') {
      const L = this.listening;
      if (!L.armed) { if (!pressed.some(Boolean) && pad.axes.every((v) => Math.abs(v) < 0.3)) L.armed = true; }
      else {
        let found: PadBinding | null = null;
        const bi = pressed.findIndex(Boolean);
        if (bi >= 0) found = { button: bi };
        else {
          const ai = pad.axes.findIndex((v) => Math.abs(v) > 0.6);
          if (ai >= 0 && ai < 4) found = { axis: ai, dir: pad.axes[ai] > 0 ? 1 : -1 };
        }
        if (found) {
          this.bindings.pad[L.action] = [found];
          this.listening = null;
          this.h.bindingsChanged(this.bindings);
          this.rerenderKeepFocus();
        }
      }
      this.prevPad = pressed;
      return;
    }

    const y = pad.axes[1] ?? 0, x = pad.axes[0] ?? 0;
    if (edge(13) || (y > 0.6 && this.prevAxisY <= 0.6)) this.move(1);
    if (edge(12) || (y < -0.6 && this.prevAxisY >= -0.6)) this.move(-1);
    if (edge(15) || (x > 0.6 && this.prevAxisX <= 0.6)) this.adjust(1);
    if (edge(14) || (x < -0.6 && this.prevAxisX >= -0.6)) this.adjust(-1);
    if (edge(0)) { const el = this.items()[this.focus]; if (el && !(el instanceof HTMLInputElement)) this.act(el); }
    if (edge(1)) this.back();
    if (edge(9) && this.screen === 'pause') this.h.resume();
    this.prevAxisY = y; this.prevAxisX = x;
    this.prevPad = pressed;
  }

  /** Swallow the current pad state (so the button that opened a menu doesn't also click in it). */
  syncPad() {
    const pad = Array.from(navigator.getGamepads?.() ?? []).find((p) => p && p.connected);
    this.prevPad = pad ? pad.buttons.map((b) => b.pressed || b.value > 0.5) : [];
  }
}

function bestLabel(parkName: string): string {
  try {
    const pb = Number(localStorage.getItem(`sendit.pb.${parkName}`)) || 0;
    return pb ? `PB ${Math.round(pb).toLocaleString('en-US')}` : 'No runs yet';
  } catch { return ''; }
}
