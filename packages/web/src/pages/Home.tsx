import { useEffect, useState } from 'preact/hooks';
import { api, type GameInfo } from '../api';
import { navigate } from '../main';

const PERSONAS = [
  { id: 'default', label: 'Default' }, { id: 'aggressive', label: 'Aggressive' },
  { id: 'weak', label: 'Weak' }, { id: 'gto', label: 'GTO pro' },
];

export function Home() {
  const [email, setEmail] = useState<string | null | undefined>(undefined);
  useEffect(() => { api.me().then((r) => setEmail(r.email)).catch(() => setEmail(null)); }, []);
  return (
    <>
      <div class="topbar">
        <a class="brand" href="/">♠ Poker <span>Garden</span></a>
        <div class="spacer" />
        {email ? <span class="status">{email} · <a href="#" onClick={(e) => { e.preventDefault(); api.logout().then(() => setEmail(null)); }}>log out</a></span> : null}
      </div>
      <div class="home">
        <h1>Poker Garden</h1>
        <p class="muted">7–9 player No-Limit Hold'em with friends and AI agents at one table. Got an invite link? Just open it.</p>
        {email === undefined ? <p class="muted">…</p> : email ? <Host email={email} /> : <Login onLogin={setEmail} />}
      </div>
    </>
  );
}

function Login({ onLogin }: { onLogin: (e: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const mismatch = mode === 'register' && pw2.length > 0 && pw !== pw2;
  const submit = async () => {
    setErr('');
    if (mode === 'register' && pw !== pw2) { setErr('Passwords do not match.'); return; }
    setBusy(true);
    try { const r = await api[mode](email, pw); onLogin(r.email); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div class="card" style="max-width:420px">
      <h2 style="margin-top:0">{mode === 'login' ? 'Host login' : 'Create host account'}</h2>
      <p class="muted" style="font-size:13px">Only hosts need an account (whitelisted emails). Players join by link.</p>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div class="field"><label>Email</label><input type="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} autocomplete="username" required /></div>
        <div class="field"><label>Password{mode === 'register' ? ' (min 10 characters)' : ''}</label><input type="password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} autocomplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={10} required /></div>
        {mode === 'register' ? <div class="field"><label>Confirm password</label><input type="password" value={pw2} onInput={(e) => setPw2((e.target as HTMLInputElement).value)} autocomplete="new-password" minLength={10} required style={mismatch ? 'border-color:var(--danger)' : ''} />{mismatch ? <div class="muted" style="color:#ffb3b0;font-size:12px;margin-top:4px">Passwords do not match.</div> : null}</div> : null}
        {err ? <div class="err">{err}</div> : null}
        <div class="row">
          {mode === 'login'
            ? <><button class="primary" type="submit" disabled={busy}>Log in</button><button type="button" disabled={busy} onClick={() => { setMode('register'); setErr(''); }}>Register</button></>
            : <><button class="primary" type="submit" disabled={busy || mismatch || pw.length < 10 || pw2.length === 0}>Create account</button><button type="button" disabled={busy} onClick={() => { setMode('login'); setErr(''); setPw2(''); }}>Back to log in</button></>}
        </div>
      </form>
    </div>
  );
}

function Host({ email }: { email: string }) {
  const [games, setGames] = useState<GameInfo[]>([]);
  const [cfg, setCfg] = useState({ name: `${email.split('@')[0]}'s table`, smallBlind: 10, bigBlind: 20, defaultStack: 2000, timerEnabled: true, decisionSec: 20, timeBankSec: 30, autoFillTo: 7, showdownSec: 5, botPersonas: ['default', 'aggressive', 'weak', 'gto'] as string[] });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const refresh = () => api.myGames().then(setGames).catch(() => {});
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, []);
  const set = (k: string, v: any) => setCfg({ ...cfg, [k]: v });
  const num = (k: string) => (e: Event) => set(k, Number((e.target as HTMLInputElement).value));
  const create = async () => {
    setBusy(true); setErr('');
    try { const r = await api.createGame(cfg); navigate(`/g/${r.id}`); } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <>
      <h2>My tables</h2>
      <div class="gamelist">
        {games.length === 0 ? <p class="muted">No tables yet.</p> : games.map((g) => (
          <div class="item">
            <div><b>{g.config?.name ?? g.id}</b> <span class="muted mono">{g.id}</span><br /><span class="muted" style="font-size:12px">{g.summary ? `hand #${g.summary.handNo} · ${g.summary.players} players (${g.summary.humans} human)` : new Date(g.createdAt).toLocaleString()}</span></div>
            <div class="row"><span class={`tag ${g.status}`}>{g.status}</span>{g.status !== 'closed' ? <a href={`/g/${g.id}`} onClick={(e) => { e.preventDefault(); navigate(`/g/${g.id}`); }}>open</a> : null}</div>
          </div>
        ))}
      </div>
      <h2>New table</h2>
      <div class="card">
        <div class="field"><label>Table name</label><input value={cfg.name} onInput={(e) => set('name', (e.target as HTMLInputElement).value)} /></div>
        <div class="grid2">
          <div class="field"><label>Small blind</label><input type="number" min={1} value={cfg.smallBlind} onInput={num('smallBlind')} /></div>
          <div class="field"><label>Big blind</label><input type="number" min={1} value={cfg.bigBlind} onInput={num('bigBlind')} /></div>
          <div class="field"><label>Starting stack</label><input type="number" min={1} value={cfg.defaultStack} onInput={num('defaultStack')} /></div>
          <div class="field"><label>Decision timer</label>
            <div class="row" style="gap:8px"><label class="switch"><input type="checkbox" checked={cfg.timerEnabled} onChange={(e) => set('timerEnabled', (e.target as HTMLInputElement).checked)} /> {cfg.timerEnabled ? 'On' : 'Off (wait forever)'}</label></div>
          </div>
          <div class="field"><label>Decision time (s)</label><input type="number" min={5} max={600} value={cfg.decisionSec} disabled={!cfg.timerEnabled} onInput={num('decisionSec')} /></div>
          <div class="field"><label>Time bank (s)</label><input type="number" min={0} max={300} value={cfg.timeBankSec} disabled={!cfg.timerEnabled} onInput={num('timeBankSec')} /></div>
          <div class="field"><label>Fill with agents up to</label><input type="number" min={2} max={9} value={cfg.autoFillTo} onInput={num('autoFillTo')} /></div>
          <div class="field"><label>Showdown pause (s)</label><input type="number" min={1} max={30} value={cfg.showdownSec} onInput={num('showdownSec')} /></div>
        </div>
        <div class="field"><label>Agent personas (cycled when filling seats)</label>
          <div class="personas">{PERSONAS.map((p) => <button type="button" class={cfg.botPersonas.includes(p.id) ? 'on' : ''} onClick={() => set('botPersonas', cfg.botPersonas.includes(p.id) ? cfg.botPersonas.filter((x) => x !== p.id) : [...cfg.botPersonas, p.id])}>{p.label}</button>)}</div>
        </div>
        {err ? <div class="err">{err}</div> : null}
        <button class="primary" disabled={busy || cfg.botPersonas.length === 0} onClick={create}>{busy ? 'Creating…' : 'Create table'}</button>
      </div>
    </>
  );
}
