import { type Env, json, readSession, putGame, getGame, type GameRecord, addPendingId, addOwnerId, getOwnerIds } from '../../_lib';

const newId = () => { const b = crypto.getRandomValues(new Uint8Array(6)); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); };

/** Host creates a table: stored as pending; the engine polls /api/pending and claims it. */
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const s = await readSession(env, request);
  if (!s) return json({ error: 'unauthorized' }, 401);
  const body: any = await request.json().catch(() => ({}));
  const cfg = body.config && typeof body.config === 'object' ? body.config : {};
  const g: GameRecord = { id: newId(), owner: s.email, config: cfg, status: 'pending', createdAt: Date.now(), updatedAt: Date.now() };
  await putGame(env, g);
  await addPendingId(env, g.id);
  await addOwnerId(env, s.email, g.id);
  return json({ id: g.id, status: g.status });
};

/** List my tables. */
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const s = await readSession(env, request);
  if (!s) return json({ error: 'unauthorized' }, 401);
  const ids = await getOwnerIds(env, s.email);
  const games = (await Promise.all(ids.slice(-20).map((id) => getGame(env, id)))).filter(Boolean) as GameRecord[];
  games.sort((a, b) => b.createdAt - a.createdAt);
  return json(games.map((g) => ({ id: g.id, status: g.status, config: g.config, summary: g.summary, createdAt: g.createdAt })));
};
