import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { games, createGame } from './registry.js';
import { config } from './config.js';
import { stats } from './bots/runner.js';
import type { Persona } from '@pokergarden/engine';
import { gtoHint, type Hint } from './bots/gto.js';

const hintCache = new Map<string, Promise<Hint>>(); // decisionId -> hint (one LLM call per decision)

export const app = new Hono();
app.use('*', cors({ origin: (o) => o, credentials: false, allowHeaders: ['content-type', 'x-host-key', 'x-admin-key', 'authorization'] }));

app.get('/health', (c) => c.json({ ok: true, games: games.size, bots: { decisions: stats.decisions, fallbacks: stats.fallbacks } }));

const getGame = (id: string) => { const g = games.get(id); if (!g || g.rt.closed) return null; return g; };

// ----- admin (local CLI / tests) -----
app.post('/admin/games', async (c) => {
  if (config.adminKey && c.req.header('x-admin-key') !== config.adminKey) return c.json({ error: 'forbidden' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const g = await createGame(body.config ?? body, { tunnel: body.tunnel });
  return c.json({ id: g.rt.id, hostKey: g.rt.hostKey, url: g.rt.publicUrl });
});
app.get('/admin/games', (c) => {
  if (config.adminKey && c.req.header('x-admin-key') !== config.adminKey) return c.json({ error: 'forbidden' }, 403);
  return c.json([...games.values()].map((g) => ({ ...g.rt.summary(), url: g.rt.publicUrl, closed: g.rt.closed })));
});

// ----- public game info -----
app.get('/games/:id', (c) => {
  const g = getGame(c.req.param('id'));
  if (!g) return c.json({ error: 'not_found' }, 404);
  const s = g.rt.summary();
  const seats = g.rt.table.seats.map((x) => ({ idx: x.idx, name: x.player?.name ?? null, kind: x.player?.kind ?? null }));
  return c.json({ ...s, seats, config: { ...g.rt.table.config }, hostKeyOk: c.req.header('x-host-key') === g.rt.hostKey });
});

app.post('/games/:id/join', async (c) => {
  const g = getGame(c.req.param('id'));
  if (!g) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  try {
    const stack = body.stack ? Number(body.stack) : undefined;
    const st = g.rt.join(String(body.name ?? 'Player'), stack, 'human', undefined, body.seat !== undefined ? Number(body.seat) : undefined);
    return c.json({ token: st.token, seat: st.seatIdx });
  } catch (e: any) { return c.json({ error: e.code ?? 'error', message: e.message }, 400); }
});

/** Leave over HTTP so it works even when the websocket is mid-reconnect (iOS backgrounding). */
app.post('/games/:id/leave', async (c) => {
  const g = getGame(c.req.param('id'));
  if (!g) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const token = String(body.token ?? '');
  if (!g.rt.resolve(token)) return c.json({ error: 'bad_token', message: 'seat token not recognised' }, 400);
  g.rt.leave(token);
  return c.json({ ok: true });
});

/** GTO hint for the requesting seat, only on its own turn and only if the table allows hints. Uses only that seat's view. */
app.post('/games/:id/hint', async (c) => {
  const g = getGame(c.req.param('id'));
  if (!g) return c.json({ error: 'not_found' }, 404);
  if (!g.rt.table.config.hintsEnabled) return c.json({ error: 'disabled', message: 'Hints are off for this table.' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const st = g.rt.resolve(String(body.token ?? ''));
  if (!st) return c.json({ error: 'bad_token' }, 400);
  const v = g.rt.view(st.seatIdx);
  if (!v.hand || v.hand.actionOn !== st.seatIdx) return c.json({ error: 'not_your_turn' }, 400);
  const key = `${g.rt.id}:${v.hand.decisionId}`;
  let p = hintCache.get(key);
  if (!p) {
    p = gtoHint(v, AbortSignal.timeout(20_000));
    hintCache.set(key, p);
    p.catch(() => hintCache.delete(key));
    if (hintCache.size > 500) hintCache.delete(hintCache.keys().next().value!);
  }
  try { return c.json({ decisionId: v.hand.decisionId, ...(await p) }); }
  catch (e: any) { return c.json({ error: 'hint_failed', message: String(e.message ?? e).slice(0, 120) }, 502); }
});

app.get('/games/:id/view', (c) => {
  const g = getGame(c.req.param('id'));
  if (!g) return c.json({ error: 'not_found' }, 404);
  const token = c.req.query('token');
  const st = token ? g.rt.resolve(token) : undefined;
  return c.json({ view: g.rt.view(st ? st.seatIdx : null), chat: g.rt.recentChat(30) });
});

// ----- host controls -----
const host = new Hono();
host.use('*', async (c, next) => {
  const g = getGame(c.req.param('id')!);
  if (!g) return c.json({ error: 'not_found' }, 404);
  if (c.req.header('x-host-key') !== g.rt.hostKey) return c.json({ error: 'forbidden' }, 403);
  c.set('game' as never, g as never);
  await next();
});
host.post('/start', (c) => { const g = games.get(c.req.param('id')!)!; g.rt.start(); return c.json({ ok: true }); });
host.post('/pause', (c) => { const g = games.get(c.req.param('id')!)!; g.rt.pause(); return c.json({ ok: true }); });
host.post('/close', (c) => { const g = games.get(c.req.param('id')!)!; g.rt.reset(); return c.json({ ok: true }); });
host.post('/exit', (c) => { const g = games.get(c.req.param('id')!)!; g.rt.close(); return c.json({ ok: true }); });
host.post('/add_bot', async (c) => {
  const g = games.get(c.req.param('id')!)!;
  const body = await c.req.json().catch(() => ({}));
  const persona = (['default', 'aggressive', 'weak', 'gto'].includes(body.persona) ? body.persona : 'weak') as Persona;
  try { const st = g.rt.addBot(persona, body.seat !== undefined ? Number(body.seat) : undefined); return c.json({ seat: st.seatIdx }); }
  catch (e: any) { return c.json({ error: e.code ?? 'error', message: e.message }, 400); }
});
host.post('/shuffle', (c) => { const g = games.get(c.req.param('id')!)!; try { return c.json({ ok: true, ...g.rt.requestShuffle() }); } catch (e: any) { return c.json({ error: e.code ?? 'error', message: e.message }, 400); } });
host.post('/kick', async (c) => {
  const g = games.get(c.req.param('id')!)!;
  const body = await c.req.json().catch(() => ({}));
  g.rt.kick(Number(body.seat));
  return c.json({ ok: true });
});
host.post('/add_chips', async (c) => {
  const g = games.get(c.req.param('id')!)!;
  const body = await c.req.json().catch(() => ({}));
  try { g.rt.addChips(Number(body.seat), Number(body.amount)); return c.json({ ok: true }); }
  catch (e: any) { return c.json({ error: e.code ?? 'error', message: e.message }, 400); }
});
app.route('/games/:id/host', host);
