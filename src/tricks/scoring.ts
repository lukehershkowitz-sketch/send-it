import { TUNING } from '../tuning';
import { clamp, lerp } from '../core/math';
import type { AirData, GrindType, Variation } from '../rider/types';

export type Category = 'tricks' | 'variety' | 'grinds';
export const CATEGORY_LABELS: Record<Category, string> = {
  tricks: 'Tricks & Airtime',
  variety: 'Variety & Holds',
  grinds: 'Grinds, Manuals & Stomps',
};

/** One scoring element of an air (a spin, a flip, a whip chain, a held grab…). */
export interface Element {
  key: string | null; // repetition key (null = never penalised, e.g. airtime)
  label: string;
  base: number;
  cat: Category;
}

const VAR_NAMES: Record<Variation, string> = { tuck: 'TUCK NO-HANDER', superman: 'SUPERMAN', cancan: 'CAN-CAN' };
const multiple = (n: number, word: string) =>
  n === 1 ? word : n === 2 ? `DOUBLE ${word}` : n === 3 ? `TRIPLE ${word}` : `${n}x ${word}`;

/** Rounded rotation counts from an air. */
export function airCounts(a: AirData) {
  const halfSpins = Math.round(Math.abs(a.spinDeg) / 180);
  const flips = Math.round(a.flipDeg / 360);
  const spinDir = a.spinDeg >= 0 ? 'L' : 'R';
  const flair = flips === 1 && halfSpins === 1;
  return { halfSpins, flips, spinDir, flair };
}

/** Group a whip/bar chain into runs: WHIP,WHIP,BAR → [[WHIP,2],[BAR,1]] */
function runs(chain: AirData['chain']): [AirData['chain'][number], number][] {
  const out: [AirData['chain'][number], number][] = [];
  for (const c of chain) {
    const last = out[out.length - 1];
    if (last && last[0] === c) last[1]++;
    else out.push([c, 1]);
  }
  return out;
}

/** Variations held long enough to count. */
function countedVariations(a: AirData): [Variation, number][] {
  return (Object.entries(a.variations) as [Variation, number][])
    .filter(([, t]) => t >= TUNING.score.varMinHold);
}

/** Human-readable name, e.g. "FAKIE 360 BACKFLIP DOUBLE TAILWHIP TO BARSPIN + SUPERMAN". */
export function describeAir(a: AirData, live = false): string {
  const { halfSpins, flips, flair } = airCounts(a);
  const parts: string[] = [];
  if (a.takeoffFakie) parts.push('FAKIE');
  if (flair) parts.push('FLAIR');
  else {
    if (halfSpins > 0) parts.push(String(halfSpins * 180));
    if (flips !== 0) parts.push(multiple(Math.abs(flips), flips > 0 ? 'BACKFLIP' : 'FRONTFLIP'));
  }
  const chain = runs(a.chain).map(([k, n]) => multiple(n, k === 'WHIP' ? 'TAILWHIP' : 'BARSPIN'));
  if (chain.length) parts.push(chain.join(' TO '));
  const vars = (Object.entries(a.variations) as [Variation, number][])
    .filter(([, t]) => t >= (live ? 0.05 : TUNING.score.varMinHold))
    .map(([v]) => VAR_NAMES[v]);
  let name = parts.join(' ');
  if (vars.length) name = name && name !== 'FAKIE' ? `${name} + ${vars.join(' + ')}` : `${name ? name + ' ' : ''}${vars.join(' + ')}`;
  if (!name || name === 'FAKIE') name = `${name ? 'FAKIE ' : ''}${a.airTime > TUNING.score.minAirForAirtime ? 'AIR' : 'HOP'}`;
  return name;
}

/** Break an air into scoring elements (before multipliers). */
export function airElements(a: AirData): Element[] {
  const S = TUNING.score;
  const { halfSpins, flips, spinDir, flair } = airCounts(a);
  const f = a.takeoffFakie ? 'F:' : '';
  const els: Element[] = [];
  if (flair) {
    els.push({ key: `${f}flair${spinDir}`, label: 'FLAIR', base: S.flipPer360 + S.spinPer180 + S.flairBonus, cat: 'tricks' });
  } else {
    if (halfSpins > 0)
      els.push({ key: `${f}spin${halfSpins * 180}${spinDir}`, label: String(halfSpins * 180), base: S.spinPer180 * halfSpins, cat: 'tricks' });
    if (flips !== 0)
      els.push({ key: `${f}${flips > 0 ? 'back' : 'front'}flip${Math.abs(flips)}`, label: multiple(Math.abs(flips), flips > 0 ? 'BACKFLIP' : 'FRONTFLIP'), base: S.flipPer360 * Math.abs(flips), cat: 'tricks' });
  }
  for (const [k, n] of runs(a.chain)) {
    if (k === 'WHIP') els.push({ key: `${f}whip${n}`, label: multiple(n, 'TAILWHIP'), base: S.whipPer360 * n, cat: 'tricks' });
    else els.push({ key: `${f}bar${n}${a.barDir > 0 ? 'R' : 'L'}`, label: multiple(n, 'BARSPIN'), base: S.barPer360 * n, cat: 'tricks' });
  }
  for (const [v, t] of countedVariations(a)) {
    const k = clamp((t - S.varMinHold) / (S.varMaxHold - S.varMinHold), 0, 1);
    els.push({ key: `${f}${v}`, label: `${VAR_NAMES[v]} ${t.toFixed(1)}s`, base: S.variations[v] * lerp(1, S.varMaxMult, k), cat: 'variety' });
  }
  if (a.airTime >= S.minAirForAirtime)
    els.push({ key: null, label: 'AIRTIME', base: S.airtimePerSec * a.airTime, cat: 'tricks' });
  return els;
}

export interface ScoredAir {
  name: string;
  points: number;
  cats: Record<Category, number>;
  keys: string[];
  repeatFactor: number; // lowest repetition factor applied (for the HUD note)
  inverted: boolean;
}

/** Score an air given the repetition history (sets of keys from the most recent airs, newest last). */
export function scoreAir(a: AirData, stomped: boolean, history: Set<string>[]): ScoredAir {
  const S = TUNING.score;
  const els = airElements(a);
  const cats: Record<Category, number> = { tricks: 0, variety: 0, grinds: 0 };
  let repeatFactor = 1;
  const recent = history.slice(-S.repetitionMemory);
  for (const e of els) {
    let k = 1;
    if (e.key) {
      const seen = recent.filter((h) => h.has(e.key!)).length;
      k = S.repetition[Math.min(seen, S.repetition.length - 1)];
      repeatFactor = Math.min(repeatFactor, k);
    }
    cats[e.cat] += e.base * k;
  }
  const { flips } = airCounts(a);
  const inverted = flips !== 0;
  if (inverted) { cats.tricks *= S.invertedMult; cats.variety *= S.invertedMult; }
  if (stomped) cats.grinds += (cats.tricks + cats.variety) * (S.stompMult - 1);
  const points = cats.tricks + cats.variety + cats.grinds;
  return {
    name: describeAir(a),
    points,
    cats,
    keys: els.map((e) => e.key).filter((k): k is string => !!k),
    repeatFactor,
    inverted,
  };
}

export function scoreGrind(type: GrindType, time: number) {
  const S = TUNING.score;
  return { name: `${type} ${time.toFixed(1)}s`, points: (S.grindBase[type] ?? 100) + S.grindPerSec * time };
}

export function scoreManual(nose: boolean, time: number) {
  const S = TUNING.score;
  if (time < S.minManualTime) return null;
  return { name: `${nose ? 'NOSE MANUAL' : 'MANUAL'} ${time.toFixed(1)}s`, points: S.manualBase + S.manualPerSec * time };
}
