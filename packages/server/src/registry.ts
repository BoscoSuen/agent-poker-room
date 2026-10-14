import { GameRuntime, parseTableConfig } from './runtime.js';
import { BotRunner } from './bots/runner.js';
import { openTunnel, type Tunnel } from './tunnel.js';
import { config } from './config.js';
import { log } from './log.js';

export interface Game { rt: GameRuntime; bots: BotRunner; tunnel: Tunnel | null; createdAt: number }

export const games = new Map<string, Game>();

export async function createGame(cfg: any, opts: { id?: string; ownerEmail?: string | null; tunnel?: boolean } = {}): Promise<Game> {
  const rt = new GameRuntime(parseTableConfig(cfg), opts.id);
  rt.ownerEmail = opts.ownerEmail ?? null;
  const bots = new BotRunner(rt);
  bots.start();
  const game: Game = { rt, bots, tunnel: null, createdAt: Date.now() };
  games.set(rt.id, game);
  const wantTunnel = opts.tunnel ?? (config.tunnel.enabled && !config.publicUrl);
  if (config.publicUrl) rt.publicUrl = config.publicUrl;
  else if (wantTunnel) {
    try { game.tunnel = await openTunnel(); rt.publicUrl = game.tunnel.url; }
    catch (e) { log('registry', 'tunnel failed', { e: String(e).slice(0, 300) }); games.delete(rt.id); throw e; }
  } else rt.publicUrl = `http://${config.host}:${config.port}`;
  rt.onClose = () => { bots.stop(); game.tunnel?.close(); setTimeout(() => games.delete(rt.id), 60_000); };
  log('registry', `game ${rt.id} created`, { url: rt.publicUrl, owner: rt.ownerEmail });
  return game;
}

/** Close tables that have been idle (no humans connected, no activity) for too long. */
export function reapIdle() {
  const now = Date.now();
  for (const g of games.values()) {
    if (g.rt.closed) continue;
    const humansConnected = g.rt.table.seats.some((s) => s.player?.kind === 'human' && s.connected);
    if (!humansConnected && now - g.rt.lastActivity > config.tunnel.idleCloseMs) {
      log('registry', `closing idle game ${g.rt.id}`);
      g.rt.close();
    }
  }
}
