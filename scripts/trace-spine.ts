/// <reference types="node" />
import { Emitter } from '../src/core/events';
import { emptyInput } from '../src/core/input/actions';
import { RiderController } from '../src/rider/RiderController';
import { bikePitch } from '../src/rider/aero';
import { World, type ParkDef } from '../src/world/World';
import { TUNING } from '../src/tuning';
import skatepark from '../src/world/parks/skatepark.json';
const world = new World(skatepark as unknown as ParkDef);
const ev = new Emitter<any>(); const r = new RiderController(world, ev);
r.pos.set(-4, 0, 2); r.heading = r.travelYaw = -Math.PI / 2; r.speed = 10;
ev.on('bail', (b: any) => console.log('BAIL', b.reason, b.landing ? `pitch ${b.landing.pitchErr.toFixed(0)} roll ${b.landing.rollErr.toFixed(0)}` : ''));
ev.on('landed', (l: any) => console.log('LANDED', l.stomped ? 'STOMP' : 'clean', `pitch ${l.pitchErr.toFixed(1)} yaw ${l.yawErr.toFixed(1)}`));
const dt = 1 / TUNING.physics.stepHz; let air0 = -1, next = 0;
for (let t = 0; t < 4; t += dt) {
  const i = emptyInput(); if (r.state === 'GROUNDED' && r.speed < 10) i.pedal = 1;
  r.step(dt, i);
  if (r.state === 'AIRBORNE') {
    if (air0 < 0) { air0 = t; console.log(`takeoff vert=${r.vertAir} pos x=${r.pos.x.toFixed(2)} y=${r.pos.y.toFixed(2)} vel (${r.vel.x.toFixed(1)}, ${r.vel.y.toFixed(1)}) groundPitchRate ${r.groundPitchRate.toFixed(2)} normal.y ${r.normal.y.toFixed(2)}`); }
    if (t >= next) { next = t + 0.1; console.log(`  +${(t - air0).toFixed(2)} x ${r.pos.x.toFixed(2)} y ${r.pos.y.toFixed(2)} vy ${r.vel.y.toFixed(1)} nose ${(bikePitch(r.rot) * 57.3).toFixed(0)}° natural ${(r.naturalPitch * 57.3).toFixed(0)}° ωx ${r.rot.omegaB.x.toFixed(2)} predT ${r.predicted.valid ? r.predicted.time.toFixed(2) : '-'}`); }
  }
  if (r.state === 'BAILED' || (air0 > 0 && r.state === 'GROUNDED')) break;
}
