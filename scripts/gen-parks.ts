/// <reference types="node" />
/**
 * Generates the Phase 4 park layouts as JSON (src/world/parks/*.json). Positions that depend
 * on ramp geometry (spines, bowl corner, mega-ramp gap) are computed here, and the mega
 * ramp's gap is sized by simulating the jump.   npx tsx scripts/gen-parks.ts
 */
import { writeFileSync } from 'node:fs';
import { Emitter } from '../src/core/events';
import { emptyInput } from '../src/core/input/actions';
import { RiderController } from '../src/rider/RiderController';
import type { RiderEvents } from '../src/rider/types';
import { World, type ParkDef } from '../src/world/World';
import { landingProfile, quarterProfile, type PieceDef } from '../src/world/pieces';
import { TUNING } from '../src/tuning';
import { popRelease } from './pilot';

const out = (name: string, park: ParkDef) => {
  writeFileSync(new URL(`../src/world/parks/${name}.json`, import.meta.url), JSON.stringify(park, null, 2) + '\n');
  console.log(`wrote ${name}.json (${park.pieces.length} pieces)`);
};
const top = (H: number, R: number, angle: number) => quarterProfile(H, R, angle, 0).top;

// --------------------------------------------------------------------------- SKATEPARK
{
  const H = 2.4, R = 2.6, A = 85, W = 14, Rc = 4;
  const sH = 1.8, sR = 2.2, sA = 70, sTop = top(sH, sR, sA);
  const pieces: PieceDef[] = [
    { type: 'ground', pos: [0, 0, 0], size: 500 },
    // facing quarters (north / south)
    { type: 'quarter', pos: [0, 0, 22], yaw: 0, height: H, radius: R, angle: A, width: W, deck: 3 },
    { type: 'quarter', pos: [0, 0, -22], yaw: 180, height: H, radius: R, angle: A, width: W, deck: 3 },
    // bowl corner joining the north quarter to an east quarter
    { type: 'corner', pos: [W / 2, 0, 22 - Rc], height: H, radius: R, angle: A, cornerRadius: Rc, deck: 3 },
    { type: 'quarter', pos: [W / 2 + Rc, 0, 22 - Rc - 6], yaw: 90, height: H, radius: R, angle: A, width: 12, deck: 3 },
    // spine on the west side (two 70° quarters back to back, running along Z)
    { type: 'quarter', pos: [-14, 0, 0], yaw: -90, height: sH, radius: sR, angle: sA, width: 12, deck: 0 },
    { type: 'quarter', pos: [-14 - 2 * sTop, 0, 0], yaw: 90, height: sH, radius: sR, angle: sA, width: 12, deck: 0 },
    // box jump in the middle
    { type: 'funbox', pos: [0, 0, -7], height: 1.2, angle: 26, deck: 3, width: 4.5, surface: 'wood' },
    // flat rail and a ledge
    { type: 'rail', pos: [7, 0, -10], length: 6, height: 0.42 },
    { type: 'ledge', pos: [-6, 0, -12], length: 6, height: 0.45, width: 0.6 },
    // stair set with a hubba, reached by a bank behind it
    { type: 'wedge', pos: [16, 0, -14 - 0.68 / Math.tan(20 * Math.PI / 180)], height: 0.68, angle: 20, width: 4 },
    { type: 'stairs', pos: [16, 0, -14], steps: 4, rise: 0.17, run: 0.34, top: 3, width: 4 },
    { type: 'ledge', pos: [18.4, 0, -11], length: 3 * 0.34 + 0.01, height: 0.68 + 0.35, width: 0.5, drop: 0.68 },
  ];
  out('skatepark', {
    name: 'Skatepark',
    spawn: { pos: [0, 0, -15], yaw: 0, speed: 6 },
    decor: { theme: 'urban', trees: 160, rocks: 0, clear: 10, solidArea: true, lampLayout: 'perimeter', lamps: 14 },
    pieces,
  });
}

// --------------------------------------------------------------------------- STREET PLAZA
{
  const PH = 1.4; // platform height
  const pieces: PieceDef[] = [
    { type: 'ground', pos: [0, 0, 0], size: 500 },
    { type: 'block', pos: [0, 0, -32], length: 12, width: 28, height: PH },
    // 8 stair with handrails
    { type: 'stairs', pos: [-7, 0, -20.5], steps: 8, rise: PH / 8, run: 0.32, top: 0.5, width: 5 },
    { type: 'rail', pos: [-9.8, 0, -20.4], length: 7 * 0.32 + 0.45, height: PH + 0.55, drop: PH },
    { type: 'rail', pos: [-4.2, 0, -20.4], length: 7 * 0.32 + 0.45, height: PH + 0.55, drop: PH },
    // 5 stair with a hubba
    { type: 'stairs', pos: [7, 0, -20.5], steps: 5, rise: PH / 5, run: 0.42, top: 0.5, width: 4 },
    { type: 'ledge', pos: [9.4, 0, -20.4], length: 4 * 0.42 + 0.45, height: PH + 0.35, width: 0.5, drop: PH },
    // gap to bank: ride off the platform, clear the gap, land on the down-bank
    { type: 'wedge', pos: [0, 0, -18.4 + 0.4 + 0.7 / Math.tan(20 * Math.PI / 180)], yaw: 180, height: 0.7, angle: 20, deck: 0.4, width: 5 },
    // street furniture
    { type: 'block', pos: [0, 0, -6], length: 5, width: 2, height: 0.25, grind: true },
    { type: 'ledge', pos: [-15, 0, -9], length: 6, height: 0.45, width: 0.6 },
    { type: 'ledge', pos: [10, 0, -6], length: 8, height: 0.5, width: 0.7 },
    { type: 'rail', pos: [-4, 0, 2], length: 6, height: 0.45 },
    { type: 'wedge', pos: [6, 0, 6], yaw: 180, height: 0.8, angle: 25, deck: 2.5, width: 3 },
  ];
  out('plaza', {
    name: 'Street Plaza',
    spawn: { pos: [0, PH, -28], yaw: 0, speed: 5 },
    checkpoints: [],
    decor: { theme: 'urban', trees: 80, rocks: 0, clear: 8, solidArea: true, buildings: 26, lampLayout: 'perimeter', lamps: 14 },
    pieces,
  });
}

// --------------------------------------------------------------------------- VERT
{
  const H = 3.6, R = 3.2, FLAT = 5, W = 12;
  out('vert', {
    name: 'Vert',
    spawn: { pos: [0, 0, 0], yaw: 0, speed: 11 },
    runSeconds: 60,
    decor: { theme: 'meadow', trees: 220, rocks: 30, clear: 12, solidArea: true, lampLayout: 'perimeter', lamps: 12 },
    pieces: [
      { type: 'ground', pos: [0, 0, 0], size: 500 },
      { type: 'quarter', pos: [0, 0, FLAT / 2], height: H, radius: R, angle: 90, width: W, deck: 3, surface: 'wood' },
      { type: 'quarter', pos: [0, 0, -FLAT / 2], yaw: 180, height: H, radius: R, angle: 90, width: W, deck: 3, surface: 'wood' },
    ],
  });
}

// --------------------------------------------------------------------------- MEGA RAMP
{
  const rollIn: Extract<PieceDef, { type: 'landing' }> = {
    type: 'landing', pos: [0, 0, -70], height: 14, slope: 34, width: 7, deck: 6, faceAngle: 55, knuckleRadius: 5, transitionRadius: 14, surface: 'wood',
  };
  const rr = landingProfile(rollIn);
  const rollEnd = -70 + rr[1][rr[1].length - 1][0];
  const kickZ = rollEnd + 12;
  const kicker = { type: 'kicker' as const, pos: [0, 0, kickZ] as [number, number, number], height: 5.5, angle: 56, width: 6, surface: 'wood' as const };
  const landing = (z: number): Extract<PieceDef, { type: 'landing' }> => ({
    type: 'landing', pos: [0, 0, z], height: 4.6, slope: 26, width: 10, deck: 0.5, faceAngle: 55, knuckleRadius: 4, transitionRadius: 11, surface: 'wood',
  });
  const spawnZ = -70 + rr[0][1][0] + 2;
  const test = (landZ: number, pop: boolean) => {
    const world = new World({ name: 't', groundGravityScale: 1, spawn: { pos: [0, 14, spawnZ], yaw: 0, speed: 3 }, pieces: [{ type: 'ground', pos: [0, 0, 0], size: 400 }, rollIn, kicker, landing(landZ)] } as ParkDef);
    const lip = world.lips[0];
    const ev = new Emitter<RiderEvents>();
    let res: boolean | null = null;
    ev.on('landed', (l) => { if (l.air.airTime > 0.4) res ??= true; });
    ev.on('bail', () => { res ??= false; });
    const r = new RiderController(world, ev);
    for (let t = 0; t < 14 && res === null; t += 1 / TUNING.physics.stepHz) {
      const i = emptyInput();
      if (pop && r.state === 'GROUNDED') popRelease(r, lip, i);
      r.step(1 / TUNING.physics.stepHz, i);
    }
    return res === true;
  };
  const kLen = 5.5 / (1 - Math.cos(56 * Math.PI / 180)) * Math.sin(56 * Math.PI / 180);
  let lo = -1, hi = -1;
  const bar: string[] = [];
  for (let g = 2; g <= 20; g += 0.5) {
    const ok = test(kickZ + kLen + g, false) && test(kickZ + kLen + g, true);
    bar.push(ok ? '█' : '·');
    if (ok) { if (lo < 0) lo = g; hi = g; }
  }
  console.log(`mega gap window ${lo}–${hi} m  ${bar.join('')}`);
  if (lo < 0) throw new Error('no mega gap works');
  const gap = lo + (hi - lo) * 0.6;
  const landZ = kickZ + kLen + gap;
  const lp = landingProfile(landing(landZ));
  const landEnd = landZ + lp[1][lp[1].length - 1][0];
  const qZ = landEnd + 22;
  out('mega', {
    name: 'Mega Ramp',
    groundGravityScale: 1,
    spawn: { pos: [0, 14, spawnZ], yaw: 0, speed: 3 },
    finish: { pos: [0, 0, landEnd + 8], radius: 7, yaw: 180 },
    decor: { theme: 'meadow', trees: 300, rocks: 40, clear: 14, solidArea: true, lampLayout: 'perimeter', lamps: 20 },
    pieces: [
      { type: 'ground', pos: [0, 0, 0], size: 600 },
      rollIn, kicker, landing(landZ),
      { type: 'quarter', pos: [0, 0, qZ], height: 6, radius: 5.5, angle: 88, width: 12, deck: 3, surface: 'wood' },
    ],
  });
}
