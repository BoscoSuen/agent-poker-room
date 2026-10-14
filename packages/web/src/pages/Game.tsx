import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type GameInfo } from '../api';
import { EngineClient, type EngineState } from '../engine';
import { TableUI } from '../components/Table';

const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export function Game({ id }: { id: string }) {
  const [info, setInfo] = useState<GameInfo | null>(null);
  const [err, setErr] = useState('');
  const [hostKey, setHostKey] = useState<string | null>(ls.get(`pg:${id}:host`));
  const [token, setToken] = useState<string | null>(ls.get(`pg:${id}:token`));
  const [es, setEs] = useState<EngineState | null>(null);
  const clientRef = useRef<EngineClient | null>(null);

  // 1. resolve the engine URL (direct ?api= for local dev, else via the lobby)
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get('api')) { setInfo({ id, status: 'live', api: q.get('api')!, config: {}, createdAt: Date.now() }); if (q.get('host')) { setHostKey(q.get('host')); ls.set(`pg:${id}:host`, q.get('host')); } return; }
    let stop = false;
    const tick = async () => {
      try {
        const g = await api.game(id);
        if (stop) return;
        setInfo(g);
        if (g.hostKey) { setHostKey(g.hostKey); ls.set(`pg:${id}:host`, g.hostKey); }
        if (g.status === 'pending') setTimeout(tick, 2000);
      } catch (e: any) { if (!stop) setErr(e.message); }
    };
    tick();
    return () => { stop = true; };
  }, [id]);

  // 2. connect
  useEffect(() => {
    if (!info || info.status !== 'live' || !info.api) return;
    const c = new EngineClient(info.api, id, token);
    clientRef.current = c;
    const unsub = c.subscribe(setEs);
    c.connect();
    return () => { unsub(); c.close(); };
  }, [info?.status, info?.api, token]);

  // 3. while disconnected, re-resolve the engine URL from the lobby (an engine restart moves the table to a new tunnel)
  useEffect(() => {
    if (!info || info.status !== 'live' || !es || es.connected) return;
    if (new URLSearchParams(location.search).get('api')) return;
    const t = setInterval(async () => {
      try {
        const g = await api.game(id);
        if (g.status !== 'live' || (g.api && g.api !== info.api)) { setEs(null); setInfo(g); if (g.hostKey) { setHostKey(g.hostKey); ls.set(`pg:${id}:host`, g.hostKey); } }
      } catch { /* keep trying */ }
    }, 5000);
    return () => clearInterval(t);
  }, [info?.api, info?.status, es?.connected, id]);

  const onToken = (t: string | null) => { ls.set(`pg:${id}:token`, t); setToken(t); };

  if (err) return <Msg title="Table not found" text={err} />;
  if (!info) return <Msg spinner text="Looking up table…" />;
  if (info.status === 'pending') return <Msg spinner title="Spinning up your table" text="The engine is starting a tunnel for this table. Usually takes 5–15 seconds." />;
  if (info.status === 'error') return <Msg title="Engine error" text={info.error ?? 'unknown'} />;
  if (info.status === 'closed') return <Msg title="Table closed" text="This table has been closed by the host." />;
  if (!es || !es.view) return <Msg spinner text={es?.reconnecting ? 'Reconnecting to the table… (if the engine just restarted this takes up to ~90 s)' : 'Connecting to the table…'} />;
  return <TableUI client={clientRef.current!} es={es} hostKey={hostKey} gameId={id} api={info.api!} onToken={onToken} />;
}

function Msg({ title, text, spinner }: { title?: string; text: string; spinner?: boolean }) {
  return (
    <>
      <div class="topbar"><a class="brand" href="/">♠ Poker <span>Garden</span></a><div class="spacer" /><button class="iconbtn" onClick={() => location.reload()} title="Reload" aria-label="Reload"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" /></svg></button></div>
      <div class="center-msg">{spinner ? <div class="spinner" /> : null}{title ? <h2 style="margin:0">{title}</h2> : null}<p>{text}</p><a href="/">← Home</a></div>
    </>
  );
}
