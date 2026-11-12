/**
 * Headless feel test: runs scripted rides through the real controller + park geometry
 * and prints where/how each run lands. `npm run sim`
 */
import { Emitter } from '../src/core/events';
import { emptyInput, type InputState } from '../src/core/input/actions';
import { RiderController } from '../src/rider/RiderController';
import type { RiderEvents } from '../src/rider/types';
import { World, type ParkDef } from '../src/world/World';
import { TUNING } from '../src/tuning';
import park from '../src/world/parks/proto.json';

type Script = (r: RiderController, t: number, inp: InputState) => void;
const world = new World(park as ParkDef);
const lip = world.lips[0];

function run(name: string, script: Script, maxT = 12) {
  const ev = new Emitter<RiderEvents>();
  const log: string[] = [];
  let maxH = 0, takeoffZ = 0, takeoffSpeed = 0;
  ev.on('pop', (p) => log.push(`pop ${p.label} ${p.strength.toFixed(2)}`));
  ev.on('takeoff', () => {});
  const r = new RiderController(world, ev);
  ev.on('takeoff', () => { takeoffZ = r.pos.z; takeoffSpeed = r.vel.length(); });
  let done = '';
  ev.on('landed', (l) => { if (l.airTime > 0.3) done ||= `LANDED ${l.stomped ? 'STOMPED' : 'CLEAN'} "${l.trick}" z=${r.pos.z.toFixed(1)} air=${l.airTime.toFixed(2)}s yawErr=${l.yawErr.toFixed(1)} pitchErr=${l.pitchErr.toFixed(1)} impact=${l.impact.toFixed(1)} speed→${r.speed.toFixed(1)}`; });
  ev.on('bail', (b) => { done ||= `BAIL "${b.reason}" z=${r.pos.z.toFixed(1)} ${b.landing ? `air=${b.landing.airTime.toFixed(2)} yawErr=${b.landing.yawErr.toFixed(1)} pitchErr=${b.landing.pitchErr.toFixed(1)} trick=${b.landing.trick}` : ''}`; });
  const dt = 1 / TUNING.physics.stepHz;
  for (let t = 0; t < maxT && !done; t += dt) {
    const inp = emptyInput();
    script(r, t, inp);
    r.step(dt, inp);
    if (r.state === 'AIRBORNE') maxH = Math.max(maxH, r.pos.y);
  }
  console.log(`${name.padEnd(28)} lip v=${takeoffSpeed.toFixed(1)} from z=${takeoffZ.toFixed(1)} apex=${maxH.toFixed(2)}m | ${log.join(', ')} | ${done || 'no landing'}`);
}

const distToLip = (r: RiderController) => lip.pos.z - r.pos.z;
const pedalTo = (speed: number): Script => (r, _t, i) => { if (r.state === 'GROUNDED' && r.pos.z < 0 && r.speed < speed) i.pedal = 1; };
const popAt = (d: number): Script => (r, _t, i) => { if (r.state === 'GROUNDED' && distToLip(r) < d + 2.5 && distToLip(r) > d) i.pop = true; };
const spinTo = (deg: number, dir = 1): Script => (r, _t, i) => { if (r.state === 'AIRBORNE' && r.airTime > 0.05 && Math.abs(r.spinAngle) * 180 / Math.PI < deg - 25) i.steer = dir; };
const flipTo = (deg: number): Script => (r, _t, i) => { if (r.state === 'AIRBORNE' && r.airTime > 0.05 && r.flipAngle * 180 / Math.PI < deg - 30) i.brake = 1; };
const all = (...s: Script[]): Script => (r, t, i) => s.forEach((f) => f(r, t, i));

console.log(`kicker lip z=${lip.pos.z.toFixed(2)} h=${lip.pos.y.toFixed(2)} len=${lip.length.toFixed(2)}`);
for (const v of [8, 10, 12]) {
  run(`roll off @${v}`, pedalTo(v));
  run(`perfect pop @${v}`, all(pedalTo(v), popAt(0.3)));
}
run('early pop @12', all(pedalTo(12), popAt(4)));
run('360 @12', all(pedalTo(12), popAt(0.3), spinTo(360)));
run('540 @12', all(pedalTo(12), popAt(0.3), spinTo(540)));
run('backflip @12', all(pedalTo(12), popAt(0.3), flipTo(360)));
run('360 held too long @12', all(pedalTo(12), popAt(0.3), spinTo(400)));
run('backflip under-rotated', all(pedalTo(12), popAt(0.3), flipTo(250)));
run('flat bunnyhop', (r, t, i) => { if (t < 2) i.pedal = 1; else if (t < 2.3) i.pop = true; }, 5);
run('ride into the rail', (r, t, i) => { if (t === 0) r.heading = r.travelYaw = Math.atan2(7, 29); i.pedal = 1; }, 8);
run('jump onto the rail', (r, t, i) => { if (t === 0) r.heading = r.travelYaw = Math.atan2(7, 29); i.pedal = 1; i.pop = r.pos.z > -14.5 && r.pos.z < -12; }, 8);
