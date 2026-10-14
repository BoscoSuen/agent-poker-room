import { type Env, json, readSession, getGame, putGame, publicGame, engineOk, removePendingIds, addPendingId } from '../../_lib';

export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
  const g = await getGame(env, String(params.id));
  if (!g) return json({ error: 'not_found' }, 404);
  const s = await readSession(env, request);
  return json(publicGame(g, !!s && s.email === g.owner));
};

/** Engine reports status (live/closed/error), or owner closes. */
export const onRequestPatch: PagesFunction<Env> = async ({ request, env, params }) => {
  const g = await getGame(env, String(params.id));
  if (!g) return json({ error: 'not_found' }, 404);
  const body: any = await request.json().catch(() => ({}));
  if (engineOk(env, request)) {
    if (body.status) g.status = body.status;
    if (body.api) g.api = String(body.api);
    if (body.hostKey) g.hostKey = String(body.hostKey);
    if (body.summary) g.summary = body.summary;
    if (body.error) g.error = String(body.error);
    g.updatedAt = Date.now();
    await putGame(env, g);
    if (g.status !== 'pending') await removePendingIds(env, [g.id]);
    return json({ ok: true });
  }
  const s = await readSession(env, request);
  if (s && s.email === g.owner && body.status === 'reopen') {
    g.status = 'pending'; g.api = undefined; g.hostKey = undefined; g.summary = undefined; g.error = undefined; g.updatedAt = Date.now(); g.createdAt = Date.now();
    await putGame(env, g); await addPendingId(env, g.id);
    return json({ ok: true, status: 'pending' });
  }
  if (s && s.email === g.owner && body.status === 'closed') {
    g.status = 'closed'; g.updatedAt = Date.now();
    await putGame(env, g); await removePendingIds(env, [g.id]);
    return json({ ok: true });
  }
  return json({ error: 'forbidden' }, 403);
};
