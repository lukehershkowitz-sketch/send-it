import { ACTIONS, type Action } from '../core/input/actions';
import { DEFAULT_BINDINGS, type Bindings, type PadBinding } from '../core/input/bindings';
import { PALETTES, type RiderColors, type Settings } from '../core/settings';
import type { Lighting } from '../world/decor';
import { PARKS } from '../world/parks';

export type Screen = 'main' | 'parks' | 'settings' | 'controls' | 'pause' | 'rider' | 'multiplayer' | 'invite';

export interface MenuHandlers {
  ride(parkId: string, lighting: Lighting): void;
  resume(): void;
  restart(): void;
  mainMenu(): void;
  settingsChanged(s: Settings): void;
  bindingsChanged(b: Bindings): void;
  sound(): void;
  replay(): void;
  colorsChanged(): void;
  mpJoin(): void;
  mpLeave(): void;
  mpChallenge(target?: number): void;
  duelReply(accept: boolean): void;
}

/** What the multiplayer screen shows (supplied by the game). */
export interface MpView {
  status: string;
  error: string;
  room: string | null;
  players: { id: number; name: string; color: string; you: boolean; score?: number }[];
  duel: string | null;
  invite: string | null;
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
  /** Set by the game to fill the multiplayer screen. */
  mpView: () => MpView = () => ({ status: 'offline', error: '', room: null, players: [], duel: null, invite: null });

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

  /** Re-render the current screen (e.g. when the room roster changes), keeping focus. */
  refresh() {
    if (!this.open) return;
    const dyn = this.root.querySelector('#mp-dyn');
    if (this.screen === 'multiplayer' && dyn) {
      dyn.innerHTML = this.mpDynamicHtml();
      const items = this.items();
      this.focus = Math.min(this.focus, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('focused', i === this.focus));
      if ((document.activeElement as HTMLInputElement | null)?.type !== 'text') items[this.focus]?.focus();
      return;
    }
    this.rerenderKeepFocus();
  }

  private mpDynamicHtml(): string {
    const v = this.mpView();
    const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const btn = (act: string, label: string) => `<button data-nav data-act="${act}">${label}</button>`;
    const inRoom = !!v.room;
    return `<div class="mp-status ${v.error ? 'bad' : ''}">${esc(v.error || v.status)}${v.room ? ` · <b>${esc(v.room)}</b>` : ''}</div>
      ${inRoom ? `<div class="mp-players">${v.players.map((p) => `<div><i style="background:${esc(p.color)}"></i>${esc(p.name)}${p.you ? ' (you)' : ''}${p.score !== undefined ? ` · <b>${p.score.toLocaleString('en-US')}</b>` : ''}</div>`).join('')}</div>` : ''}
      ${v.duel ? `<div class="mp-status">${esc(v.duel)}</div>` : ''}
      ${inRoom ? btn('resume', 'Ride') + btn('challenge', '1v1: best line in 60 s') + btn('mpleave', 'Leave room') : btn('mpjoin', 'Join room')}`;
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
          ${btn('parks', 'Ride')}${btn('multiplayer', 'Multiplayer')}${btn('rider', 'Rider & bike')}${btn('settings', 'Settings')}${btn('controls', 'Controls')}`;
        break;
      case 'parks':
        html = `<h2>Choose a park</h2>
          ${PARKS.map((p) => `<button data-nav data-act="ride" data-park="${p.id}" class="park"><b>${p.name}</b><span>${p.blurb}</span><em>${bestLabel(p.def.name)}</em></button>`).join('')}
          <button data-nav data-act="lighting" class="toggle">Lighting: <b>${this.lighting === 'day' ? 'Day' : 'Night'}</b> <span class="hint">← →</span></button>
          ${btn('back', 'Back')}`;
        break;
      case 'pause':
        html = `<h2>Paused</h2>${btn('resume', 'Resume')}${btn('multiplayer', 'Multiplayer')}${btn('replay', 'Watch replay')}${btn('restart', 'Restart run')}${btn('rider', 'Rider & bike')}${btn('settings', 'Settings')}${btn('controls', 'Controls')}${btn('mainmenu', 'Main menu')}`;
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
      case 'multiplayer': {
        const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
        html = `<h2>Multiplayer</h2>
          <label class="row">Name <input data-nav data-mp="playerName" type="text" maxlength="16" placeholder="Rider" value="${esc(s.playerName)}"></label>
          <label class="row">Room code <input data-nav data-mp="mpCode" type="text" maxlength="12" placeholder="public" value="${esc(s.mpCode)}"></label>
          <label class="row">Server <input data-nav data-mp="mpServer" type="text" placeholder="this site" value="${esc(s.mpServer)}"></label>
          <p class="hint">Same park + same room code = same room. Leave the code blank for the public room.</p>
          <div id="mp-dyn">${this.mpDynamicHtml()}</div>
          ${btn('back', 'Back')}`;
        break;
      }
      case 'invite': {
        const v = this.mpView();
        html = `<h2>1v1 challenge</h2><p><b>${(v.invite ?? 'Someone').replace(/</g, '&lt;')}</b> challenges you: best single line in 60 seconds.</p>
          ${btn('accept', 'Accept')}${btn('decline', 'Decline')}`;
        break;
      }
      case 'rider': {
        const names: Record<keyof RiderColors, string> = { frame: 'Frame', jersey: 'Jersey', pants: 'Pants', helmet: 'Helmet' };
        html = `<h2>Rider &amp; bike</h2>
          ${(Object.keys(PALETTES) as (keyof RiderColors)[]).map((k) => `
            <div class="swatch-row" data-nav data-act="cycle" data-part="${k}" tabindex="0"><span>${names[k]}</span>
              <div class="swatches">${PALETTES[k].map((c) => `<button data-act="color" data-part="${k}" data-color="${c}" class="sw ${this.settings.colors[k] === c ? 'on' : ''}" style="background:${c}" aria-label="${c}"></button>`).join('')}</div>
            </div>`).join('')}
          <p class="hint">← → to change the selected part.</p>
          ${btn('back', 'Done')}`;
        break;
      }
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
    } else if (el.dataset.act === 'cycle') {
      const part = el.dataset.part as keyof RiderColors;
      const pal = PALETTES[part];
      const i = (pal.indexOf(this.settings.colors[part]) + d + pal.length) % pal.length;
      this.settings.colors[part] = pal[i];
      this.h.settingsChanged(this.settings);
      this.h.colorsChanged();
      this.h.sound();
      this.rerenderKeepFocus();
    } else if (el.dataset.act === 'lighting' || el.dataset.act === 'toggle') this.act(el);
  }

  // ------------------------------------------------------------------ actions
  private act(el: HTMLElement) {
    const a = el.dataset.act!;
    this.h.sound();
    switch (a) {
      case 'parks': this.show('parks', true); break;
      case 'rider': this.show('rider', true); break;
      case 'multiplayer': this.show('multiplayer', true); break;
      case 'mpjoin': this.h.mpJoin(); break;
      case 'mpleave': this.h.mpLeave(); break;
      case 'challenge': this.h.mpChallenge(); break;
      case 'accept': this.h.duelReply(true); break;
      case 'decline': this.h.duelReply(false); break;
      case 'replay': this.h.replay(); break;
      case 'color': case 'cycle': {
        const part = el.dataset.part as keyof RiderColors;
        const pal = PALETTES[part];
        this.settings.colors[part] = el.dataset.color ?? pal[(pal.indexOf(this.settings.colors[part]) + 1) % pal.length];
        this.h.settingsChanged(this.settings);
        this.h.colorsChanged();
        this.rerenderKeepFocus();
        break;
      }
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
    const mp = el.dataset.mp as 'playerName' | 'mpCode' | 'mpServer' | undefined;
    if (mp) {
      this.settings[mp] = mp === 'mpCode' ? el.value.toLowerCase().replace(/[^a-z0-9-]/g, '') : el.value;
      this.h.settingsChanged(this.settings);
      return;
    }
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
    const active = document.activeElement as HTMLInputElement | null;
    if (active?.type === 'text' && !['ArrowUp', 'ArrowDown', 'Escape', 'Enter', 'Tab'].includes(e.code)) {
      e.stopImmediatePropagation(); // typing: keep it away from the game, let the input have it
      return;
    }
    const isRange = active?.type === 'range';
    if (nav[e.code] && !(isRange && (e.code === 'ArrowLeft' || e.code === 'ArrowRight'))) {
      e.preventDefault(); e.stopImmediatePropagation();
      nav[e.code]();
    } else if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault(); e.stopImmediatePropagation();
      const el = this.items()[this.focus];
      if (el && !(el instanceof HTMLInputElement)) this.act(el);
      else if (el instanceof HTMLInputElement && el.type === 'text') this.move(1);
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
