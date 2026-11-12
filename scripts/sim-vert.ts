/// <reference types="node" />
/** Headless vert tests on a halfpipe: airs out of a quarter, fakie re-entry, 180s, flips. */
import { Emitter } from '../src/core/events';
import { emptyInput, type InputState } from '../src/core/input/actions';
import { RiderController } from '../src/rider/RiderController';
import type { RiderEvents } from '../src/rider/types';
import { World, type ParkDef } from '../src/world/World';
import { TUNING } from '../src/tuning';
import { flipPilot, spinPilot } from './pilot';

// halfpipe: two 3.4 m quarters facing each other, 6 m flat bottom
const H = 3.4, R = 3.0, FLAT = 6, W = 10;
const world = new World({
  name: 'pipe', spawn: { pos: [0, 0, -FLAT / 2], yaw: 0 },
  pieces: [
    { type: 'ground', pos: [0, 0, 0], size: 200 },
    { type: 'quarter', pos: [0, 0, FLAT / 2], height: H, radius: R, angle: 90, width: W, deck: 2 },
    { type: 'quarter', pos: [0, 0, -FLAT / 2], yaw: 180, height: H, radius: R, angle: 90, width: W, deck: 2 },
  ],
} as ParkDef);

type Script = (r: RiderController, t: number, i: InputState) => void;
function run(name: string, speed: number, script: Script, maxT = 6) {
  const ev = new Emitter<RiderEvents>();
  const r = new RiderController(world, ev);
  r.speed = speed;
  const log: string[] = [];
  let apex = 0, done = false;
  ev.on('takeoff', () => log.push(`takeoff vert=${r.vertAir} v=(${r.vel.toArray().map((v) => v.toFixed(1))})`));
  ev.on('landed', (l) => { log.push(`LANDED ${l.stomped ? 'STOMP' : 'clean'} "${l.trick}" fakie=${l.fakie} air=${l.air.airTime.toFixed(2)} yaw=${l.yawErr.toFixed(0)} pitch=${l.pitchErr.toFixed(0)}`); done = true; });
  ev.on('bail', (b) => { log.push(`BAIL ${b.reason}${b.landing ? ` "${b.landing.trick}" yaw=${b.landing.yawErr.toFixed(0)} pitch=${b.landing.pitchErr.toFixed(0)}` : ''} at y=${r.pos.y.toFixed(2)} z=${r.pos.z.toFixed(2)}`); done = true; });
  const dt = 1 / TUNING.physics.stepHz;
  for (let t = 0; t < maxT && !done; t += dt) {
    const i = emptyInput();
    script(r, t, i);
    r.step(dt, i);
    if (r.state === 'AIRBORNE') apex = Math.max(apex, r.pos.y);
  }
  console.log(`${name.padEnd(24)} apex=${apex.toFixed(2)} (coping ${H}) | ${log.join(' | ')}${done ? '' : ' | no result'} | after: ${r.state} speed=${r.speed.toFixed(1)}`);
}

const air = (r: RiderController) => r.state === 'AIRBORNE' && r.airTime > 0.05;
const deg = (x: number) => Math.abs(x) * 180 / Math.PI;
for (const v of [9, 11, 13]) run(`fakie air @${v}`, v, () => {});
run('180 air @12', 12, (r, _t, i) => { if (air(r)) spinPilot(r, i, 180); });
run('360 air @13', 13, (r, _t, i) => { if (air(r)) spinPilot(r, i, -360); });
run('backflip @13', 13, (r, _t, i) => { if (air(r)) flipPilot(r, i, 360); });
run('too slow (no air) @7', 7, () => {}, 4);
run('tailwhip @12', 12, (r, _t, i) => { if (air(r) && deg(r.whipAngle) < 320) i.tailwhip = true; });

// sustain: 20 s back and forth, holding W (pedal on the flat + pump the transitions), a 180 every air
{
  const ev = new Emitter<RiderEvents>();
  const r = new RiderController(world, ev);
  r.speed = 10;
  const airs: string[] = [];
  let bails = 0;
  ev.on('landed', (l) => airs.push(`${l.trick}@${l.air.airTime.toFixed(2)}s`));
  ev.on('bail', (b) => { bails++; airs.push(`BAIL(${b.reason})`); });
  const dt = 1 / TUNING.physics.stepHz;
  for (let t = 0; t < 20; t += dt) {
    const i = emptyInput();
    i.pedal = 1;
    if (r.state === 'AIRBORNE') { i.pedal = 0; spinPilot(r, i, 180); }
    r.step(dt, i);
  }
  console.log(`sustain 20s: ${airs.length} airs, ${bails} bails: ${airs.join(', ')}`);
}
