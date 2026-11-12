/// <reference types="node" />
import { Emitter } from '../src/core/events';
import { emptyInput } from '../src/core/input/actions';
import { RiderController } from '../src/rider/RiderController';
import { bikePitch } from '../src/rider/aero';
import { World, type ParkDef } from '../src/world/World';
import { TUNING } from '../src/tuning';
const H = 3.4, R = 3.0, FLAT = 6, W = 10;
const world = new World({ name: 'pipe', spawn: { pos: [0, 0, -FLAT / 2], yaw: 0 }, pieces: [
  { type: 'ground', pos: [0, 0, 0], size: 200 },
  { type: 'quarter', pos: [0, 0, FLAT / 2], height: H, radius: R, angle: 90, width: W, deck: 2 },
  { type: 'quarter', pos: [0, 0, -FLAT / 2], yaw: 180, height: H, radius: R, angle: 90, width: W, deck: 2 },
] } as ParkDef);
const ev = new Emitter<any>(); const r = new RiderController(world, ev);
r.speed = Number(process.argv[2] ?? 11);
ev.on('bail', (b: any) => console.log('BAIL', b.reason, b.landing ? `pitch ${b.landing.pitchErr.toFixed(0)} roll ${b.landing.rollErr.toFixed(0)}` : ''));
ev.on('landed', (l: any) => console.log('LANDED', l.stomped ? 'STOMP' : 'clean', `pitch ${l.pitchErr.toFixed(1)} yaw ${l.yawErr.toFixed(1)} impact ${l.impact.toFixed(1)}`));
const dt = 1 / TUNING.physics.stepHz; let air0 = -1, next = 0;
for (let t = 0; t < 4; t += dt) {
  r.step(dt, emptyInput());
  if (r.state === 'AIRBORNE') {
    if (air0 < 0) { air0 = t; console.log(`takeoff vert=${r.vertAir} pos z=${r.pos.z.toFixed(2)} y=${r.pos.y.toFixed(2)} vel (${r.vel.x.toFixed(1)}, ${r.vel.y.toFixed(1)}, ${r.vel.z.toFixed(1)}) groundPitchRate ${r.groundPitchRate.toFixed(2)} frameUp ${r.rot.frameUp.toArray().map((v) => v.toFixed(1))}`); }
    if (t >= next) { next = t + 0.1; console.log(`  +${(t - air0).toFixed(2)} y ${r.pos.y.toFixed(2)} z ${r.pos.z.toFixed(2)} vy ${r.vel.y.toFixed(1)} nose(frame) ${(bikePitch(r.rot) * 57.3).toFixed(0)}° natural ${(r.naturalPitch * 57.3).toFixed(0)}° ωx ${r.rot.omegaB.x.toFixed(2)} predT ${r.predicted.valid ? r.predicted.time.toFixed(2) : '-'} calm ${r.assistCalm.toFixed(2)}`); }
  }
  if (r.state === 'BAILED' || (air0 > 0 && r.state === 'GROUNDED')) break;
}
