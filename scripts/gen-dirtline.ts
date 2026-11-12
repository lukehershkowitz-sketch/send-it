/// <reference types="node" />
/**
 * Generates src/world/parks/dirtline.json. Each double's gap is chosen by simulation:
 * at full pedal speed, both rolling off the lip and a perfect pop (+360) must land clean.
 *   npx tsx scripts/gen-dirtline.ts
 */
import { writeFileSync } from 'node:fs';
import { Emitter } from '../src/core/events';
import { emptyInput } from '../src/core/input/actions';
import { RiderController } from '../src/rider/RiderController';
import type { RiderEvents } from '../src/rider/types';
import { World, type ParkDef } from '../src/world/World';
import { kickerProfile, landingProfile, type PieceDef } from '../src/world/pieces';
import { TUNING } from '../src/tuning';

/** needsPop: the gap is sized so you have to pop (rolling off cases it). */
type Jump = { h: number; a: number; lh: number; slope: number; w: number; turn: number; needsPop?: boolean };
const JUMPS: Jump[] = [
  { h: 1.4, a: 32, lh: 1.5, slope: 25, w: 3.2, turn: 0 },
  { h: 1.6, a: 33, lh: 1.7, slope: 26, w: 3.2, turn: 4 },
  { h: 1.8, a: 34, lh: 1.9, slope: 27, w: 3.4, turn: 4 },
  { h: 1.8, a: 34, lh: 1.9, slope: 27, w: 3.4, turn: -3 },
  { h: 2.0, a: 35, lh: 2.2, slope: 28, w: 3.4, turn: -6, needsPop: true },
  { h: 2.2, a: 36, lh: 2.4, slope: 28, w: 3.6, turn: -4, needsPop: true },
  { h: 2.0, a: 35, lh: 2.2, slope: 28, w: 3.4, turn: 5, needsPop: true },
  { h: 2.4, a: 37, lh: 2.7, slope: 29, w: 3.8, turn: 6, needsPop: true },
  { h: 2.6, a: 38, lh: 3.0, slope: 30, w: 4.0, turn: 0, needsPop: true },
];
const RUNWAY = 13;      // flat between a landing and the next kicker
const DECK = 0.3, KNUCKLE = 2, TRANS = 5;

const landingDef = (j: Jump, z: number): Extract<PieceDef, { type: 'landing' }> => ({
  type: 'landing', pos: [0, 0, z], height: j.lh, slope: j.slope, width: j.w + 2, deck: DECK,
  knuckleRadius: KNUCKLE, transitionRadius: TRANS,
});

/** Simulate one jump in isolation. Returns true if it lands clean. */
function tryJump(j: Jump, landingZ: number, pop: boolean, spin: boolean, releaseAt = 0.3): boolean {
  const def: ParkDef = {
    name: 'test', spawn: { pos: [0, 0, -28], yaw: 0 },
    pieces: [
      { type: 'ground', pos: [0, 0, 0], size: 200 },
      { type: 'kicker', pos: [0, 0, 0], height: j.h, angle: j.a, width: j.w },
      landingDef(j, landingZ),
    ],
  };
  const world = new World(def);
  const lip = world.lips[0];
  const ev = new Emitter<RiderEvents>();
  let result: boolean | null = null;
  ev.on('landed', (l) => { if (l.air.airTime > 0.25) result ??= true; });
  ev.on('bail', () => { result ??= false; });
  const r = new RiderController(world, ev);
  const dt = 1 / TUNING.physics.stepHz;
  for (let t = 0; t < 8 && result === null; t += dt) {
    const i = emptyInput();
    const d = lip.pos.z - r.pos.z;
    if (r.state === 'GROUNDED' && r.pos.z < 0) i.pedal = 1;
    if (pop && r.state === 'GROUNDED' && d < releaseAt + 2.3 && d > releaseAt) i.pop = true;
    if (spin && r.state === 'AIRBORNE' && r.airTime > 0.05 && Math.abs(r.spinAngle) < (335 * Math.PI) / 180) i.steer = 1;
    r.step(dt, i);
  }
  return result === true;
}

/** Gap (lip → landing front base) = middle of the widest window where every test lands. */
function solveGap(j: Jump): number {
  const kLen = kickerProfile(j.h, j.a).length;
  let best: [number, number] = [0, -1], cur: number | null = null;
  const ok: number[] = [];
  for (let g = 0; g <= 6; g += 0.2) {
    const z = kLen + g;
    const pass = (j.needsPop || tryJump(j, z, false, false)) && tryJump(j, z, true, false) && tryJump(j, z, true, true) &&
      tryJump(j, z, true, false, 2.4); // a slightly early pop still makes it
    ok.push(pass ? 1 : 0);
    if (pass) { cur ??= g; if (g - cur > best[1] - best[0]) best = [cur, g]; }
    else cur = null;
  }
  if (best[1] < 0) throw new Error(`no working gap for jump ${JSON.stringify(j)}`);
  console.log(`h=${j.h} a=${j.a}: window ${best[0].toFixed(1)}–${best[1].toFixed(1)} m  ${ok.map((o) => (o ? '█' : '·')).join('')}`);
  return Math.max(Math.min(1.2, best[1]), best[0] + (best[1] - best[0]) * 0.55);
}

// --------------------------------------------------------------------------- lay out the line
const rad = Math.PI / 180;
let x = 0, z = 0, yaw = 0; // cursor (yaw in degrees)
const fwd = (d: number) => { x += Math.sin(yaw * rad) * d; z += Math.cos(yaw * rad) * d; };
const P = (): [number, number, number] => [+x.toFixed(3), 0, +z.toFixed(3)];
const pieces: PieceDef[] = [{ type: 'ground', pos: [0, 0, 120], size: 700 }];
const checkpoints: ParkDef['checkpoints'] = [];

// roll-in hill (a landing-shaped mound with a long deck); spawn on top of it
const rollIn: Extract<PieceDef, { type: 'landing' }> = {
  type: 'landing', pos: [0, 0, -30], height: 3.6, slope: 24, width: 5, deck: 5, faceAngle: 45, knuckleRadius: 3, transitionRadius: 7,
};
const rollRuns = landingProfile(rollIn);
const faceRun = rollRuns[0][1][0];
const rollLen = rollRuns[1][rollRuns[1].length - 1][0];
pieces.push(rollIn);
const spawn = { pos: [0, 3.6, -30 + faceRun + 1.2] as [number, number, number], yaw: 0 };
z = -30 + rollLen + 14;

for (const [n, j] of JUMPS.entries()) {
  yaw += j.turn;
  fwd(0);
  // checkpoint a bit before the kicker, rolling at speed
  const cx = x - Math.sin(yaw * rad) * 12, cz = z - Math.cos(yaw * rad) * 12;
  checkpoints.push({ pos: [+cx.toFixed(2), 0, +cz.toFixed(2)], yaw, speed: 11 });
  const gap = solveGap(j);
  const kLen = kickerProfile(j.h, j.a).length;
  pieces.push({ type: 'kicker', pos: P(), yaw, height: j.h, angle: j.a, width: j.w });
  fwd(kLen + gap);
  const land = landingDef(j, 0);
  land.pos = P();
  land.yaw = yaw;
  pieces.push(land);
  const lRuns = landingProfile(land);
  const lLen = lRuns[1][lRuns[1].length - 1][0];
  fwd(lLen + (n === JUMPS.length - 1 ? 14 : RUNWAY));
}
const finish = { pos: P(), radius: 6 };

const park: ParkDef = {
  name: 'Dirt Line',
  spawn,
  checkpoints,
  finish,
  decor: { theme: 'forest', trees: 900, rocks: 120, clear: 9, pathWidth: 3.8, lamps: 18 },
  pieces,
};
writeFileSync(new URL('../src/world/parks/dirtline.json', import.meta.url), JSON.stringify(park, null, 2) + '\n');
console.log(`wrote dirtline.json: ${JUMPS.length} doubles, line length ≈ ${Math.round(z + 30)} m, finish at`, finish.pos);
