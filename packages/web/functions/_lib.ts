// Shared helpers for Pages Functions: KV, sessions (HMAC), password hashing (PBKDF2), whitelist.
export interface Env { DB: KVNamespace; SESSION_SECRET: string; ENGINE_KEY: string; ALLOWED_EMAILS?: string }
export type Ctx = EventContext<Env, string, Record<string, unknown>>;

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export const PBKDF2_ITER = 100_000; // Workers runtime caps PBKDF2 at 100k iterations
export async function hashPassword(password: string, salt?: Uint8Array): Promise<{ salt: string; hash: string; iter: number }> {
  const s = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: s as unknown as BufferSource, iterations: PBKDF2_ITER }, key, 256);
  return { salt: b64u(s), hash: b64u(bits), iter: PBKDF2_ITER };
}
export async function verifyPassword(password: string, rec: { salt: string; hash: string }): Promise<boolean> {
  const { hash } = await hashPassword(password, unb64u(rec.salt));
  if (hash.length !== rec.hash.length) return false;
  let diff = 0; for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ rec.hash.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
export const SESSION_DAYS = 30;
export async function makeSession(env: Env, email: string): Promise<string> {
  const payload = b64u(enc.encode(JSON.stringify({ email, exp: Date.now() + SESSION_DAYS * 86400_000 })));
  return `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
}
export async function readSession(env: Env, req: Request): Promise<{ email: string } | null> {
  const cookie = req.headers.get('cookie') ?? '';
  const m = cookie.match(/(?:^|;\s*)pg_session=([^;]+)/);
  if (!m || !env.SESSION_SECRET) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  if ((await hmac(env.SESSION_SECRET, payload)) !== sig) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64u(payload)));
    if (typeof p.email !== 'string' || p.exp < Date.now()) return null;
    return { email: p.email };
  } catch { return null; }
}
export const sessionCookie = (token: string, maxAge = SESSION_DAYS * 86400) =>
  `pg_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export const normEmail = (e: unknown) => String(e ?? '').trim().toLowerCase();
export const isAllowed = (env: Env, email: string) => (env.ALLOWED_EMAILS ?? '').split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean).includes(email);
export const engineOk = (env: Env, req: Request) => !!env.ENGINE_KEY && req.headers.get('x-engine-key') === env.ENGINE_KEY;

export const GAME_TTL = 24 * 3600;
export interface GameRecord {
  id: string; owner: string; config: Record<string, unknown>; status: 'pending' | 'live' | 'closed' | 'error';
  api?: string; hostKey?: string; summary?: Record<string, unknown>; error?: string; createdAt: number; updatedAt: number;
}
export const getGame = (env: Env, id: string) => env.DB.get<GameRecord>(`game:${id}`, 'json');
export const putGame = (env: Env, g: GameRecord) => env.DB.put(`game:${g.id}`, JSON.stringify(g), { expirationTtl: GAME_TTL });
export const publicGame = (g: GameRecord, owner: boolean) => ({
  id: g.id, status: g.status, api: g.api, config: g.config, summary: g.summary, error: g.error, createdAt: g.createdAt, updatedAt: g.updatedAt,
  owner: owner, hostKey: owner ? g.hostKey : undefined,
});

// ---- index keys (KV free tier: list() is capped at 1k/day, get() at 100k/day, put() at 1k/day; never use list()) ----
async function getIds(env: Env, key: string): Promise<string[]> {
  const v = await env.DB.get<string[]>(key, 'json');
  return Array.isArray(v) ? v : [];
}
async function setIds(env: Env, key: string, ids: string[], ttl = GAME_TTL) {
  await env.DB.put(key, JSON.stringify(ids.slice(-100)), { expirationTtl: ttl });
}
export const getPendingIds = (env: Env) => getIds(env, 'pending');
export const addPendingId = async (env: Env, id: string) => { const ids = await getPendingIds(env); if (!ids.includes(id)) await setIds(env, 'pending', [...ids, id], 3600); };
export const removePendingIds = async (env: Env, rm: string[]) => { const ids = await getPendingIds(env); const next = ids.filter((x) => !rm.includes(x)); if (next.length !== ids.length) await setIds(env, 'pending', next, 3600); };
export const getOwnerIds = (env: Env, email: string) => getIds(env, `owner:${email}`);
export const addOwnerId = async (env: Env, email: string, id: string) => { const ids = await getOwnerIds(env, email); await setIds(env, `owner:${email}`, [...ids.filter((x) => x !== id), id]); };
export const removeOwnerId = async (env: Env, email: string, id: string) => { const ids = await getOwnerIds(env, email); if (ids.includes(id)) await setIds(env, `owner:${email}`, ids.filter((x) => x !== id)); };
