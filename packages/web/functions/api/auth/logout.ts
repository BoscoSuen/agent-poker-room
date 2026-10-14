import { type Env, json, sessionCookie } from '../../_lib';
export const onRequestPost: PagesFunction<Env> = async () => json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
