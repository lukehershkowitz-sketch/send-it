import { TUNING } from '../tuning';
import { Emitter } from '../core/events';
import type { StateName } from '../rider/types';
import type { AirData, GrindType } from '../rider/types';
import { type Category, scoreAir, scoreGrind, scoreManual } from './scoring';

export interface LineEntry {
  name: string;
  points: number;
  cats: Record<Category, number>;
  note: string; // e.g. "75% repeat", "STOMPED"
  kind: string; // for variety counting
}

export interface BankedLine {
  entries: LineEntry[];
  base: number;
  variety: number;
  multiplier: number;
  total: number;
  cats: Record<Category, number>;
}

export interface ComboEvents {
  changed: ComboTracker;
  banked: BankedLine;
  lost: { entries: LineEntry[]; total: number };
}

const zero = (): Record<Category, number> => ({ tricks: 0, variety: 0, grinds: 0 });

/**
 * The current line. Tricks accumulate here and are only banked when you ride away clean
 * (roll on the ground for `linkWindow` without starting another trick). A bail loses it all.
 */
export class ComboTracker {
  readonly events = new Emitter<ComboEvents>();
  entries: LineEntry[] = [];
  private groundTimer = 0;
  /** Repetition memory: trick keys of the most recent scored airs (whole run). */
  history: Set<string>[] = [];

  get active(): boolean { return this.entries.length > 0; }
  get base(): number { return this.entries.reduce((a, e) => a + e.points, 0); }
  get multiplier(): number { return 1 + TUNING.score.linkStep * Math.max(0, this.entries.length - 1); }
  get total(): number { return Math.round(this.base * this.multiplier); }
  /** How long until the line banks while rolling (0..1 of the window used). */
  get bankProgress(): number { return this.groundTimer / TUNING.score.linkWindow; }

  addAir(air: AirData, stomped: boolean) {
    const s = scoreAir(air, stomped, this.history);
    if (s.keys.length) {
      this.history.push(new Set(s.keys));
      if (this.history.length > 8) this.history.shift();
    }
    if (s.points < 1) return;
    const notes: string[] = [];
    if (stomped) notes.push('STOMPED');
    if (s.inverted) notes.push(`INVERTED ×${TUNING.score.invertedMult}`);
    if (s.repeatFactor < 1) notes.push(`REPEAT ${Math.round(s.repeatFactor * 100)}%`);
    this.push({ name: s.name, points: s.points, cats: s.cats, note: notes.join(' · '), kind: s.keys.join('|') || 'air' });
  }

  addGrind(type: GrindType, time: number) {
    const s = scoreGrind(type, time);
    this.push({ name: s.name, points: s.points, cats: { ...zero(), grinds: s.points }, note: '', kind: type });
  }

  addManual(nose: boolean, time: number) {
    const s = scoreManual(nose, time);
    if (!s) return;
    this.push({ name: s.name, points: s.points, cats: { ...zero(), grinds: s.points }, note: '', kind: nose ? 'nose' : 'manual' });
  }

  private push(e: LineEntry) {
    this.entries.push(e);
    this.groundTimer = 0;
    this.events.emit('changed', this);
  }

  /** Call every sim step. Banks the line after rolling clean for the link window. */
  update(dt: number, state: StateName) {
    if (!this.active) { this.groundTimer = 0; return; }
    if (state === 'GROUNDED') {
      this.groundTimer += dt;
      if (this.groundTimer >= TUNING.score.linkWindow) this.bank();
    } else this.groundTimer = 0;
  }

  bank(): BankedLine | null {
    if (!this.active) return null;
    const kinds = new Set(this.entries.map((e) => e.kind)).size;
    const variety = TUNING.score.varietyPerKind * Math.max(0, kinds - 2);
    const mult = this.multiplier;
    const cats = zero();
    for (const e of this.entries) for (const c of Object.keys(cats) as Category[]) cats[c] += e.cats[c] * mult;
    cats.variety += variety * mult;
    const line: BankedLine = {
      entries: this.entries,
      base: this.base,
      variety,
      multiplier: mult,
      total: Math.round((this.base + variety) * mult),
      cats,
    };
    this.entries = [];
    this.groundTimer = 0;
    this.events.emit('banked', line);
    this.events.emit('changed', this);
    return line;
  }

  lose() {
    if (!this.active) return;
    const lost = { entries: this.entries, total: this.total };
    this.entries = [];
    this.groundTimer = 0;
    this.events.emit('lost', lost);
    this.events.emit('changed', this);
  }

  reset() {
    this.entries = [];
    this.history = [];
    this.groundTimer = 0;
    this.events.emit('changed', this);
  }
}
