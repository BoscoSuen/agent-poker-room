import { config } from './config.js';
import { log } from './log.js';
import { createGame, games, restoreGames, type Game } from './registry.js';

/**
 * Outbound-only lobby sync with the Cloudflare Pages API:
 *  - poll /api/pending for games created by logged-in hosts, claim them, spawn a tunnel, report `live`
 *  - heartbeat each live game's summary every 30 s
 *  - report `closed` when a table closes
 */
export function startLobbySync() {
  if (!config.lobby.engineKey) { log('lobby', 'ENGINE_KEY not set; lobby sync disabled (use /admin/games)'); return; }
  const headers = { 'content-type': 'application/json', 'x-engine-key': config.lobby.engineKey };
  const api = (path: string, init: RequestInit = {}) => fetch(`${config.lobby.url}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  let busy = false;
  const poll = async () => {
    if (busy) return; busy = true;
    try {
      const res = await api('/api/pending');
      if (res.ok) {
        const list: any[] = await res.json();
        for (const g of list) {
          const existing = games.get(g.id);
          if (existing && !existing.rt.closed) continue;
          if (existing) games.delete(g.id);
          log('lobby', `claiming game ${g.id}`);
          try {
            const game = await createGame(g.config ?? {}, { id: g.id, ownerEmail: g.owner ?? null });
            await reportLive(game);
          } catch (e) {
            log('lobby', `failed to claim ${g.id}`, { e: String(e).slice(0, 300) });
            await api(`/api/games/${g.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'error', error: String(e).slice(0, 200) }) });
          }
        }
      } else if (res.status !== 404) log('lobby', `pending poll http ${res.status}`, { body: (await res.text()).slice(0, 160) });
    } catch (e) { log('lobby', 'poll error', { e: String(e).slice(0, 200) }); }
    finally { busy = false; }
  };
  const reportLive = async (game: Game) => {
    game.rt.onClose = ((orig) => () => { orig?.(); void api(`/api/games/${game.rt.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'closed' }) }); })(game.rt.onClose);
    await api(`/api/games/${game.rt.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'live', api: game.rt.publicUrl, hostKey: game.rt.hostKey, summary: game.rt.summary() }) });
  };
  void restoreGames(reportLive); // games are registered synchronously, so polling can start right away without double-claiming
  setInterval(poll, config.lobby.pollMs);
  void poll();
  log('lobby', `sync enabled against ${config.lobby.url}`);
}
