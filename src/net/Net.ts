import { Emitter } from '../core/events';
import type { DuelInfo, PlayerColors, PlayerInfo, ServerMsg } from './protocol';

export type NetStatus = 'offline' | 'connecting' | 'online' | 'error';

export interface NetEvents {
  status: NetStatus;
  message: ServerMsg;
}

/** Where to connect: build-time VITE_MP_URL, then the settings override, then this site's /ws. */
export function defaultServerUrl(override?: string): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_MP_URL;
  const raw = (override?.trim() || env || '').trim();
  if (raw) return /^wss?:\/\//.test(raw) ? raw : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${raw.replace(/^https?:\/\//, '')}`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

/** WebSocket client: room membership, roster, clock offset to the server. */
export class Net {
  readonly events = new Emitter<NetEvents>();
  status: NetStatus = 'offline';
  error = '';
  id = 0;
  room: { park: string; code: string } | null = null;
  players = new Map<number, PlayerInfo>();
  duel: DuelInfo | null = null;
  private ws: WebSocket | null = null;
  private offset = 0;
  private offsetSamples = 0;
  private pingTimer = 0;

  /** Server clock in ms, estimated. */
  serverNow(): number { return Date.now() + this.offset; }

  connect(url: string): Promise<void> {
    this.disconnect();
    this.setStatus('connecting');
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch (e) { this.fail(`Bad server address (${url})`); reject(e); return; }
      this.ws = ws;
      const timer = window.setTimeout(() => { if (this.status === 'connecting') { this.fail(`Couldn't reach ${url}`); ws.close(); reject(new Error('timeout')); } }, 6000);
      ws.onopen = () => {
        window.clearTimeout(timer);
        this.setStatus('online');
        this.pingTimer = window.setInterval(() => this.send({ type: 'ping', t: Date.now() }), 5000);
        resolve();
      };
      ws.onerror = () => { window.clearTimeout(timer); if (this.status === 'connecting') { this.fail(`Couldn't reach ${url}`); reject(new Error('connect failed')); } };
      ws.onclose = () => {
        window.clearInterval(this.pingTimer);
        if (this.ws !== ws) return;
        this.ws = null;
        this.room = null;
        this.players.clear();
        this.duel = null;
        if (this.status === 'online') this.fail('Disconnected from server');
      };
      ws.onmessage = (e) => {
        let msg: ServerMsg;
        try { msg = JSON.parse(String(e.data)) as ServerMsg; } catch { return; }
        this.receive(msg);
      };
    });
  }

  disconnect() {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    ws.close();
    window.clearInterval(this.pingTimer);
    this.room = null;
    this.players.clear();
    this.duel = null;
    this.setStatus('offline');
  }

  get online() { return this.status === 'online'; }

  private fail(msg: string) { this.error = msg; this.setStatus('error'); }
  private setStatus(s: NetStatus) { this.status = s; if (s !== 'error') this.error = ''; this.events.emit('status', s); }

  private clock(serverTime: number, rtt = 0) {
    const est = serverTime + rtt / 2 - Date.now();
    this.offset = this.offsetSamples++ === 0 ? est : this.offset + (est - this.offset) * 0.15;
  }

  private receive(m: ServerMsg) {
    switch (m.type) {
      case 'hello': this.id = m.id; this.clock(m.serverTime); break;
      case 'welcome':
        this.id = m.id;
        this.clock(m.serverTime);
        this.room = { park: m.park, code: m.code };
        this.players = new Map(m.players.map((p) => [p.id, p]));
        this.duel = m.duel;
        break;
      case 'join': this.players.set(m.player.id, m.player); break;
      case 'leave': this.players.delete(m.id); break;
      case 'pong': this.clock(m.serverTime, Date.now() - m.t); break;
      case 'duel_start': this.duel = { a: m.a, b: m.b, startAt: m.startAt, endAt: m.endAt, scores: m.scores, phase: m.phase }; this.clock(m.serverTime); break;
      case 'duel_score': if (this.duel) this.duel.scores[m.id] = m.best; break;
      case 'duel_end': case 'duel_cancel': this.duel = null; break;
      case 'error': this.error = m.message; break;
    }
    this.events.emit('message', m);
  }

  private send(msg: object) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }

  hello(name: string, colors: PlayerColors) { this.send({ type: 'hello', name, colors }); }
  join(park: string, code: string) { this.send({ type: 'join', park, code }); }
  leave() { this.send({ type: 'leave' }); this.room = null; this.players.clear(); this.duel = null; }
  sendState(s: number[]) { if (this.room) this.send({ type: 'state', s }); }
  sendEvent(kind: 'trick' | 'bank' | 'bail', text: string, points = 0) { if (this.room) this.send({ type: 'event', kind, text, points }); }
  duelRequest(target?: number) { this.send({ type: 'duel_request', target }); }
  duelReply(accept: boolean) { this.send({ type: 'duel_reply', accept }); }
  duelLine(total: number) { this.send({ type: 'duel_line', total }); }
}
