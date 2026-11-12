/**
 * Headless feel test: runs scripted rides through the real controller + park geometry
 * and prints where/how each run lands, plus what the combo system scores. `npm run sim`
 */
import { Emitter } from '../src/core/events';
import { emptyInput, type InputState } from '../src/core/input/actions';
import { RiderController } from '../src/rider/RiderController';
import type { RiderEvents } from '../src/rider/types';
import { World, type ParkDef } from '../src/world/World';
import { ComboTracker } from '../src/tricks/Combo';
import { TUNING } from '../src/tuning';
import { flipPilot, popRelease, spinPilot } from './pilot';
import park from '../src/world/parks/proto.json';

type Script = (r: RiderController, t: number, inp: InputState) => void;
const world = new World(park as ParkDef);
const lip = world.lips[0];
const combo = new ComboTracker(); // shared across runs so repetition shows up

function run(name: string, script: Script, opts: { maxT?: number; setup?: (r: RiderController) => void } = {}) {
  const ev = new Emitter<RiderEvents>();
  const log: string[] = [];
  let takeoffSpeed = 0;
  const r = new RiderController(world, ev);
  opts.setup?.(r);
  ev.on('pop', (p) => log.push(`pop ${p.label}`));
  ev.on('takeoff', () => { takeoffSpeed = r.vel.length(); });
  ev.on('grindStart', (g) => log.push(`grind ${g.type}`));
  ev.on('grindEnd', (g) => { log.push(`/grind ${g.time.toFixed(2)}s`); combo.addGrind(g.type, g.time); });
  ev.on('manualStart', (m) => log.push(m.nose ? 'nose manual' : 'manual'));
  ev.on('manualEnd', (m) => { log.push(`/manual ${m.time.toFixed(2)}s`); combo.addManual(m.nose, m.time); });
  let done = '';
  let banked = '';
  combo.events.on('banked', (b) => { banked ||= `BANKED ${b.total} (${b.entries.map((e) => `${e.name}=${Math.round(e.points)}${e.note ? ` [${e.note}]` : ''}`).join(', ')} ×${b.multiplier})`; });
  ev.on('landed', (l) => {
    combo.addAir(l.air, l.stomped);
    if (l.air.airTime > 0.3) log.push(`landed ${l.stomped ? 'STOMPED' : 'CLEAN'} "${l.trick}" air=${l.air.airTime.toFixed(2)}`);
  });
  ev.on('bail', (b) => { combo.lose(); done ||= `BAIL "${b.reason}"${b.landing ? ` "${b.landing.trick}" yaw=${b.landing.yawErr.toFixed(0)} pitch=${b.landing.pitchErr.toFixed(0)} whip=${b.landing.whipErr.toFixed(0)} bar=${b.landing.barErr.toFixed(0)}` : ''}`; });
  const dt = 1 / TUNING.physics.stepHz;
  for (let t = 0; t < (opts.maxT ?? 9) && !done && !banked; t += dt) {
    const inp = emptyInput();
    script(r, t, inp);
    r.step(dt, inp);
    combo.update(dt, r.state);
  }
  combo.bank();
  console.log(`${name.padEnd(26)} v=${takeoffSpeed.toFixed(1)} | ${log.join(', ')} | ${done || banked || 'nothing banked'}`);
}

const air = (r: RiderController) => r.state === 'AIRBORNE' && r.airTime > 0.05;
const deg = (rad: number) => Math.abs(rad) * 180 / Math.PI;
const pedalTo = (speed: number): Script => (r, _t, i) => { if (r.state === 'GROUNDED' && r.pos.z < 0 && r.speed < speed) i.pedal = 1; };
const popLip: Script = (r, _t, i) => { if (r.state === 'GROUNDED') popRelease(r, lip, i); };
const spinTo = (d: number, dir = 1): Script => (r, _t, i) => { if (air(r)) spinPilot(r, i, dir * d); };
const flipTo = (d: number): Script => (r, _t, i) => { if (air(r)) flipPilot(r, i, d); };
const whipTo = (d: number): Script => (r, _t, i) => { if (air(r) && deg(r.whipAngle) < d - 40) i.tailwhip = true; };
const barTo = (d: number, startAfter = 0): Script => (r, _t, i) => { if (air(r) && r.airTime > startAfter && deg(r.barAngle) < d - 40) i.barspin = 1; };
const hold = (k: 'tuck' | 'superman' | 'cancan', from: number, to: number): Script => (r, _t, i) => { if (air(r) && r.airTime > from && r.airTime < to) i[k] = true; };
const all = (...s: Script[]): Script => (r, t, i) => s.forEach((f) => f(r, t, i));
const jump = (...s: Script[]) => all(pedalTo(12), popLip, ...s);

console.log('--- approach speeds (each should land)');
for (const v of [10, 11, 12]) {
  run(`perfect pop @${v} + ${v < 12 ? 180 : 360}`, all(pedalTo(v), popLip, spinTo(v < 12 ? 180 : 360)));
  run(`coast from z=-1 @${v} + superman`, all((r, _t, i) => { if (r.state === 'GROUNDED' && r.pos.z < -1 && r.speed < v) i.pedal = 1; }, popLip, hold('superman', 0.1, 0.55)));
}
console.log('--- airs');
run('straight air', jump());
run('360', jump(spinTo(360)));
run('360 again (repeat)', jump(spinTo(360)));
run('360 other way (fresh)', jump(spinTo(360, -1)));
run('backflip', jump(flipTo(360)));
run('flair (button)', jump((r, _t, i) => { if (air(r) && r.flipEff * 180 / Math.PI < 95 && !(r.predicted.valid && r.predicted.time < 0.4)) i.flair = true; }));
run('tailwhip', jump(whipTo(360)));
run('double whip', jump(whipTo(720)));
run('whip to bar', all(jump(whipTo(360)), (r, t, i) => { if (air(r) && r.whipsDone >= 1 && deg(r.barAngle) < 320) i.barspin = 1; }));
run('barspin', jump(barTo(360)));
run('superman 0.7s', jump(hold('superman', 0.1, 0.8)));
run('tuck held into landing', jump(hold('tuck', 0.1, 9)));
run('can-can too short', jump(hold('cancan', 0.1, 0.25)));
run('whip unfinished', jump((r, _t, i) => { if (air(r) && deg(r.whipAngle) < 170) i.tailwhip = true; }));
run('backflip + tailwhip', jump(flipTo(360), (r, t, i) => { if (air(r) && r.airTime > 0.15 && deg(r.whipAngle) < 320) i.tailwhip = true; }));

console.log('--- grinds (start lined up with the rail at x=7)');
const onRailLine = (r: RiderController) => { r.pos.set(7, 0, -30); r.prevPos.copy(r.pos); };
const hopAt = (z0: number, z1: number): Script => (r, _t, i) => { if (r.state === 'GROUNDED') i.pop = r.pos.z > z0 && r.pos.z < z1; };
const pedalUntil = (z: number, v = 7): Script => (r, _t, i) => { if (r.state === 'GROUNDED' && r.pos.z < z && r.speed < v) i.pedal = 1; };
const balance: Script = (r, _t, i) => { if (r.state === 'GRINDING') i.steer = Math.max(-1, Math.min(1, -r.balance * 3 - r.balanceVel * 1.2)); };
run('hop onto rail, balanced', all(pedalUntil(-19.5), hopAt(-18.4, -16.7), balance), { setup: onRailLine });
run('hop onto rail, no balance', all(pedalUntil(-19.5), hopAt(-18.4, -16.7)), { setup: onRailLine });
run('rail, angled entry', all(pedalUntil(-19.5), hopAt(-18.4, -16.7), balance), { setup: (r) => { r.pos.set(6.2, 0, -30); r.heading = r.travelYaw = 0.06; r.prevPos.copy(r.pos); } });
run('rail, pop off', all(pedalUntil(-19.5), hopAt(-18.4, -16.7), balance,
  (r, _t, i) => { if (r.state === 'GRINDING') i.pop = r.railT > 0.6 && r.railT < 0.75; },
  (r, _t, i) => { if (r.state === 'GROUNDED' && r.pos.z > -12.5) i.steer = 1; }, // roll away from the end of the rail
), { setup: onRailLine, maxT: 12 });
const angled = (r: RiderController) => { r.pos.set(4.2, 0, -21); r.heading = r.travelYaw = 0.3; r.prevPos.copy(r.pos); };
const hopX = (x: number): Script => (r, _t, i) => { if (r.state === 'GROUNDED') { i.pop = r.pos.x > x - 1 && r.pos.x < x; if (r.speed < 6) i.pedal = 1; } };
run('angled → feeble', all(hopX(6.2), balance), { setup: angled });
run('angled + turn → smith', all(hopX(6.2), balance, (r, _t, i) => { if (air(r) && r.airTime < 0.25) i.steer = 1; }), { setup: angled });
run('pull up (S) → icepick', all(pedalUntil(-19.5), hopAt(-18.4, -16.7), balance, (r, _t, i) => { if (air(r) && !r.fromGrind) i.brake = 1; }), { setup: onRailLine });
run('rail sideways → bail', all(hopX(6.4)), { setup: (r) => { r.pos.set(1, 0, -10.5); r.heading = r.travelYaw = Math.PI / 2; r.prevPos.copy(r.pos); } });
run('ledge', all(pedalUntil(-26, 6.5), hopAt(-27.4, -25.6), balance), { setup: (r) => { r.pos.set(-6.65, 0, -40); r.prevPos.copy(r.pos); } });

console.log('--- manuals');
const manualBal = (nose: boolean): Script => (r, _t, i) => {
  if (r.state !== 'MANUALING') return;
  const c = -r.balance * 3 - r.balanceVel * 1.2; // + = needs push toward +balance
  if (nose) { if (c > 0) i.pedal = Math.min(1, c); else i.brake = Math.min(1, -c); }
  else { if (c > 0) i.brake = Math.min(1, c); else i.pedal = Math.min(1, -c); }
};
run('manual 2s', all((r, t, i) => { if (t < 2) i.pedal = 1; i.manual = t > 2.1 && t < 4.1; }, manualBal(false)), { maxT: 8 });
run('nose manual 1.5s', all((r, t, i) => { if (t < 2) i.pedal = 1; i.manual = t > 2.1 && t < 3.6; i.brake = t > 2.1 && t < 2.2 ? 1 : 0; }, manualBal(true)), { maxT: 8 });
run('manual unbalanced', (r, t, i) => { if (t < 2) i.pedal = 1; i.manual = t > 2.1; }, { maxT: 8 });
run('jump into manual', all(jump(spinTo(360)), (r, _t, i) => { i.manual = r.state === 'AIRBORNE' ? r.airTime > 1.0 : r.state === 'MANUALING' ? r.manualTime < 1.2 : false; }, manualBal(false)));
