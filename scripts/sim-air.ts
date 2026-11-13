/// <reference types="node" />
/**
 * Behaviour checks for the jumping + aerial physics (headless, real controller + real geometry).
 *   npx tsx scripts/sim-air.ts
 */
import { Emitter } from '../src/core/events';
import { emptyInput, type InputState } from '../src/core/input/actions';
import { RiderController } from '../src/rider/RiderController';
import { mixAirInput } from '../src/rider/aero';
import type { LandingResult, RiderEvents } from '../src/rider/types';
import { World, type ParkDef } from '../src/world/World';
import { kickerProfile } from '../src/world/pieces';
import { TUNING } from '../src/tuning';
import { DEG } from '../src/core/math';
import { popRelease } from './pilot';

const DT = 1 / TUNING.physics.stepHz;
let failures = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

// --------------------------------------------------------------------------- worlds
function kickerWorld(h: number, angle: number, gap: number, lh: number, slope = 25): { world: World; lipZ: number } {
  const kLen = kickerProfile(h, angle).length;
  const world = new World({
    name: 't', spawn: { pos: [0, 0, -20], yaw: 0 },
    pieces: [
      { type: 'ground', pos: [0, 0, 0], size: 400 },
      { type: 'kicker', pos: [0, 0, 0], height: h, angle, width: 3.6 },
      { type: 'landing', pos: [0, 0, kLen + gap], height: lh, slope, width: 6, deck: 0.3, knuckleRadius: 2, transitionRadius: 5 },
    ],
  } as ParkDef);
  return { world, lipZ: world.lips[0].pos.z };
}
const FLAT = new World({ name: 'flat', spawn: { pos: [0, 0, 0], yaw: 0 }, pieces: [{ type: 'ground', pos: [0, 0, 0], size: 400 }] } as ParkDef);

interface Run {
  r: RiderController; apex: number; airTime: number; takeoffVel: { vh: number; vy: number }; landed: LandingResult | null;
  bailed: string | null; landVh: number; minClear: number; log: string[]; popInfo: string;
}
type Pilot = (r: RiderController, t: number, i: InputState) => void;

function ride(world: World, opts: { speed: number; pilot?: Pilot; maxT?: number; setup?: (r: RiderController) => void; tail?: number }): Run {
  const ev = new Emitter<RiderEvents>();
  const r = new RiderController(world, ev);
  r.speed = opts.speed * 0.85; // start already rolling
  opts.setup?.(r);
  const run: Run = { r, apex: 0, airTime: 0, takeoffVel: { vh: 0, vy: 0 }, landed: null, bailed: null, landVh: 0, minClear: 99, log: [], popInfo: '' };
  let landedAt = -1, took = false;
  ev.on('takeoff', () => { if (!took) { took = true; run.takeoffVel = { vh: Math.hypot(r.vel.x, r.vel.z), vy: r.vel.y }; } });
  ev.on('pop', (p) => { run.popInfo = `${p.label} ${p.strength.toFixed(2)}`; });
  ev.on('landed', (l) => { if (!run.landed || l.air.airTime > 0.25) { run.landed = l; run.airTime = l.air.airTime; run.landVh = Math.hypot(r.vel.x, r.vel.z); landedAt = t; } });
  ev.on('bail', (b) => { run.bailed = b.reason; });
  let t = 0;
  for (; t < (opts.maxT ?? 8); t += DT) {
    const i = emptyInput();
    if (r.state === 'GROUNDED' && r.speed < opts.speed && r.pos.z < 0) i.pedal = 1;
    opts.pilot?.(r, t, i);
    r.step(DT, i);
    if (r.state === 'AIRBORNE') {
      run.apex = Math.max(run.apex, r.pos.y);
      const g = world.groundBelow(r.pos);
      if (g) run.minClear = Math.min(run.minClear, r.pos.y - g.point.y);
    }
    if (run.bailed) break;
    if (landedAt >= 0 && t > landedAt + (opts.tail ?? 0.5)) break;
  }
  return run;
}

/** Hold Space on the approach and release with `lead` metres to spare; `hold` forces a preload duration (s). */
const popPilot = (lipZ: number, opts: { lead?: number; tap?: boolean; hold?: number } = {}): Pilot => {
  let held = 0, done = false;
  return (r, _t, i) => {
    if (r.state !== 'GROUNDED' || done) return;
    const lip = r.world.lips[0];
    if (opts.tap) { const d = lipZ - r.pos.z; i.pop = d < 1.4 + 0.12 * r.speed && d > 1.35; return; }
    if (opts.hold !== undefined) {
      const d = lipZ - r.pos.z;
      if (d < 5 && held < opts.hold) { i.pop = true; held += DT; } else if (held >= opts.hold) { done = true; }
      return;
    }
    popRelease(r, lip, i, opts.lead ?? 0);
  };
};

// --------------------------------------------------------------------------- A. takeoff mechanics
console.log('— takeoff & jump characteristics');
{
  const { world, lipZ } = kickerWorld(2.0, 35, 3, 1.8);
  const apexAt = (v: number) => ride(world, { speed: v, pilot: popPilot(lipZ), maxT: 4, tail: 0.1 }).apex;
  const a9 = apexAt(8), a12 = apexAt(10), a14 = apexAt(12);
  check(a9 < a12 && a12 < a14, `apex rises with approach speed: ${a9.toFixed(2)} (8 m/s) < ${a12.toFixed(2)} (10) < ${a14.toFixed(2)} m (12)`);

  // preload quality: a tap pushes less than a full preload; sitting on it too long loses the energy
  const tap = ride(world, { speed: 12, pilot: popPilot(lipZ, { tap: true }), maxT: 4, tail: 0.1 });
  const full = ride(world, { speed: 12, pilot: popPilot(lipZ, { hold: 0.35 }), maxT: 4, tail: 0.1 });
  const stale = ride(world, { speed: 12, pilot: popPilot(lipZ, { hold: 1.4 }), maxT: 4, tail: 0.1 });
  check(tap.apex < full.apex - 0.15, `a tap gives less height than a full preload (${tap.apex.toFixed(2)} vs ${full.apex.toFixed(2)} m)`);
  check(stale.apex < full.apex - 0.1, `holding the preload too long loses energy (${stale.apex.toFixed(2)} vs ${full.apex.toFixed(2)} m)`);
  const rolled = ride(world, { speed: 12, maxT: 4, tail: 0.1 });
  check(rolled.apex < full.apex - 0.8, `the ramp gives most of the height; the push adds a bounded extra (${rolled.apex.toFixed(2)} → ${full.apex.toFixed(2)} m, no pop vs full pop)`);
  check(full.apex - rolled.apex < 2.2, `the push is not a free jump: it adds only ${(full.apex - rolled.apex).toFixed(2)} m`);

  // ramp shape changes the trajectory: a low ramp flies flatter and further, a steep one higher and shorter
  const lo = kickerWorld(1.2, 22, 3, 1.0), hi = kickerWorld(2.6, 42, 3, 2.2);
  const rl = ride(lo.world, { speed: 12, pilot: popPilot(lo.lipZ), maxT: 4, tail: 0.1 }), rh = ride(hi.world, { speed: 12, pilot: popPilot(hi.lipZ), maxT: 4, tail: 0.1 });
  check(rh.apex > rl.apex + 0.8 && rl.takeoffVel.vh > rh.takeoffVel.vh, `ramp shape: steep ramp ${rh.apex.toFixed(1)} m high / ${rh.takeoffVel.vh.toFixed(1)} m/s forward vs low ramp ${rl.apex.toFixed(1)} m / ${rl.takeoffVel.vh.toFixed(1)} m/s`);
}

// --------------------------------------------------------------------------- B. bunny hop vs ramp jump, momentum
console.log('— bunny hops, momentum');
{
  const hop = ride(FLAT, {
    speed: 9, maxT: 5, tail: 0.1,
    pilot: (r, t, i) => { if (r.state === 'GROUNDED') { i.pop = t > 1.2 && t < 1.55; } },
  });
  const { world, lipZ } = kickerWorld(2.4, 37, 3, 2.1);
  const big = ride(world, { speed: 12, pilot: popPilot(lipZ), maxT: 5, tail: 0.1 });
  check(hop.apex > 0.2 && hop.apex < 0.8 && hop.airTime < 0.65, `bunny hop is small and quick: ${hop.apex.toFixed(2)} m, ${hop.airTime.toFixed(2)} s`);
  check(big.apex > 3 && big.airTime > 0.8, `a big kicker gives real air: ${big.apex.toFixed(1)} m, ${big.airTime.toFixed(2)} s`);
  check(big.airTime > 1.8 * hop.airTime, `different airtimes, not one canned jump (${hop.airTime.toFixed(2)} s vs ${big.airTime.toFixed(2)} s)`);
  const keep = big.landVh / big.takeoffVel.vh;
  check(keep > 0.93 && keep < 1.02, `horizontal speed is kept through the air: ${big.takeoffVel.vh.toFixed(2)} → ${big.landVh.toFixed(2)} m/s (${(keep * 100).toFixed(0)}%)`);
}

// --------------------------------------------------------------------------- C. rotational momentum + weight shift
console.log('— rotation momentum, body-weight control at takeoff');
{
  const { world, lipZ } = kickerWorld(2.4, 37, 3, 2.1);
  let r1 = 0, r2 = 0, a1 = 0, a2 = 0;
  const m = ride(world, {
    speed: 12, maxT: 4.6, tail: 0,
    pilot: (r, t, i) => {
      popPilot(lipZ)(r, t, i);
      if (r.state === 'AIRBORNE') {
        if (r.airTime > 0.1 && r.airTime < 0.4) i.brake = 1;
        if (r.airTime >= 0.4 && r1 === 0) { r1 = -r.rot.omegaB.x; a1 = r.flipAngle; }
        if (r.airTime >= 0.7 && r2 === 0) { r2 = -r.rot.omegaB.x; a2 = r.flipAngle; }
      }
    },
  });
  void m;
  check(r1 > 3 && r2 > 0.75 * r1 && a2 > a1 + 0.8, `rotation carries on after the keys are released: ${r1.toFixed(1)} rad/s at release → ${r2.toFixed(1)} rad/s 0.3 s later (+${((a2 - a1) / DEG).toFixed(0)}° with no input)`);

  // weight shift while loaded: leaning back vs forward changes the rotation you leave the ramp with
  const lean = (dir: number) => ride(world, { speed: 12, maxT: 3, tail: 0, pilot: (r, t, i) => { popPilot(lipZ)(r, t, i); if (r.state === 'GROUNDED' && i.pop) { if (dir > 0) i.pedal = 1; else i.brake = 1; } } });
  const f = lean(1), b = lean(-1);
  check(f.r.flipAngle < b.r.flipAngle - 0.05 || f.r.flipEff < b.r.flipEff, `leaning back at the lip rotates you further back than leaning forward (${(b.r.flipEff / DEG).toFixed(0)}° vs ${(f.r.flipEff / DEG).toFixed(0)}° raw flip)`);
}

// --------------------------------------------------------------------------- D. recovery from a bad takeoff
console.log('— recovery and landing responses');
{
  const { world, lipZ } = kickerWorld(2.4, 37, 3, 2.1);
  const stray = ride(world, {
    speed: 12, maxT: 6, tail: 0.6,
    pilot: (r, t, i) => {
      popPilot(lipZ)(r, t, i);
      if (r.state === 'GROUNDED' && i.pop) i.pedal = 1; // lean forward hard at the lip → nose-down takeoff
    },
  });
  check(stray.landed !== null && !stray.bailed, `a nose-heavy takeoff is recovered by the light assist: ${stray.bailed ?? 'landed ' + (stray.landed?.stomped ? 'STOMP' : 'clean')}`);

  // wobble: an imperfect (but legal) landing settles instead of resetting
  const wob = ride(world, { speed: 12, maxT: 6, tail: 0, pilot: popPilot(lipZ, { lead: 0 }) });
  const r = wob.r;
  let peak = r.wobble.length();
  const samples: number[] = [];
  for (let k = 0; k < 120; k++) { r.step(DT, emptyInput()); peak = Math.max(peak, r.wobble.length()); if (k === 20) samples.push(r.wobble.length()); }
  check(wob.landed !== null && !wob.bailed, 'clean landing from a normal jump');
  const settled = r.wobble.length() / DEG;
  check(peak / DEG >= 0 && settled < 2, `landing wobble settles back onto the ground (peak ${(peak / DEG).toFixed(1)}° → ${settled.toFixed(2)}° after 1 s)`);
}

// --------------------------------------------------------------------------- E. fast rotation never tunnels through the ground
console.log('— collision reliability at fast rotation');
{
  let worst = 99, bails = 0, lands = 0;
  for (const [yaw, pitch, roll] of [[1, 1, 0], [-1, -1, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [1, 1, 1]]) {
    const { world, lipZ } = kickerWorld(2.4, 37, 2.5, 2.1);
    const run = ride(world, {
      speed: 13, maxT: 6, tail: 0.3,
      pilot: (r, t, i) => { popPilot(lipZ)(r, t, i); if (r.state === 'AIRBORNE') { i.steer = -yaw; i.roll = roll !== 0; if (roll) i.steer = roll; if (pitch > 0) i.brake = 1; if (pitch < 0) i.pedal = 1; } },
    });
    worst = Math.min(worst, run.minClear);
    if (run.bailed) bails++; if (run.landed) lands++;
    const g = run.r.world.groundBelow(run.r.pos);
    if (g && run.r.pos.y < g.point.y - 0.25) { worst = -1; }
  }
  check(worst > -0.12, `holding full torque on any axes into the ground: nothing passes through it (lowest clearance ${worst.toFixed(2)} m; ${bails} bails, ${lands} landings)`);
}

// --------------------------------------------------------------------------- F. off-axis tricks named from the real rotation (in the real game loop)
console.log('— cork / rodeo / misty / tabletop / roll in the game loop');
{
  const names = (keys: { steer?: number; pedal?: number; brake?: number; flair?: boolean; roll?: boolean; tabletop?: boolean }, hold: number) => {
    const { world, lipZ } = kickerWorld(3.0, 36, 10, 1.6);
    let best = '';
    ride(world, {
      speed: 17, maxT: 6, tail: 0,
      pilot: (r, t, i) => {
        popPilot(lipZ)(r, t, i);
        if (r.state === 'AIRBORNE') {
          if (r.airTime > 0.12 && r.airTime < 0.12 + hold) {
            const m = mixAirInput({ steer: keys.steer ?? 0, pedal: keys.pedal ?? 0, brake: keys.brake ?? 0, flair: !!keys.flair, roll: !!keys.roll, lastDir: 1 });
            // feed the same keys the player would press
            i.steer = keys.steer ?? 0; i.pedal = keys.pedal ?? 0; i.brake = keys.brake ?? 0; i.flair = !!keys.flair; i.roll = !!keys.roll; i.tabletop = !!keys.tabletop;
            void m;
          }
          const nm = r.describeAir(); if (process.env.DBG && Math.round(r.airTime*10)%2===0 && Math.abs(r.airTime*10-Math.round(r.airTime*10))<0.01) console.log(r.airTime.toFixed(2), nm);
          if (nm.length >= best.length && !/^(FAKIE )?(AIR|HOP)$/.test(nm)) { best = nm; }
        }
      },
    });
    return best;
  };
  const cork = names({ flair: true, steer: 1 }, 1.3);
  const rodeo = names({ flair: true, steer: 1, brake: 1 }, 1.3);
  const misty = names({ flair: true, steer: 1, pedal: 1 }, 1.3);
  const roll = names({ roll: true, steer: 1 }, 1.15);
  const table = names({ tabletop: true }, 0.8);
  const flat = names({ steer: 1 }, 0.9);
  check(/CORK/.test(cork), `↑ + D reads as a cork: "${cork}"`);
  check(/RODEO/.test(rodeo), `↑ + D + S reads as a rodeo: "${rodeo}"`);
  check(/MISTY/.test(misty), `↑ + D + W reads as a misty: "${misty}"`);
  check(/BARREL/.test(roll), `Shift + D reads as a barrel roll: "${roll}"`);
  check(/TABLETOP/.test(table), `T lays the bike over: "${table}"`);
  check(/^(FAKIE )?\d+$/.test(flat) || /^\d+/.test(flat), `D alone stays a flat spin: "${flat}"`);
}

console.log('— tabletop and recovery');
{
  const { world, lipZ } = kickerWorld(4.2, 45, 6, 3.3);
  const tt = ride(world, {
    speed: 12, maxT: 6, tail: 0.5,
    pilot: (r, t, i) => { popPilot(lipZ)(r, t, i); if (r.state === 'AIRBORNE' && r.airTime > 0.15 && r.airTime < 0.6) i.tabletop = true; },
  });
  const ll = tt.r.lastLanding;
  check(tt.landed !== null && !tt.bailed && /TABLETOP/.test(tt.landed.trick), `a tabletop let go of in time lands cleanly: ${tt.bailed ?? '"' + tt.landed?.trick + '" ' + (tt.landed?.stomped ? 'STOMP' : 'clean')}${ll ? ` (pitch ${ll.pitchErr.toFixed(0)}° roll ${ll.rollErr.toFixed(0)}° yaw ${ll.yawErr.toFixed(0)}° air ${ll.air.airTime.toFixed(2)} s, roll max ${ll.air.maxRollDeg.toFixed(0)}°)` : ''}`);
}

// --------------------------------------------------------------------------- G. determinism with a fixed step
console.log('— determinism');
{
  const go = () => { const { world, lipZ } = kickerWorld(2.4, 37, 3, 2.1); return ride(world, { speed: 12, maxT: 5, pilot: (r, t, i) => { popPilot(lipZ)(r, t, i); if (r.state === 'AIRBORNE' && r.airTime > 0.2 && r.airTime < 0.7) { i.steer = 1; i.brake = 0.5; } } }); };
  const a = go(), b = go();
  check(a.r.pos.distanceTo(b.r.pos) < 1e-9 && a.r.rot.q.angleTo(b.r.rot.q) < 1e-6, 'two identical runs end in exactly the same state');
}

console.log(failures ? `\n${failures} failure(s)` : '\nall aerial checks passed');
process.exit(failures ? 1 : 0);
