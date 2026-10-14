import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { games } from './registry.js';
import { log } from './log.js';
import type { GameRuntime } from './runtime.js';

interface Client { ws: WebSocket; rt: GameRuntime; token: string | null; seatIdx: number | null; lastSent: string; alive: boolean }

export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/games\/([a-z0-9]+)\/ws$/);
    const game = m ? games.get(m[1]) : undefined;
    if (!game || game.rt.closed) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const token = url.searchParams.get('token');
      const st = token ? game.rt.resolve(token) : undefined;
      const client: Client = { ws, rt: game.rt, token: st ? token : null, seatIdx: st ? st.seatIdx : null, lastSent: '', alive: true };
      if (client.token) game.rt.setConnected(client.token, true);
      serve(client);
    });
  });
  // heartbeat
  setInterval(() => {
    for (const ws of wss.clients) {
      const c = (ws as any)._client as Client | undefined;
      if (!c) continue;
      if (!c.alive) { ws.terminate(); continue; }
      c.alive = false; ws.ping();
    }
  }, 15_000);
}

function serve(c: Client) {
  (c.ws as any)._client = c;
  const send = (obj: unknown) => { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(obj)); };
  const push = () => {
    const view = c.rt.view(c.seatIdx);
    const payload = { type: 'view', view, chat: c.rt.recentChat(30), hostKeyOk: undefined as undefined };
    const s = JSON.stringify(payload);
    if (s !== c.lastSent) { c.lastSent = s; send(payload); }
  };
  const unsub = c.rt.onChange(push);
  c.ws.on('pong', () => { c.alive = true; });
  c.ws.on('message', (data) => {
    let msg: any;
    try { msg = JSON.parse(String(data)); } catch { return; }
    try {
      switch (msg.type) {
        case 'act':
          if (!c.token) throw new Error('spectators cannot act');
          c.rt.act(c.token, msg.action, msg.amount, msg.decisionId);
          break;
        case 'chat': {
          const name = c.seatIdx !== null ? (c.rt.table.seats[c.seatIdx].player?.name ?? 'guest') : 'spectator';
          c.rt.say(name, c.seatIdx, String(msg.text ?? ''));
          break;
        }
        case 'sit_out': if (c.token) c.rt.sitOut(c.token, !!msg.sittingOut); break;
        case 'rebuy': if (c.token) c.rt.rebuy(c.token); break;
        case 'leave': if (c.token) { c.rt.leave(c.token); c.token = null; c.seatIdx = null; push(); } break;
        case 'ping': send({ type: 'pong', t: msg.t }); break;
      }
    } catch (e: any) {
      send({ type: 'error', code: e.code ?? 'error', message: e.message ?? String(e) });
      push();
    }
  });
  c.ws.on('close', () => { unsub(); if (c.token) c.rt.setConnected(c.token, false); });
  c.ws.on('error', (e) => log('ws', 'error', { e: String(e) }));
  push();
}
