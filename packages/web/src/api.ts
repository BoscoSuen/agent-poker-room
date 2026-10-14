// Lobby API (Cloudflare Pages Functions, same origin). Cookies carry the session.
export interface GameInfo { id: string; status: 'pending' | 'live' | 'closed' | 'error'; api?: string; config: any; summary?: any; error?: string; owner?: boolean; hostKey?: string; createdAt: number }

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, credentials: 'same-origin' });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message ?? data.error ?? `HTTP ${res.status}`), { code: data.error, status: res.status });
  return data as T;
}
export const api = {
  me: () => req<{ email: string | null }>('/api/auth/me'),
  login: (email: string, password: string) => req<{ email: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (email: string, password: string) => req<{ email: string }>('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => req('/api/auth/logout', { method: 'POST' }),
  createGame: (config: any) => req<{ id: string }>('/api/games', { method: 'POST', body: JSON.stringify({ config }) }),
  myGames: () => req<GameInfo[]>('/api/games'),
  game: (id: string) => req<GameInfo>(`/api/games/${id}`),
  reopenGame: (id: string) => req(`/api/games/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'reopen' }) }),
  closeGame: (id: string) => req(`/api/games/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'closed' }) }),
};
