import { GameRuntime, parseTableConfig } from './runtime.js';
import { BotRunner } from './bots/runner.js';
import { openTunnel, type Tunnel } from './tunnel.js';
import { config } from './config.js';
import { log } from './log.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Game { rt: GameRuntime; bots: BotRunner; tunnel: Tunnel | null; createdAt: number; cfgInput: any }

export const games = new Map<string, Game>();

interface Persisted { id: string; cfg: any; ownerEmail: string | null; createdAt: number }
const STATE_FILE = join(config.dataDir, 'games.json');
function readPersisted(): Persisted[] { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return []; } }
function persist() {
  const list: Persisted[] = [...games.values()].filter((g) => !g.rt.closed).map((g) => ({ id: g.rt.id, cfg: g.cfgInput, ownerEmail: g.rt.ownerEmail, createdAt: g.createdAt }));
  try { writeFileSync(STATE_FILE, JSON.stringify(list)); } catch (e) { log('registry', 'persist failed', { e: String(e) }); }
}
/** After a restart: re-create tables that were live (fresh state, new tunnel). Caller reports them to the lobby. */
export async function restoreGames(report: (g: Game) => Promise<void>) {
  const list = readPersisted().filter((p) => Date.now() - p.createdAt < 24 * 3600_000);
  for (const p of list) {
    try { const g = await createGame(p.cfg, { id: p.id, ownerEmail: p.ownerEmail }); g.createdAt = p.createdAt; await report(g); log('registry', `restored game ${p.id}`); }
    catch (e) { log('registry', `restore ${p.id} failed`, { e: String(e).slice(0, 200) }); }
  }
  persist();
}

export async function createGame(cfg: any, opts: { id?: string; ownerEmail?: string | null; tunnel?: boolean } = {}): Promise<Game> {
  const rt = new GameRuntime(parseTableConfig(cfg), opts.id);
  rt.ownerEmail = opts.ownerEmail ?? null;
  const bots = new BotRunner(rt);
  bots.start();
  const game: Game = { rt, bots, tunnel: null, createdAt: Date.now(), cfgInput: cfg };
  games.set(rt.id, game);
  const wantTunnel = opts.tunnel ?? (config.tunnel.enabled && !config.publicUrl);
  if (config.publicUrl) rt.publicUrl = config.publicUrl;
  else if (wantTunnel) {
    try { game.tunnel = await openTunnel(); rt.publicUrl = game.tunnel.url; }
    catch (e) { log('registry', 'tunnel failed', { e: String(e).slice(0, 300) }); games.delete(rt.id); throw e; }
  } else rt.publicUrl = `http://${config.host}:${config.port}`;
  rt.onClose = () => { bots.stop(); game.tunnel?.close(); persist(); setTimeout(() => games.delete(rt.id), 60_000); };
  persist();
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
