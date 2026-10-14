// Engine client: REST for join/host, WebSocket for live views. Reconnects with backoff.
import type { View, ActionType } from '@pokergarden/engine';
export type { View };
export interface ChatMsg { from: string; seat: number | null; text: string; ts: number; channel: 'table' | 'commentary' }
export interface EngineState { view: View | null; chat: ChatMsg[]; connected: boolean; error: string | null; reconnecting: boolean }

export class EngineClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  state: EngineState = { view: null, chat: [], connected: false, error: null, reconnecting: false };
  private listeners = new Set<(s: EngineState) => void>();
  constructor(public api: string, public gameId: string, public token: string | null) {}

  subscribe(fn: (s: EngineState) => void) { this.listeners.add(fn); fn(this.state); return () => this.listeners.delete(fn); }
  private set(p: Partial<EngineState>) { this.state = { ...this.state, ...p }; for (const l of this.listeners) l(this.state); }

  connect() {
    if (this.closed) return;
    const url = new URL(`${this.api.replace(/^http/, 'ws')}/games/${this.gameId}/ws`);
    if (this.token) url.searchParams.set('token', this.token);
    const ws = new WebSocket(url.toString());
    this.ws = ws;
    ws.onopen = () => { this.attempt = 0; this.set({ connected: true, reconnecting: false, error: null }); };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'view') this.set({ view: msg.view, chat: msg.chat ?? this.state.chat });
      else if (msg.type === 'error') this.set({ error: msg.message });
    };
    ws.onclose = () => {
      this.set({ connected: false });
      if (this.closed) return;
      this.set({ reconnecting: true });
      const delay = Math.min(8000, 500 * 2 ** this.attempt++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => { /* onclose follows */ };
  }
  close() { this.closed = true; this.ws?.close(); }
  send(obj: unknown) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
  act(action: ActionType, amount: number | undefined, decisionId: string) { this.send({ type: 'act', action, amount, decisionId }); }
  chat(text: string) { this.send({ type: 'chat', text }); }
  sitOut(v: boolean) { this.send({ type: 'sit_out', sittingOut: v }); }
  rebuy() { this.send({ type: 'rebuy' }); }
  leave() { this.send({ type: 'leave' }); }
  setToken(t: string | null) { this.token = t; this.ws?.close(); }
}

export async function engineJoin(api: string, gameId: string, name: string, stack?: number, seat?: number): Promise<{ token: string; seat: number }> {
  const res = await fetch(`${api}/games/${gameId}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, stack, seat }) });
  const data: any = await res.json();
  if (!res.ok) throw new Error(data.message ?? data.error ?? 'join failed');
  return data;
}
export async function engineInfo(api: string, gameId: string, hostKey?: string | null) {
  const res = await fetch(`${api}/games/${gameId}`, { headers: hostKey ? { 'x-host-key': hostKey } : {} });
  if (!res.ok) throw new Error(`engine ${res.status}`);
  return res.json();
}
export async function hostCall(api: string, gameId: string, hostKey: string, cmd: string, body: any = {}) {
  const res = await fetch(`${api}/games/${gameId}/host/${cmd}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-host-key': hostKey }, body: JSON.stringify(body) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? data.error ?? `host ${cmd} failed`);
  return data;
}
