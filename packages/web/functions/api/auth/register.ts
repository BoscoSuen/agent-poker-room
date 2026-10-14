import { type Env, json, normEmail, isAllowed, hashPassword, makeSession, sessionCookie } from '../../_lib';
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body: any = await request.json().catch(() => ({}));
  const email = normEmail(body.email); const password = String(body.password ?? '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'bad_email' }, 400);
  if (!isAllowed(env, email)) return json({ error: 'not_allowed', message: 'This email is not on the whitelist.' }, 403);
  if (password.length < 10) return json({ error: 'weak_password', message: 'Password must be at least 10 characters.' }, 400);
  if (await env.DB.get(`user:${email}`)) return json({ error: 'exists', message: 'Account already exists. Log in instead.' }, 409);
  const rec = { email, ...(await hashPassword(password)), createdAt: Date.now() };
  await env.DB.put(`user:${email}`, JSON.stringify(rec));
  const token = await makeSession(env, email);
  return json({ ok: true, email }, 200, { 'set-cookie': sessionCookie(token) });
};
