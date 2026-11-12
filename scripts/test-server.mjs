// End-to-end protocol test: two clients join a room, see each other's states, play a short duel.
//   node scripts/test-server.mjs
import WebSocket from 'ws';
import { startServer } from '../server/index.mjs';

const srv = await startServer({ port: 0, duelSeconds: 1.5, countdownMs: 300, graceMs: 300, log: false });
const url = `ws://localhost:${srv.port}/ws`;
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

function client(name) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const c = {
    ws, inbox, name,
    send: (m) => ws.send(JSON.stringify(m)),
    wait: (pred, ms = 3000) => new Promise((resolve, reject) => {
      const hit = inbox.find(pred);
      if (hit) return resolve(hit);
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error(`${name}: timed out waiting`)), ms);
    }),
    open: () => new Promise((r) => ws.on('open', r)),
  };
  return c;
}

try {
  const a = client('A'), b = client('B');
  await Promise.all([a.open(), b.open()]);
  a.send({ type: 'hello', name: 'Alex<script>', colors: { frame: '#ff0000', jersey: 'bad', pants: '#00ff00', helmet: '#0000ff' } });
  b.send({ type: 'hello', name: 'Bo', colors: {} });
  a.send({ type: 'join', park: 'dirtline', code: 'crew1' });
  const wa = await a.wait((m) => m.type === 'welcome');
  check(wa.players.length === 0 && wa.code === 'crew1', 'A joins empty room crew1');
  b.send({ type: 'join', park: 'dirtline', code: 'crew1' });
  const wb = await b.wait((m) => m.type === 'welcome');
  check(wb.players.length === 1 && wb.players[0].name === 'Alexscript', 'B sees A (name sanitised)');
  check(wb.players[0].colors.jersey === '#888888' && wb.players[0].colors.frame === '#ff0000', 'invalid colours replaced');
  const ja = await a.wait((m) => m.type === 'join');
  check(ja.player.name === 'Bo', 'A is told B joined');

  // states relay
  a.send({ type: 'state', s: [1, 2, 3, 0, 0, 0, 1] });
  const st = await b.wait((m) => m.type === 'states' && m.p.some(([id]) => id === wa.id));
  check(st.p.find(([id]) => id === wa.id)[1][0] === 1, 'B receives A state');
  a.send({ type: 'state', s: [1, 'x'] }); // invalid: ignored
  a.send({ type: 'state', s: new Array(100).fill(0) }); // too long: ignored

  // events
  a.send({ type: 'event', kind: 'bank', text: '360 BACKFLIP', points: 1234.6 });
  const ev = await b.wait((m) => m.type === 'event');
  check(ev.kind === 'bank' && ev.points === 1235 && ev.id === wa.id, 'event relayed');

  // other parks / codes are separate rooms
  const c = client('C'); await c.open();
  c.send({ type: 'join', park: 'dirtline', code: '' });
  const wc = await c.wait((m) => m.type === 'welcome');
  check(wc.code === 'public' && wc.players.length === 0, 'public room is separate');
  c.send({ type: 'join', park: 'nowhere' });
  check((await c.wait((m) => m.type === 'error')).message === 'Unknown park', 'unknown park rejected');

  // duel
  a.send({ type: 'duel_request' });
  const inv = await b.wait((m) => m.type === 'duel_invite');
  check(inv.from === wa.id, 'B invited by A');
  b.send({ type: 'duel_reply', accept: true });
  const ds = await a.wait((m) => m.type === 'duel_start');
  check(ds.endAt - ds.startAt === 1500, 'duel starts with server timing');
  a.send({ type: 'duel_line', total: 500 }); // before start: ignored
  await new Promise((r) => setTimeout(r, 350));
  a.send({ type: 'duel_line', total: 1200 });
  b.send({ type: 'duel_line', total: 900 });
  a.send({ type: 'duel_line', total: 800 }); // lower: doesn't replace best
  const end = await b.wait((m) => m.type === 'duel_end', 5000);
  check(end.scores[wa.id] === 1200 && end.scores[wb.id] === 900 && end.winner === wa.id, `duel result A 1200 vs B 900, A wins`);

  // leaving
  b.ws.close();
  const lv = await a.wait((m) => m.type === 'leave');
  check(lv.id === wb.id, 'A told B left');
  a.ws.close(); c.ws.close();
} catch (e) {
  console.log('FAIL', e.message);
  failures++;
}
await srv.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall server checks passed');
process.exit(failures ? 1 : 0);
