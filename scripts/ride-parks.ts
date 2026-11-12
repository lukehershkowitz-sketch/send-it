/// <reference types="node" />
/** Smoke-ride each Phase 4 park with a simple bot and print what happens. */
import { Emitter } from '../src/core/events';
import { emptyInput, type InputState } from '../src/core/input/actions';
import { RiderController } from '../src/rider/RiderController';
import type { RiderEvents } from '../src/rider/types';
import { World, type ParkDef } from '../src/world/World';
import { TUNING } from '../src/tuning';
import skatepark from '../src/world/parks/skatepark.json';
import plaza from '../src/world/parks/plaza.json';
import vert from '../src/world/parks/vert.json';
import mega from '../src/world/parks/mega.json';

type Script = (r: RiderController, t: number, i: InputState) => void;
let failures = 0;
function ride(name: string, def: unknown, script: Script, seconds: number, expect: (log: string[]) => boolean, setup?: (r: RiderController) => void) {
  const world = new World(def as ParkDef);
  const ev = new Emitter<RiderEvents>();
  const r = new RiderController(world, ev);
  setup?.(r);
  const log: string[] = [];
  ev.on('landed', (l) => { if (l.air.airTime > 0.25) log.push(`${l.stomped ? 'STOMP' : 'clean'} ${l.trick}${l.fakie ? ' (fakie)' : ''} ${l.air.airTime.toFixed(2)}s`); });
  ev.on('bail', (b) => log.push(`BAIL ${b.reason} @(${r.pos.x.toFixed(1)},${r.pos.y.toFixed(1)},${r.pos.z.toFixed(1)})`));
  ev.on('grindStart', (g) => log.push(`grind ${g.type}`));
  ev.on('finish', () => log.push('FINISH'));
  ev.on('takeoff', () => { if (r.vertAir) log.push('vert'); });
  for (let t = 0; t < seconds; t += 1 / TUNING.physics.stepHz) {
    const i = emptyInput();
    script(r, t, i);
    r.step(1 / TUNING.physics.stepHz, i);
  }
  const ok = expect(log);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(30)} ${log.join(' | ')}`);
}
const air = (r: RiderController) => r.state === 'AIRBORNE' && r.airTime > 0.05;
const deg = (x: number) => Math.abs(x) * 180 / Math.PI;
const noBail = (l: string[]) => !l.some((x) => x.startsWith('BAIL'));

// skatepark: roll over the box jump with a pop, then into the north quarter and air it
ride('skatepark: box jump → quarter', skatepark, (r, _t, i) => {
  if (r.state === 'GROUNDED') { if (r.speed < 9) i.pedal = 1; i.pop = r.pos.z > -7 && r.pos.z < -5.4; }
}, 6, (l) => noBail(l) && l.some((x) => x.includes('fakie')));
// skatepark: straight at the spine from the east, transfer over it
ride('skatepark: spine transfer', skatepark, (r, _t, i) => { if (r.state === 'GROUNDED' && r.speed < 10) i.pedal = 1; }, 3,
  (l) => noBail(l) && l.length > 0, (r) => { r.pos.set(-4, 0, 2); r.heading = r.travelYaw = -Math.PI / 2; r.speed = 10; });
// skatepark: carve through the bowl corner
ride('skatepark: bowl corner', skatepark, (r, _t, i) => { if (r.state === 'GROUNDED' && r.speed < 9) i.pedal = 1; }, 3,
  noBail, (r) => { r.pos.set(5, 0, 12); r.heading = r.travelYaw = Math.PI / 4; r.speed = 9; });
// plaza: roll off the platform over the gap onto the bank
ride('plaza: gap to bank', plaza, (r, _t, i) => { if (r.state === 'GROUNDED' && r.speed < 8) i.pedal = 1; }, 4,
  (l) => noBail(l) && l.length > 0);
// plaza: down the 8 stair
ride('plaza: 8 stair', plaza, (r, _t, i) => { if (r.state === 'GROUNDED' && r.speed < 7) i.pedal = 1; }, 4,
  (l) => noBail(l) && l.length > 0, (r) => { r.pos.set(-7, 1.4, -24); r.prevPos.copy(r.pos); });
// plaza: hop onto the handrail
ride('plaza: handrail', plaza, (r, _t, i) => {
  if (r.state === 'GROUNDED') { if (r.speed < 5) i.pedal = 1; i.pop = r.pos.z > -22.3 && r.pos.z < -21.2; }
  if (r.state === 'GRINDING') i.steer = Math.max(-1, Math.min(1, -r.balance * 3 - r.balanceVel));
}, 4, (l) => l.some((x) => x.startsWith('grind')), (r) => { r.pos.set(-9.8, 1.4, -25); r.prevPos.copy(r.pos); r.speed = 5; });
// vert: 20 s of 180s
ride('vert: 20 s of 180 airs', vert, (r, _t, i) => {
  i.pedal = r.state === 'AIRBORNE' ? 0 : 1;
  if (air(r) && deg(r.spinAngle) < 160) i.steer = 1;
}, 20, (l) => noBail(l) && l.filter((x) => x.includes('180')).length >= 5);
// mega: roll in, pop the kicker, 360, land; then the quarter; finish on the way back
ride('mega: drop, 360, quarter, finish', mega, (r, _t, i) => {
  const lip = (r.world.lips[0]);
  const d = lip.pos.z - r.pos.z;
  if (r.state === 'GROUNDED') { i.pop = d < 2.8 && d > 0.3; if (d < 0 && r.speed < 12) i.pedal = 1; }
  if (air(r) && !r.vertAir && r.pos.z < lip.pos.z + 30 && deg(r.spinAngle) < 335) i.steer = 1;
  if (air(r) && r.vertAir && deg(r.spinAngle) < 160) i.steer = -1;
}, 16, (l) => noBail(l) && l.includes('FINISH'));

console.log(failures ? `\n${failures} park check(s) failed` : '\nall park checks passed');
process.exit(failures ? 1 : 0);
