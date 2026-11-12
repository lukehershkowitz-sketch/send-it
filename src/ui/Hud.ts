import type { LandingResult, PopInfo } from '../rider/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** DOM HUD: landing popups, pop-timing flash, compression + restart bars, speedo, help, pause. */
export class Hud {
  private popup = $('popup');
  private popupTitle = $('popup-title');
  private popupSub = $('popup-sub');
  private popFx = $('pop-fx');
  private compress = $('compress');
  private compressFill = $('compress-fill');
  private restart = $('restart');
  private restartFill = $('restart-fill');
  private speedo = $('speedo');
  private help = $('help');
  private pause = $('pause');
  private padNote = $('pad-note');

  landed(l: LandingResult) {
    if (l.airTime < 0.35 && l.trick === 'HOP') return; // don't spam for tiny hops
    this.show(l.stomped ? 'STOMPED' : 'CLEAN', l.trick, l.stomped ? 'stomp' : 'clean');
  }

  bail(reason: string) {
    this.show('BAIL', reason, 'bail');
  }

  pop(p: PopInfo) {
    if (p.label === 'HOP') return;
    this.popFx.textContent = p.label === 'PERFECT' ? 'PERFECT POP' : `${p.label} POP`;
    this.popFx.className = '';
    void this.popFx.offsetWidth; // restart CSS animation
    this.popFx.className = `show ${p.label.toLowerCase()}`;
  }

  private show(title: string, sub: string, cls: string) {
    this.popupTitle.textContent = title;
    this.popupSub.textContent = sub;
    this.popup.className = '';
    void this.popup.offsetWidth;
    this.popup.className = `show ${cls}`;
  }

  frame(compression: number, restartT: number, speed: number, padConnected: boolean) {
    this.compress.style.opacity = compression > 0.02 ? '1' : '0';
    this.compressFill.style.width = `${compression * 100}%`;
    this.compressFill.classList.toggle('full', compression >= 0.999);
    this.restart.style.opacity = restartT > 0 ? '1' : '0';
    this.restartFill.style.width = `${Math.min(1, restartT) * 100}%`;
    this.speedo.textContent = `${Math.round(speed * 3.6)}`;
    this.padNote.textContent = padConnected ? '🎮 controller connected' : 'Controller: press any button to connect';
  }

  toggleHelp(force?: boolean) { this.help.classList.toggle('hidden', force === undefined ? undefined : !force); }
  setPaused(p: boolean) { this.pause.classList.toggle('hidden', !p); }
}
