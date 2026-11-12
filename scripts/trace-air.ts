/// <reference types="node" />
/** Prints a timeline of one jump: nose elevation vs flight path, rotation rates, assist, rider body. */
import { Emitter } from '../src/core/events';
import { emptyInput, type InputState } from '../src/core/input/actions';
import { RiderController } from '../src/rider/RiderController';
import { bikePitch, bikeRoll } from '../src/rider/aero';
import type { RiderEvents } from '../src/rider/types';
import { World, type ParkDef } from '../src/world/World';
import { TUNING } from '../src/tuning';
import park from '../src/world/parks/proto.json';
import { flipPilot, popRelease, spinPilot } from './pilot';

const arg = process.argv.slice(2);
const speedTarget = Number(arg[0] ?? 12);
const trick = arg[1] ?? ''; // e.g. spin:360  flip:360
const world = new World(park as ParkDef);
const lip = world.lips[0];
const ev = new Emitter<RiderEvents>();
const r = new RiderController(world, ev);
ev.on('pop', (p) => console.log(`  pop ${p.label} applied ${p.strength.toFixed(2)} m/s (${(p.factor * 100).toFixed(0)}%)`));
ev.on('landed', (l) => console.log(`LANDED ${l.stomped ? 'STOMP' : 'clean'} "${l.trick}" air ${l.air.airTime.toFixed(2)}s yaw ${l.yawErr.toFixed(1)} pitch ${l.pitchErr.toFixed(1)} roll ${l.rollErr.toFixed(1)} impact ${l.impact.toFixed(1)} wheel ${l.wheelFirst} → speed ${r.speed.toFixed(1)}`));
ev.on('bail', (b) => console.log(`BAIL ${b.reason}${b.landing ? ` (pitch ${b.landing.pitchErr.toFixed(0)} roll ${b.landing.rollErr.toFixed(0)} yaw ${b.landing.yawErr.toFixed(0)})` : ''}`));
const dt = 1 / TUNING.physics.stepHz;
let airStart = -1, nextPrint = 0;
for (let t = 0; t < 7; t += dt) {
  const i: InputState = emptyInput();
  if (r.state === 'GROUNDED' && r.pos.z < 0) { if (r.speed < speedTarget) i.pedal = 1; }
  if (r.state === 'GROUNDED') popRelease(r, lip, i);
  if (r.state === 'AIRBORNE') { const [k, v] = trick.split(':'); if (k === 'spin') spinPilot(r, i, Number(v)); if (k === 'flip') flipPilot(r, i, Number(v)); }
  r.step(dt, i);
  if (r.state === 'AIRBORNE') {
    if (airStart < 0) { airStart = t; console.log(`takeoff at z=${r.pos.z.toFixed(2)} v=${r.vel.length().toFixed(2)} (vy ${r.vel.y.toFixed(2)}) ω0 pitch ${(-r.rot.omegaB.x).toFixed(2)}`); }
    if (t >= nextPrint) {
      nextPrint = t + 0.1;
      const vh = Math.hypot(r.vel.x, r.vel.z);
      console.log(`  t+${(t - airStart).toFixed(2)} y ${r.pos.y.toFixed(2)} nose ${(bikePitch(r.rot) * 57.3).toFixed(0)}° path ${(Math.atan2(r.vel.y, vh) * 57.3).toFixed(0)}° roll ${(bikeRoll(r.rot) * 57.3).toFixed(0)}° ωp ${(-r.rot.omegaB.x).toFixed(2)} spin ${(r.spinAngle * 57.3).toFixed(0)}° rate ${r.rot.omega.dot(r.rot.frameUp).toFixed(1)} flip ${(r.flipAngle * 57.3).toFixed(0)}° eff ${(r.flipEff * 57.3).toFixed(0)}° steer ${i.steer} brk ${i.brake} predT ${r.predicted.valid ? r.predicted.time.toFixed(2) : '-'} crouch ${r.body.crouch.toFixed(2)}`);
    }
  }
  if (r.state === 'GROUNDED' && airStart > 0 && t > airStart + 0.3) {
    let was = r.state as string;
    for (let k = 0; k < 360; k++) { r.step(dt, emptyInput()); if (r.state !== was) { console.log(`  after landing: ${was} → ${r.state} at z=${r.pos.z.toFixed(2)} y=${r.pos.y.toFixed(2)} speed ${r.speed.toFixed(1)} normal.y ${r.normal.y.toFixed(2)}`); was = r.state; } }
    break;
  }
  if (r.state === 'BAILED') break;
}
