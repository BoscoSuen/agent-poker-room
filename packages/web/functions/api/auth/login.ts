import { type Env, json, normEmail, verifyPassword, makeSession, sessionCookie } from '../../_lib';
const MAX_FAILS = 10, LOCK_SEC = 15 * 60;
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body: any = await request.json().catch(() => ({}));
  const email = normEmail(body.email); const password = String(body.password ?? '');
  const failKey = `fail:${email}`;
  const fails = Number((await env.DB.get(failKey)) ?? 0);
  if (fails >= MAX_FAILS) return json({ error: 'locked', message: 'Too many attempts. Try again in 15 minutes.' }, 429);
  const rec = await env.DB.get<{ salt: string; hash: string }>(`user:${email}`, 'json');
  const ok = rec ? await verifyPassword(password, rec) : false;
  if (!ok) {
    await env.DB.put(failKey, String(fails + 1), { expirationTtl: LOCK_SEC });
    return json({ error: 'bad_credentials', message: 'Wrong email or password.' }, 401);
  }
  await env.DB.delete(failKey);
  const token = await makeSession(env, email);
  return json({ ok: true, email }, 200, { 'set-cookie': sessionCookie(token) });
};
