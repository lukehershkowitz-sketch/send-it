/// <reference types="node" />
/** Bot rides the whole Dirt Line: steer to each kicker, pedal, perfect pop, a trick per jump. */
import { Emitter } from '../src/core/events';
import { emptyInput } from '../src/core/input/actions';
import { RiderController } from '../src/rider/RiderController';
import type { RiderEvents } from '../src/rider/types';
import { World, type ParkDef } from '../src/world/World';
import { TUNING } from '../src/tuning';
import park from '../src/world/parks/dirtline.json';

const world = new World(park as ParkDef);
const ev = new Emitter<RiderEvents>();
const r = new RiderController(world, ev);
const lips = world.lips;
const out: string[] = [];
let bails = 0, finished = false;
ev.on('landed', (l) => { if (l.air.airTime > 0.3) out.push(`${l.stomped ? 'STOMP' : 'clean'} ${l.trick} (${l.air.airTime.toFixed(2)}s)`); });
ev.on('bail', (b) => { bails++; out.push(`BAIL ${b.reason}${b.landing ? ` [${b.landing.trick}] air=${b.landing.air.airTime.toFixed(2)}` : ''} at (${r.pos.x.toFixed(1)}, ${r.pos.y.toFixed(2)}, ${r.pos.z.toFixed(1)}) lip#${lipIdx} state-before=${prevState} speed=${prevSpeed.toFixed(1)}`); });
ev.on('checkpoint', (c) => out.push(`cp${c.index}`));
ev.on('finish', () => { finished = true; out.push('FINISH'); });

const tricks = [null, 'spin', null, 'flip', 'whip', 'spin', 'bar', 'flip', 'spin'];
let lipIdx = 0;
let prevState = '', prevSpeed = 0;
const dt = 1 / TUNING.physics.stepHz;
for (let t = 0; t < 90 && !finished; t += dt) {
  const i = emptyInput();
  const lip = lips[Math.min(lipIdx, lips.length - 1)];
  // which lip are we heading to? advance once we're past it
  const ahead = (lip.pos.x - r.pos.x) * lip.dir.x + (lip.pos.z - r.pos.z) * lip.dir.z;
  if (r.state === 'GROUNDED' && ahead < -1 && lipIdx < lips.length) lipIdx++;
  const done = lipIdx >= lips.length;
  if (r.state === 'GROUNDED') {
    // aim at a point on the lip line, 2 m behind the lip so we hit the kicker square (or the finish)
    const back = Math.max(0, Math.min(ahead * 0.6, 14)); // pure pursuit along the kicker centre-line
    const tx = done ? world.finish!.pos.x : lip.pos.x - lip.dir.x * back;
    const tz = done ? world.finish!.pos.z : lip.pos.z - lip.dir.z * back;
    const want = Math.atan2(tx - r.pos.x, tz - r.pos.z);
    const err = Math.atan2(Math.sin(want - r.travelYaw), Math.cos(want - r.travelYaw));
    i.steer = Math.max(-1, Math.min(1, -err * 3));
    if (done || ahead > lip.length) i.pedal = 1;
    if (!done && ahead < lip.length && ahead > 0.4) i.pop = true;
  }
  if (r.state === 'AIRBORNE' && r.airTime > 0.05) {
    const k = tricks[(lipIdx - 1 + tricks.length) % tricks.length];
    const d = (x: number) => Math.abs(x) * 180 / Math.PI;
    if (k === 'spin' && d(r.spinAngle) < 335) i.steer = 1;
    if (k === 'flip' && r.flipAngle * 180 / Math.PI < 330) i.brake = 1;
    if (k === 'whip' && d(r.whipAngle) < 320) i.tailwhip = true;
    if (k === 'bar' && d(r.barAngle) < 320) i.barspin = 1;
  }
  prevState = r.state; prevSpeed = r.speed;
  r.step(dt, i);
}
console.log(out.join('\n'));
console.log(`\nbails: ${bails}, finished: ${finished}`);
process.exit(bails === 0 && finished ? 0 : 1);
