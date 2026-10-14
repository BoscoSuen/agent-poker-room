import { type Env, json, engineOk, getGame, getPendingIds, removePendingIds } from '../_lib';
/** Engine polls this (outbound from the home server) to pick up tables to spin up. Uses get() only — KV list() is rate-limited. */
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!engineOk(env, request)) return json({ error: 'forbidden' }, 403);
  const ids = await getPendingIds(env);
  const out = []; const stale: string[] = [];
  for (const id of ids) {
    const g = await getGame(env, id);
    if (g && g.status === 'pending' && Date.now() - g.createdAt < 3600_000) out.push({ id: g.id, owner: g.owner, config: g.config, createdAt: g.createdAt });
    else stale.push(id);
  }
  if (stale.length) await removePendingIds(env, stale);
  return json(out);
};
