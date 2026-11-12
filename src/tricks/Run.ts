import { TUNING } from '../tuning';
import type { BankedLine } from './Combo';
import type { Category } from './scoring';

export interface RunSummary {
  park: string;
  score: number;
  cats: Record<Category, number>;
  bestLine: { total: number; names: string[] } | null;
  lines: number;
  tricks: number;
  bails: number;
  lostPoints: number;
  personalBest: number;
  newBest: boolean;
}

/** A timed run: totals banked lines by category; personal best per park in localStorage. */
export class Run {
  timeLeft: number;
  score = 0;
  cats: Record<Category, number> = { tricks: 0, variety: 0, grinds: 0 };
  bestLine: RunSummary['bestLine'] = null;
  lines = 0;
  tricks = 0;
  bails = 0;
  lostPoints = 0;
  ended = false;

  constructor(readonly park: string, duration: number = TUNING.run.duration) {
    this.timeLeft = duration;
  }

  get personalBest(): number { return loadBest(this.park); }

  bank(line: BankedLine) {
    this.score += line.total;
    for (const c of Object.keys(this.cats) as Category[]) this.cats[c] += line.cats[c];
    this.lines++;
    this.tricks += line.entries.length;
    if (!this.bestLine || line.total > this.bestLine.total)
      this.bestLine = { total: line.total, names: line.entries.map((e) => e.name) };
  }

  lost(points: number) { this.lostPoints += points; }
  bail() { this.bails++; }

  finish(): RunSummary {
    this.ended = true;
    const prev = loadBest(this.park);
    const newBest = this.score > prev;
    if (newBest) saveBest(this.park, this.score);
    return {
      park: this.park, score: Math.round(this.score), cats: this.cats, bestLine: this.bestLine,
      lines: this.lines, tricks: this.tricks, bails: this.bails, lostPoints: this.lostPoints,
      personalBest: Math.max(prev, this.score), newBest,
    };
  }
}

const key = (park: string) => `sendit.pb.${park}`;
function loadBest(park: string): number {
  try { return Number(localStorage.getItem(key(park))) || 0; } catch { return 0; }
}
function saveBest(park: string, score: number) {
  try { localStorage.setItem(key(park), String(Math.round(score))); } catch { /* ignore */ }
}
