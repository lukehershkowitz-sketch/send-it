import type { RigSnapshot } from '../rider/RiderRig';

/** Colours as the server relays them. */
export interface PlayerColors { frame: string; jersey: string; pants: string; helmet: string }
export interface PlayerInfo { id: number; name: string; colors: PlayerColors }
export interface DuelInfo { a: number; b: number; startAt: number; endAt: number; scores: Record<number, number>; phase: string }

/** Messages from the server (see server/index.mjs). */
export type ServerMsg =
  | { type: 'hello'; id: number; serverTime: number }
  | { type: 'welcome'; id: number; park: string; code: string; serverTime: number; players: PlayerInfo[]; duel: DuelInfo | null }
  | { type: 'join'; player: PlayerInfo }
  | { type: 'leave'; id: number }
  | { type: 'states'; t: number; p: [number, number[]][] }
  | { type: 'event'; id: number; kind: 'trick' | 'bank' | 'bail'; text: string; points: number }
  | { type: 'duel_invite'; from: number; name: string }
  | { type: 'duel_pending'; to: number; name: string }
  | { type: 'duel_cancel'; reason: string }
  | ({ type: 'duel_start'; serverTime: number } & DuelInfo)
  | { type: 'duel_score'; id: number; best: number }
  | { type: 'duel_end'; a: number; b: number; scores: Record<number, number>; winner: number | null; reason: string | null }
  | { type: 'pong'; t: number; serverTime: number }
  | { type: 'error'; message: string };

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Pack a rider snapshot into ≤ 38 numbers (positions to 1 cm, rotations to 0.001). */
export function encodeSnapshot(s: RigSnapshot): number[] {
  const P = s.pose;
  const out = [
    r2(s.pos.x), r2(s.pos.y), r2(s.pos.z), r3(s.quat.x), r3(s.quat.y), r3(s.quat.z), r3(s.quat.w),
    r2(P.crouch), r2(P.wheelAngle % (Math.PI * 2)), r2(P.bar), r2(P.whip), r2(P.tuck), r2(P.superman), r2(P.cancan),
    r2(P.feetOff), r2(P.handsOff), r2(P.lean), r2(P.shiftX), r2(P.shiftZ), r2(P.table),
    r2(s.speed), r2(s.motionYaw), s.airborne ? 1 : 0, s.bailed ? 1 : 0,
  ];
  if (s.bailed) {
    out.push(r2(s.bikePos.x), r2(s.bikePos.y), r2(s.bikePos.z), r3(s.bikeQuat.x), r3(s.bikeQuat.y), r3(s.bikeQuat.z), r3(s.bikeQuat.w));
    out.push(r2(s.riderPos.x), r2(s.riderPos.y), r2(s.riderPos.z), r3(s.riderQuat.x), r3(s.riderQuat.y), r3(s.riderQuat.z), r3(s.riderQuat.w));
  }
  return out;
}

export function decodeSnapshot(a: number[], out: RigSnapshot): RigSnapshot {
  out.pos.set(a[0], a[1], a[2]);
  out.quat.set(a[3], a[4], a[5], a[6]).normalize();
  const P = out.pose;
  [P.crouch, P.wheelAngle, P.bar, P.whip, P.tuck, P.superman, P.cancan, P.feetOff, P.handsOff, P.lean, P.shiftX, P.shiftZ, P.table] = a.slice(7, 20);
  out.speed = a[20];
  out.motionYaw = a[21];
  out.airborne = a[22] === 1;
  out.bailed = a[23] === 1 && a.length >= 38;
  if (out.bailed) {
    out.bikePos.set(a[24], a[25], a[26]); out.bikeQuat.set(a[27], a[28], a[29], a[30]).normalize();
    out.riderPos.set(a[31], a[32], a[33]); out.riderQuat.set(a[34], a[35], a[36], a[37]).normalize();
  }
  return out;
}
