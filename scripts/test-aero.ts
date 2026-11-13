/// <reference types="node" />
/** Physics checks for the rotation model, with no world, ramps or assists. */
import { Quaternion, Vector3 } from 'three';
import { TUNING } from '../src/tuning';
import { classifyRotation, makeRot, mixAirInput, resetRot, stepRotation, type AirKeys, type RotInput, type RotState } from '../src/rider/aero';

const DT = 1 / TUNING.physics.stepHz;
const deg = (r: number) => (r * 180) / Math.PI;
let failures = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };
const fresh = () => { const rs = makeRot(); resetRot(rs, new Quaternion(), new Vector3(), new Vector3(0, 1, 0)); return rs; };
const none: RotInput = { yaw: 0, pitch: 0, roll: 0, brace: 0, tuck: 0 };
const run = (rs: RotState, t: number, inp: (time: number) => RotInput) => { for (let k = 0; k * DT < t; k++) stepRotation(rs, inp(k * DT), DT); };
const stats = (rs: RotState) => ({ spinDeg: deg(rs.spin), flipDeg: deg(rs.flip), rollDeg: deg(rs.roll), maxTiltDeg: deg(rs.maxTilt), maxRollDeg: deg(rs.maxRoll), tableTime: rs.tableTime });
const keys = (o: Partial<AirKeys>): AirKeys => ({ steer: 0, pedal: 0, brake: 0, flair: false, roll: false, lastDir: 1, ...o });

// 1. rotations build up smoothly (no instant snap) …
{
  const rs = fresh();
  run(rs, 0.05, () => ({ ...none, pitch: 1 }));
  check(deg(rs.flip) < 10 && rs.omega.length() < 2.2, `backflip builds up: after 50 ms only ${deg(rs.flip).toFixed(1)}° at ${rs.omega.length().toFixed(2)} rad/s`);
  run(rs, 0.6, () => ({ ...none, pitch: 1 }));
  check(rs.omega.length() > 0.8 * TUNING.rot.maxRate.pitch && rs.omega.length() <= TUNING.rot.maxRate.pitch + 0.2, `approaches the pitch limit without passing it (${rs.omega.length().toFixed(2)} rad/s, limit ${TUNING.rot.maxRate.pitch})`);
  // … and carries on after release
  const w0 = rs.omega.length();
  run(rs, 0.3, () => none);
  check(rs.omega.length() > 0.7 * w0, `momentum kept after release: ${w0.toFixed(2)} → ${rs.omega.length().toFixed(2)} rad/s in 0.3 s`);
  // counter-input stops it (time to bring it to rest)
  let stopT = 0;
  while (rs.omega.length() > 0.4 && stopT < 3) { stepRotation(rs, { ...none, pitch: -1 }, DT); stopT += DT; }
  check(stopT > 0.2 && stopT < 0.7, `counter-input stops a full-speed flip in ${stopT.toFixed(2)} s`);
}

// 2. conservation: tucking speeds a spin up, bracing slows it
{
  const a = fresh(), b = fresh(), c = fresh();
  for (const rs of [a, b, c]) run(rs, 0.5, () => ({ ...none, yaw: 1 }));
  const w0 = a.omega.length();
  run(a, 0.3, () => ({ ...none, tuck: 1 }));
  run(b, 0.3, () => ({ ...none, brace: 1 }));
  run(c, 0.3, () => none);
  check(a.omega.length() > c.omega.length() * 1.15, `tuck spins faster than neutral: ${a.omega.length().toFixed(2)} vs ${c.omega.length().toFixed(2)} rad/s`);
  check(b.omega.length() < c.omega.length() * 0.8, `brace slows rotation: ${b.omega.length().toFixed(2)} vs ${c.omega.length().toFixed(2)} rad/s (was ${w0.toFixed(2)})`);
}

// 3. axes interact: spin while flipping makes the rotation axis wander, so tilt and roll appear without any roll input
{
  const rs = fresh();
  run(rs, 1.2, () => ({ ...none, yaw: 1, pitch: 1 }));
  check(Math.abs(deg(rs.roll)) > 8, `gyroscopic coupling: ${deg(rs.roll).toFixed(0)}° of roll with no roll input`);
}

// 4. determinism: same inputs, same result
{
  const f = (t: number): RotInput => ({ ...none, yaw: Math.sin(t * 3), pitch: Math.cos(t * 2) });
  const a = fresh(), b = fresh();
  run(a, 1, f); run(b, 1, f);
  check(Math.abs(a.q.x - b.q.x) + Math.abs(a.q.y - b.q.y) + Math.abs(a.q.z - b.q.z) + Math.abs(a.q.w - b.q.w) < 1e-9, 'deterministic');
}

// 5. frame-rate independence of the integrator: 120 Hz vs 240 Hz agree closely
{
  const f = (t: number): RotInput => ({ ...none, yaw: 1, pitch: t < 0.4 ? 1 : 0 });
  const a = fresh(), b = fresh();
  for (let k = 0; k * DT < 0.9; k++) stepRotation(a, f(k * DT), DT);
  for (let k = 0; k * (DT / 2) < 0.9; k++) stepRotation(b, f(k * (DT / 2)), DT / 2);
  check(a.q.angleTo(b.q) < 0.1, `120 Hz vs 240 Hz orientation differs by ${deg(a.q.angleTo(b.q)).toFixed(2)}°`);
}

// 6. trick profiles produce the right names (named from the rotation, not the keys)
const trick = (name: string, k: Partial<AirKeys>, hold: number, expectKind: string, expectIncludes: string) => {
  const rs = fresh();
  const m = mixAirInput(keys(k));
  run(rs, hold, () => ({ ...none, ...m }));
  run(rs, 0.5, () => none); // coast
  const n = classifyRotation(stats(rs));
  const s = stats(rs);
  check(n.kind === expectKind && n.label.includes(expectIncludes), `${name.padEnd(22)} → ${n.label.padEnd(14)} [${n.kind}]  spin ${s.spinDeg.toFixed(0)}° flip ${s.flipDeg.toFixed(0)}° roll ${s.rollDeg.toFixed(0)}° maxTilt ${s.maxTiltDeg.toFixed(0)}°`);
};
trick('flat spin (hold A)', { steer: 1 }, 0.55, 'spin', '');
trick('backflip (hold S)', { brake: 1 }, 0.65, 'flip', 'BACKFLIP');
trick('frontflip (hold W)', { pedal: 1 }, 0.65, 'flip', 'FRONTFLIP');
trick('cork (↑ + D)', { flair: true, steer: 1 }, 1.0, 'cork', 'CORK');
trick('cork left (↑ + A)', { flair: true, steer: -1 }, 1.0, 'cork', 'CORK');
trick('rodeo (↑ + D + S)', { flair: true, steer: 1, brake: 1 }, 1.0, 'rodeo', 'RODEO');
trick('misty (↑ + D + W)', { flair: true, steer: 1, pedal: 1 }, 1.0, 'misty', 'MISTY');
trick('flair (↑)', { flair: true }, 0.75, 'flip', '');
trick('barrel roll (Shift + D)', { roll: true, steer: 1 }, 0.75, 'roll', 'BARREL');

console.log(failures ? `\n${failures} failure(s)` : '\nall rotation checks passed');
process.exit(failures ? 1 : 0);
