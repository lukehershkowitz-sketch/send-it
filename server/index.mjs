// SEND IT multiplayer server: park rooms with relayed rider states, and 1v1 "best line" duels.
// Plain Node ESM + ws, no build step:   node server/index.mjs      (PORT, default 8787)
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const PARKS = new Set(['dirtline', 'skatepark', 'plaza', 'mega', 'vert', 'proto']);
const MAX_PER_ROOM = 8;
const TICK_HZ = 15;
const MAX_STATE_LEN = 48;
const MAX_MSGS_PER_SEC = 60;
const HEX = /^#[0-9a-f]{6}$/i;
const CODE = /^[a-z0-9-]{0,12}$/;

/**
 * @param {{ port?: number, duelSeconds?: number, countdownMs?: number, graceMs?: number, inviteMs?: number, log?: boolean }} opts
 */
export function startServer(opts = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const DUEL_MS = (opts.duelSeconds ?? Number(process.env.DUEL_SECONDS ?? 60)) * 1000;
  const COUNTDOWN_MS = opts.countdownMs ?? 3500;
  const GRACE_MS = opts.graceMs ?? 5000; // lines still rolling at the buzzer may bank
  const INVITE_MS = opts.inviteMs ?? 15000;
  const log = opts.log ?? true;

  /** @type {Map<string, {key: string, park: string, code: string, players: Map<number, any>, duel: any}>} */
  const rooms = new Map();
  let nextId = 1;
  /** every connected player (in a room or not) */
  const all = new Set();

  const http = createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('SEND IT multiplayer server: connect with a WebSocket to /ws');
  });
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 8 * 1024 });

  const send = (p, msg) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); };
  const broadcast = (room, msg, except) => {
    const data = JSON.stringify(msg);
    for (const p of room.players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(data);
  };
  const info = (p) => ({ id: p.id, name: p.name, colors: p.colors });

  function leaveRoom(p) {
    const room = p.room;
    if (!room) return;
    room.players.delete(p.id);
    p.room = null;
    p.state = null;
    if (room.duel && (room.duel.a === p.id || room.duel.b === p.id)) {
      const other = room.duel.a === p.id ? room.duel.b : room.duel.a;
      if (room.duel.phase === 'invite') broadcast(room, { type: 'duel_cancel', reason: `${p.name} left` });
      else endDuel(room, other, `${p.name} left`);
      room.duel = null;
    }
    broadcast(room, { type: 'leave', id: p.id });
    if (room.players.size === 0) rooms.delete(room.key);
  }

  function joinRoom(p, park, code) {
    if (!PARKS.has(park)) return send(p, { type: 'error', message: 'Unknown park' });
    code = String(code ?? '').toLowerCase();
    if (!CODE.test(code)) return send(p, { type: 'error', message: 'Room codes are up to 12 letters, digits or dashes' });
    const key = `${park}:${code || 'public'}`;
    let room = rooms.get(key);
    if (!room) { room = { key, park, code: code || 'public', players: new Map(), duel: null }; rooms.set(key, room); }
    if (room === p.room) return;
    if (room.players.size >= MAX_PER_ROOM) return send(p, { type: 'error', message: 'Room is full (8 riders)' });
    leaveRoom(p);
    room.players.set(p.id, p);
    p.room = room;
    send(p, {
      type: 'welcome', id: p.id, park, code: room.code, serverTime: Date.now(),
      players: [...room.players.values()].filter((o) => o !== p).map(info),
      duel: room.duel && room.duel.phase !== 'invite' ? duelInfo(room.duel) : null,
    });
    broadcast(room, { type: 'join', player: info(p) }, p);
    if (log) console.log(`#${p.id} ${p.name} joined ${key} (${room.players.size})`);
  }

  const duelInfo = (d) => ({ a: d.a, b: d.b, startAt: d.startAt, endAt: d.endAt, scores: d.scores, phase: d.phase });

  function endDuel(room, forfeitWinner, reason) {
    const d = room.duel;
    if (!d) return;
    const sa = d.scores[d.a] ?? 0, sb = d.scores[d.b] ?? 0;
    const winner = forfeitWinner ?? (sa === sb ? null : sa > sb ? d.a : d.b);
    broadcast(room, { type: 'duel_end', a: d.a, b: d.b, scores: d.scores, winner, reason: reason ?? null });
    room.duel = null;
  }

  function handle(p, msg) {
    switch (msg.type) {
      case 'hello': {
        p.name = String(msg.name ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || `Rider ${p.id}`;
        const c = msg.colors ?? {};
        p.colors = Object.fromEntries(['frame', 'jersey', 'pants', 'helmet'].map((k) => [k, HEX.test(c[k]) ? c[k] : '#888888']));
        if (p.room) broadcast(p.room, { type: 'join', player: info(p) }, p); // name/colour update
        break;
      }
      case 'join': joinRoom(p, msg.park, msg.code); break;
      case 'leave': leaveRoom(p); break;
      case 'state': {
        const s = msg.s;
        if (!p.room || !Array.isArray(s) || s.length > MAX_STATE_LEN || !s.every((v) => typeof v === 'number' && Number.isFinite(v))) return;
        p.state = s;
        p.dirty = true;
        break;
      }
      case 'event': {
        if (!p.room) return;
        const kind = ['trick', 'bank', 'bail'].includes(msg.kind) ? msg.kind : null;
        if (!kind) return;
        const points = Number.isFinite(msg.points) ? Math.max(0, Math.min(1e7, Math.round(msg.points))) : 0;
        broadcast(p.room, { type: 'event', id: p.id, kind, text: String(msg.text ?? '').slice(0, 80), points }, p);
        break;
      }
      case 'duel_request': {
        const room = p.room;
        if (!room) return;
        if (room.duel) return send(p, { type: 'error', message: 'A 1v1 is already on in this room' });
        const others = [...room.players.values()].filter((o) => o !== p);
        const target = others.find((o) => o.id === msg.target) ?? others[0];
        if (!target) return send(p, { type: 'error', message: 'Nobody else is in the room yet' });
        room.duel = { a: p.id, b: target.id, phase: 'invite', expires: Date.now() + INVITE_MS, scores: { [p.id]: 0, [target.id]: 0 } };
        send(target, { type: 'duel_invite', from: p.id, name: p.name });
        send(p, { type: 'duel_pending', to: target.id, name: target.name });
        break;
      }
      case 'duel_reply': {
        const room = p.room, d = room?.duel;
        if (!d || d.phase !== 'invite' || d.b !== p.id) return;
        if (!msg.accept) { broadcast(room, { type: 'duel_cancel', reason: `${p.name} declined` }); room.duel = null; return; }
        d.phase = 'live';
        d.startAt = Date.now() + COUNTDOWN_MS;
        d.endAt = d.startAt + DUEL_MS;
        broadcast(room, { type: 'duel_start', ...duelInfo(d), serverTime: Date.now() });
        break;
      }
      case 'duel_line': {
        const room = p.room, d = room?.duel;
        if (!d || d.phase !== 'live' || (p.id !== d.a && p.id !== d.b)) return;
        const now = Date.now();
        if (now < d.startAt || now > d.endAt + GRACE_MS) return;
        const total = Number.isFinite(msg.total) ? Math.max(0, Math.min(1e7, Math.round(msg.total))) : 0;
        if (total > (d.scores[p.id] ?? 0)) {
          d.scores[p.id] = total;
          broadcast(room, { type: 'duel_score', id: p.id, best: total });
        }
        break;
      }
      case 'ping': send(p, { type: 'pong', t: msg.t, serverTime: Date.now() }); break;
    }
  }

  wss.on('connection', (ws) => {
    const p = { id: nextId++, ws, name: 'Rider', colors: {}, room: null, state: null, dirty: false, alive: true, budget: MAX_MSGS_PER_SEC };
    p.name = `Rider ${p.id}`;
    ws.on('pong', () => { p.alive = true; });
    ws.on('message', (data) => {
      if (--p.budget < 0) return; // rate limit
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg && typeof msg.type === 'string') handle(p, msg);
    });
    ws.on('close', () => { leaveRoom(p); all.delete(p); });
    ws.on('error', () => {});
    all.add(p);
    send(p, { type: 'hello', id: p.id, serverTime: Date.now() });
  });

  // state relay + duel timers
  const tick = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      const states = [];
      for (const p of room.players.values()) if (p.dirty && p.state) { states.push([p.id, p.state]); p.dirty = false; }
      if (states.length) broadcast(room, { type: 'states', t: now, p: states });
      const d = room.duel;
      if (d?.phase === 'invite' && now > d.expires) { broadcast(room, { type: 'duel_cancel', reason: 'Invite timed out' }); room.duel = null; }
      if (d?.phase === 'live' && now > d.endAt + GRACE_MS) endDuel(room);
    }
  }, 1000 / TICK_HZ);
  const budget = setInterval(() => { for (const p of all) p.budget = MAX_MSGS_PER_SEC; }, 1000);
  const heartbeat = setInterval(() => {
    for (const p of all) {
      if (!p.alive) { p.ws.terminate(); continue; }
      p.alive = false;
      p.ws.ping();
    }
  }, 15000);

  return new Promise((resolve) => {
    http.listen(port, () => {
      const actual = http.address().port;
      if (log) console.log(`SEND IT server on :${actual} (ws path /ws)`);
      resolve({
        port: actual,
        rooms,
        close: () => new Promise((r) => { clearInterval(tick); clearInterval(budget); clearInterval(heartbeat); for (const c of wss.clients) c.terminate(); wss.close(); http.close(() => r()); }),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) startServer();
