import { type Env, json, readSession } from '../../_lib';
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const s = await readSession(env, request);
  return json({ email: s?.email ?? null });
};
