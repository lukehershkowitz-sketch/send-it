import type { LandingResult, PopInfo } from '../rider/types';
import type { BankedLine, ComboTracker, LineEntry } from '../tricks/Combo';
import { CATEGORY_LABELS, type Category } from '../tricks/scoring';
import type { RunSummary } from '../tricks/Run';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** DOM HUD: popups, pop-timing flash, combo line, balance meter, score/timer, summary, help, pause. */
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
  private combo = $('combo');
  private comboList = $('combo-list');
  private comboLive = $('combo-live');
  private comboTotal = $('combo-total');
  private comboBank = $('combo-bank');
  private bankFx = $('bank-fx');
  private balance = $('balance');
  private balanceNeedle = $('balance-needle');
  private balanceLabel = $('balance-label');
  private score = $('score');
  private timer = $('timer');
  private pb = $('pb');
  private summary = $('summary');
  private liveText = '';

  landed(l: LandingResult) {
    if (l.air.airTime < 0.35 && l.trick.endsWith('HOP')) return; // don't spam for tiny hops
    this.show(l.stomped ? 'STOMPED' : 'CLEAN', l.trick, l.stomped ? 'stomp' : 'clean');
  }

  bail(reason: string) { this.show('BAIL', reason, 'bail'); }

  pop(p: PopInfo) {
    if (p.label === 'HOP') return;
    this.popFx.textContent = p.label === 'PERFECT' ? 'PERFECT POP' : `${p.label} POP`;
    this.restartAnim(this.popFx, `show ${p.label.toLowerCase()}`);
  }

  private show(title: string, sub: string, cls: string) {
    this.popupTitle.textContent = title;
    this.popupSub.textContent = sub;
    this.restartAnim(this.popup, `show ${cls}`);
  }

  private restartAnim(el: HTMLElement, cls: string) {
    el.className = '';
    void el.offsetWidth;
    el.className = cls;
  }

  // ------------------------------------------------------------------ combo line
  comboChanged(c: ComboTracker) {
    const entries = c.entries;
    this.combo.classList.toggle('active', entries.length > 0);
    const shown = entries.slice(-5);
    this.comboList.innerHTML =
      (entries.length > shown.length ? `<div class="more">+${entries.length - shown.length} more</div>` : '') +
      shown.map((e) => entryHtml(e)).join('');
    this.comboTotal.innerHTML = entries.length
      ? `${fmt(c.base)} <span class="mult">× ${c.multiplier.toFixed(1)}</span>` : '';
  }

  banked(b: BankedLine) {
    this.bankFx.innerHTML = `+${fmt(b.total)}<small>${b.variety ? `incl. variety +${fmt(b.variety * b.multiplier)} · ` : ''}LINE BANKED</small>`;
    this.restartAnim(this.bankFx, 'show bank');
  }

  lost(total: number) {
    this.bankFx.innerHTML = `<s>${fmt(total)}</s><small>LINE LOST</small>`;
    this.restartAnim(this.bankFx, 'show lost');
  }

  /** Called every frame: live trick name, bank countdown, balance meter, bars. */
  frame(o: {
    compression: number; restartT: number; speed: number; padConnected: boolean;
    live: string; bankProgress: number; balance: number | null; balanceLabel: string;
    score: number; timeLeft: number; personalBest: number;
  }) {
    this.compress.style.opacity = o.compression > 0.02 ? '1' : '0';
    this.compressFill.style.width = `${o.compression * 100}%`;
    this.compressFill.classList.toggle('full', o.compression >= 0.999);
    this.restart.style.opacity = o.restartT > 0 ? '1' : '0';
    this.restartFill.style.width = `${Math.min(1, o.restartT) * 100}%`;
    this.speedo.textContent = `${Math.round(o.speed * 3.6)}`;
    this.padNote.textContent = o.padConnected ? '🎮 controller connected' : 'Controller: press any button to connect';
    if (o.live !== this.liveText) {
      this.liveText = o.live;
      this.comboLive.textContent = o.live;
      this.combo.classList.toggle('live', !!o.live);
    }
    this.comboBank.style.width = `${Math.min(1, o.bankProgress) * 100}%`;
    if (o.balance === null) this.balance.classList.remove('show');
    else {
      this.balance.classList.add('show');
      const b = Math.max(-1, Math.min(1, o.balance));
      this.balanceNeedle.style.left = `${50 + b * 50}%`;
      this.balanceNeedle.classList.toggle('danger', Math.abs(b) > 0.7);
      this.balanceLabel.textContent = o.balanceLabel;
    }
    this.score.textContent = fmt(o.score);
    const t = Math.max(0, o.timeLeft);
    this.timer.textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    this.timer.classList.toggle('low', t < 10);
    this.pb.textContent = o.personalBest > 0 ? `PB ${fmt(o.personalBest)}` : '';
  }

  showSummary(s: RunSummary) {
    const rows = (Object.keys(CATEGORY_LABELS) as Category[])
      .map((c) => `<tr><td>${CATEGORY_LABELS[c]}</td><td>${fmt(s.cats[c])}</td></tr>`).join('');
    this.summary.innerHTML = `
      <div class="card">
        <h2>RUN COMPLETE</h2>
        <div class="park">${esc(s.park)}</div>
        <div class="big">${fmt(s.score)}</div>
        ${s.newBest ? '<div class="newbest">NEW PERSONAL BEST!</div>' : `<div class="pbline">Personal best ${fmt(s.personalBest)}</div>`}
        <table>${rows}</table>
        <div class="stats">${plural(s.lines, 'line')} banked · ${plural(s.tricks, 'trick')} · ${plural(s.bails, 'bail')}${s.lostPoints ? ` · ${fmt(s.lostPoints)} pts lost to bails` : ''}</div>
        ${s.bestLine ? `<div class="best"><b>Best line ${fmt(s.bestLine.total)}</b><br>${s.bestLine.names.map(esc).join(' → ')}</div>` : ''}
        <div class="again">Press <kbd>Space</kbd> / <kbd>A</kbd> to ride again</div>
      </div>`;
    this.summary.classList.remove('hidden');
  }

  hideSummary() { this.summary.classList.add('hidden'); }
  toggleHelp(force?: boolean) { this.help.classList.toggle('hidden', force === undefined ? undefined : !force); }
  setPaused(p: boolean) { this.pause.classList.toggle('hidden', !p); }
}

function entryHtml(e: LineEntry) {
  return `<div class="entry"><span class="name">${esc(e.name)}</span><span class="pts">${fmt(e.points)}</span>${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}</div>`;
}
