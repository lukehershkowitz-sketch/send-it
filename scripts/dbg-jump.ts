/// <reference types="node" />
/** Ride one generated-style double at a given gap and print what happens. npx tsx scripts/dbg-jump.ts h a lh slope gap [spin] */
import { Emitter } from '../src/core/events';
import { emptyInput } from '../src/core/input/actions';
import { RiderController } from '../src/rider/RiderController';
import type { RiderEvents } from '../src/rider/types';
import { World, type ParkDef } from '../src/world/World';
import { kickerProfile } from '../src/world/pieces';
import { TUNING } from '../src/tuning';
import { popRelease, spinPilot } from './pilot';

const [h, a, lh, slope, gap, spin] = process.argv.slice(2).map(Number);
const kLen = kickerProfile(h, a).length;
const world = new World({
  name: 't', spawn: { pos: [0, 0, -28], yaw: 0 },
  pieces: [
    { type: 'ground', pos: [0, 0, 0], size: 300 },
    { type: 'kicker', pos: [0, 0, 0], height: h, angle: a, width: 3.6 },
    { type: 'landing', pos: [0, 0, kLen + gap], height: lh, slope, width: 5.6, deck: 0.3, knuckleRadius: 2, transitionRadius: 5 },
  ],
} as ParkDef);
const lip = world.lips[0];
const ev = new Emitter<RiderEvents>();
const r = new RiderController(world, ev);
let apex = 0, takeoffV = 0;
ev.on('takeoff', () => { takeoffV = r.vel.length(); });
ev.on('landed', (l) => console.log(`landed ${l.stomped ? 'STOMP' : 'clean'} at z=${r.pos.z.toFixed(1)} air ${l.air.airTime.toFixed(2)}s pitch ${l.pitchErr.toFixed(0)} yaw ${l.yawErr.toFixed(0)} impact ${l.impact.toFixed(1)} "${l.trick}"`));
ev.on('bail', (b) => console.log(`BAIL ${b.reason} at z=${r.pos.z.toFixed(1)} y=${r.pos.y.toFixed(1)}`));
const dt = 1 / TUNING.physics.stepHz;
for (let t = 0, done = false; t < 7 && !done; t += dt) {
  const i = emptyInput();
  if (r.state === 'GROUNDED' && r.pos.z < 0) i.pedal = 1;
  if (r.state === 'GROUNDED') popRelease(r, lip, i);
  if (r.state === 'AIRBORNE' && spin) spinPilot(r, i, spin);
  r.step(dt, i);
  if (r.state === 'AIRBORNE') apex = Math.max(apex, r.pos.y);
  if (r.state === 'BAILED' || (r.state === 'GROUNDED' && r.airTime > 0.3)) done = true;
}
console.log(`kicker ${kLen.toFixed(1)} m, lip at z=${lip.pos.z.toFixed(1)}, takeoff speed ${takeoffV.toFixed(1)}, apex ${apex.toFixed(1)} m, landing face z=${(kLen + gap).toFixed(1)}`);
