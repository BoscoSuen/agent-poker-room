import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { View } from '@pokergarden/engine';
import { EngineClient, engineJoin, hostCall, type EngineState } from '../engine';
import { Card } from './Card';

type Props = { client: EngineClient; es: EngineState; hostKey: string | null; gameId: string; api: string; onToken: (t: string | null) => void };

const N = 9;
function seatPos(d: number, mobile: boolean) {
  // d = clockwise offset from the hero seat (hero at bottom center)
  const a = (Math.PI / 2) + (d * 2 * Math.PI) / N;
  const rx = mobile ? 41 : 44, ry = mobile ? 45 : 43;
  return { x: 50 + rx * Math.cos(a), y: 50 + ry * Math.sin(a) };
}

export function TableUI({ client, es, hostKey, gameId, api, onToken }: Props) {
  const v = es.view!;
  const you = v.you;
  const [mobile, setMobile] = useState(window.innerWidth <= 860);
  useEffect(() => { const on = () => setMobile(window.innerWidth <= 860); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  const [bbMode, setBbMode] = useState(false);
  const [join, setJoin] = useState<{ seat?: number } | null>(null);
  const [tab, setTab] = useState<'log' | 'chat' | 'host'>(hostKey ? 'host' : 'log');
  const [collapsed, setCollapsed] = useState(true);
  const fmt = (n: number) => bbMode ? (n / v.table.bigBlind).toFixed(n % v.table.bigBlind ? 1 : 0) + ' BB' : n.toLocaleString();

  // timer re-render
  const [, force] = useState(0);
  useEffect(() => { if (v.hand?.actionOn === null || !v.hand) return; const t = setInterval(() => force((x) => x + 1), 100); return () => clearInterval(t); }, [v.hand?.decisionId]);

  const hero = you ?? 0;
  const rot = (idx: number) => (idx - hero + N) % N;
  const now = Date.now();
  const h = v.hand;
  const winners = new Set<number>(h?.done ? (h.results ?? []).flatMap((r) => r.winners.map((w) => w.seat)) : []);
  const winAmount = (idx: number) => (h?.results ?? []).flatMap((r) => r.winners).filter((w) => w.seat === idx).reduce((a, w) => a + w.amount, 0);

  const doJoin = async (name: string, stack: number, seat?: number) => {
    const r = await engineJoin(api, gameId, name, stack, seat);
    try { localStorage.setItem('pg:name', name); } catch { /* ignore */ }
    onToken(r.token);
    setJoin(null);
  };

  return (
    <div class="game">
      <div class="topbar">
        <a class="brand" href="/">♠ Poker <span>Garden</span></a>
        <span class="status">{v.table.name} · {v.table.smallBlind}/{v.table.bigBlind}{v.table.ante ? ` ante ${v.table.ante}` : ''} · hand #{v.table.handNo}</span>
        <div class="spacer" />
        <button style="padding:4px 8px;font-size:12px" onClick={() => setBbMode(!bbMode)} title="Toggle big-blind display (B)">{bbMode ? 'BB' : '$'}</button>
        <button class="side-toggle" style="padding:4px 8px;font-size:12px" onClick={() => setCollapsed(!collapsed)}>{collapsed ? 'Panel' : 'Hide'}</button>
        <span class={`status ${es.connected ? '' : 'bad'}`}>{es.connected ? '● live' : es.reconnecting ? '○ reconnecting…' : '○ offline'}</span>
      </div>
      {!es.connected && es.reconnecting ? <div class="banner bad">Connection lost — reconnecting… your seat is kept.</div> : null}
      {v.table.status === 'closed' ? <div class="banner bad">Table closed by host.</div> : null}
      {v.table.status !== 'closed' && !v.table.running ? <div class="banner">Waiting for the host to start the game{hostKey ? ' — use the Host tab' : ''}.</div> : null}
      {v.table.running && !h && v.seats.filter((s) => s.name && s.stack > 0 && !s.sittingOut).length < 2 ? <div class="banner">Waiting for at least two players with chips.</div> : null}
      <div class="game-main">
        <div class="felt-wrap">
          <div class="felt">
            <div class="oval" data-label="Poker Garden" />
            <div class="center">
              <div class="board">{(h?.board ?? []).map((c) => <Card c={c} big />)}</div>
              {h ? <div class="pot"><small>POT</small>{fmt(h.pot)}</div> : <div class="handinfo">{v.table.running ? 'next hand starting…' : 'table idle'}</div>}
              {h ? <div class="handinfo">{h.street}{h.done && h.results ? ` · ${h.results.map((r) => r.winners.map((w) => `${v.seats[w.seat].name} wins ${fmt(w.amount)}${w.hand ? ' (' + w.hand + ')' : ''}`).join(', ')).join(' · ')}` : ''}</div> : null}
            </div>
            {v.seats.map((s) => {
              const d = rot(s.idx);
              const p = seatPos(d, mobile);
              if (!s.name) {
                return (
                  <div class="seat" style={{ left: `${p.x}%`, top: `${p.y}%` }}>
                    {you === null && v.table.status !== 'closed' ? <button class="empty" onClick={() => setJoin({ seat: s.idx })}>＋ Take seat</button> : <div class="empty" style="opacity:.5">empty</div>}
                  </div>
                );
              }
              const acting = h?.actionOn === s.idx;
              let frac = 0; let bank = false;
              if (acting && h?.deadline) { const total = h.usingTimeBank ? s.timeBankMs || 1 : v.table.decisionMs; bank = h.usingTimeBank; frac = Math.max(0, Math.min(1, (h.deadline - now) / (bank ? (h.deadline - now > total ? h.deadline - now : total) : total))); }
              const isYou = s.idx === you;
              const showCards = s.inHand && !s.folded;
              return (
                <div class={`seat ${s.folded ? 'folded' : ''} ${s.sittingOut || (!s.inHand && h) ? 'out' : ''} ${acting ? 'acting' : ''} ${isYou ? 'you' : ''} ${winners.has(s.idx) ? 'win' : ''}`} style={{ left: `${p.x}%`, top: `${p.y}%` }}>
                  <div class="cards">{showCards ? (s.holeCards ? s.holeCards.map((c) => <Card c={c} big={isYou && !mobile} />) : [<Card c={null} />, <Card c={null} />]) : null}</div>
                  <div class="plate">
                    <div class="name">{s.name}{s.kind === 'bot' ? ' 🤖' : ''}</div>
                    <div class="stack">{s.stack === 0 && s.inHand ? 'ALL-IN' : fmt(s.stack)}</div>
                    <div class="sub">{!s.connected && s.kind === 'human' ? <span class="dc">disconnected</span> : s.sittingOut ? 'sitting out' : winners.has(s.idx) && h?.done ? <span class="ok">+{fmt(winAmount(s.idx))}</span> : s.lastAction ? s.lastAction.replace(/(\d+)$/, (m) => fmt(Number(m))) : s.persona ? <span class="persona">{s.persona}</span> : ''}</div>
                    {acting ? <div class={`timer ${bank ? 'bank' : ''}`}><i style={{ transform: `scaleX(${frac})` }} /></div> : null}
                  </div>
                </div>
              );
            })}
            {v.seats.map((s) => {
              if (!s.name) return null;
              const p = seatPos(rot(s.idx), mobile);
              const center = { x: 50, y: 44 };
              const bp = { x: p.x + (center.x - p.x) * 0.42, y: p.y + (center.y - p.y) * 0.42 };
              const dp = { x: p.x + (center.x - p.x) * 0.3 + 5, y: p.y + (center.y - p.y) * 0.3 + 3 };
              return (<>
                {s.streetBet > 0 ? <div class="chip" style={{ left: `${bp.x}%`, top: `${bp.y}%` }}>{fmt(s.streetBet)}</div> : null}
                {s.isDealer ? <div class="dbtn" style={{ left: `${dp.x}%`, top: `${dp.y}%` }}>D</div> : null}
              </>);
            })}
          </div>
        </div>
        <SidePanel tab={tab} setTab={setTab} collapsed={collapsed} v={v} es={es} client={client} hostKey={hostKey} gameId={gameId} api={api} fmt={fmt} />
      </div>
      <ActionBar v={v} client={client} fmt={fmt} you={you} onSit={() => setJoin({})} onBb={() => setBbMode(!bbMode)} onLeave={() => { client.leave(); onToken(null); }} />
      {join ? <JoinModal seat={join.seat} defaultStack={(v.table as any).defaultStack ?? v.table.bigBlind * 100} onClose={() => setJoin(null)} onJoin={doJoin} /> : null}
    </div>
  );
}

function JoinModal({ seat, defaultStack, onClose, onJoin }: { seat?: number; defaultStack: number; onClose: () => void; onJoin: (n: string, s: number, seat?: number) => Promise<void> }) {
  const [name, setName] = useState((() => { try { return localStorage.getItem('pg:name') ?? ''; } catch { return ''; } })());
  const [stack, setStack] = useState(defaultStack); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  return (
    <div class="modal-bg" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Take {seat !== undefined ? `seat ${seat + 1}` : 'a seat'}</h3>
        <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(''); try { await onJoin(name.trim() || 'Player', stack, seat); } catch (e: any) { setErr(e.message); setBusy(false); } }}>
          <div class="field"><label>Nickname</label><input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} maxLength={20} autofocus /></div>
          <div class="field"><label>Stack</label><input type="number" min={1} value={stack} onInput={(e) => setStack(Number((e.target as HTMLInputElement).value))} /></div>
          {err ? <div class="err">{err}</div> : null}
          <div class="row"><button class="primary" type="submit" disabled={busy}>Take the seat</button><button type="button" onClick={onClose}>Cancel</button></div>
        </form>
      </div>
    </div>
  );
}

function ActionBar({ v, client, fmt, you, onSit, onBb, onLeave }: { v: View; client: EngineClient; fmt: (n: number) => string; you: number | null; onSit: () => void; onBb: () => void; onLeave: () => void }) {
  const h = v.hand; const legal = v.legalActions;
  const myTurn = you !== null && h && h.actionOn === you && legal.length > 0;
  const br = legal.find((l) => l.action === 'bet' || l.action === 'raise');
  const call = legal.find((l) => l.action === 'call');
  const check = legal.find((l) => l.action === 'check');
  const [amt, setAmt] = useState(0);
  const [raising, setRaising] = useState(false);
  useEffect(() => { if (br) setAmt(br.min!); setRaising(false); }, [h?.decisionId]);
  const act = (a: any, amount?: number) => { if (h) client.act(a, amount, h.decisionId); };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
      if (e.key === 'b' || e.key === 'B') { onBb(); return; }
      if (!myTurn) return;
      if (e.key === 'f' || e.key === 'F') act('fold');
      if (e.key === 'c' || e.key === 'C') act(check ? 'check' : 'call');
      if ((e.key === 'r' || e.key === 'R') && br) { if (raising) act(br.action, amt); else setRaising(true); }
    };
    window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on);
  }, [myTurn, raising, amt, h?.decisionId]);

  if (you === null) {
    return <div class="actionbar"><div class="idle">You are watching.{v.table.status !== 'closed' ? <button class="primary" onClick={onSit}>Take a seat</button> : null}<span class="hint">Keys: F fold · C check/call · R raise · B toggle BB</span></div></div>;
  }
  const me = v.seats[you];
  if (!myTurn) {
    return <div class="actionbar"><div class="idle">
      {h && h.actionOn !== null ? <span>Waiting for <b>{v.seats[h.actionOn].name}</b>…</span> : <span>{h?.done ? 'Hand over.' : 'Waiting for next hand…'}</span>}
      <span class="spacer" style="flex:1" />
      {me.stack === 0 && !(h && me.inHand && !h.done) ? <button class="primary" onClick={() => client.rebuy()}>Rebuy</button> : null}
      <button style="font-size:12px" onClick={() => client.sitOut(!me.sittingOut)}>{me.sittingOut ? 'I\'m back' : 'Sit out next hand'}</button>
      <button class="danger" style="font-size:12px" onClick={onLeave}>Leave table</button>
    </div></div>;
  }
  const toCall = call?.amount ?? 0;
  const pot = h!.pot;
  const preset = (x: number) => { if (!br) return 0; const base = h!.currentBet === 0 ? Math.round(pot * x) : Math.round(h!.currentBet + (pot + toCall) * x); return Math.min(br.max!, Math.max(br.min!, base)); };
  return (
    <div class="actionbar">
      {br && raising ? (
        <div class="presets">
          <button onClick={() => setAmt(br.min!)}>Min</button>
          <button onClick={() => setAmt(preset(1 / 3))}>⅓ pot</button>
          <button onClick={() => setAmt(preset(1 / 2))}>½ pot</button>
          <button onClick={() => setAmt(preset(2 / 3))}>⅔ pot</button>
          <button onClick={() => setAmt(preset(1))}>Pot</button>
          <button onClick={() => setAmt(br.max!)}>All-in</button>
          <input type="range" min={br.min} max={br.max} step={1} value={amt} onInput={(e) => setAmt(Number((e.target as HTMLInputElement).value))} />
          <input type="number" min={br.min} max={br.max} value={amt} onInput={(e) => setAmt(Number((e.target as HTMLInputElement).value))} />
        </div>
      ) : null}
      <div class="btns">
        <button class="fold" onClick={() => act('fold')}>Fold</button>
        {check ? <button class="call" onClick={() => act('check')}>Check</button> : <button class="call" onClick={() => act('call')}>Call {fmt(toCall)}{toCall >= me.stack ? ' (all-in)' : ''}</button>}
        {br ? (raising
          ? <button class="raise" onClick={() => act(br.action, Math.min(br.max!, Math.max(br.min!, Math.round(amt))))}>{br.action === 'bet' ? 'Bet' : 'Raise to'} {fmt(Math.min(br.max!, Math.max(br.min!, Math.round(amt || 0))))}{amt >= br.max! ? ' (all-in)' : ''}</button>
          : <button class="raise" onClick={() => setRaising(true)}>{br.action === 'bet' ? 'Bet' : 'Raise'}</button>) : null}
      </div>
    </div>
  );
}

function SidePanel({ tab, setTab, collapsed, v, es, client, hostKey, gameId, api, fmt }: { tab: 'log' | 'chat' | 'host'; setTab: (t: any) => void; collapsed: boolean; v: View; es: EngineState; client: EngineClient; hostKey: string | null; gameId: string; api: string; fmt: (n: number) => string }) {
  // keep a rolling log across hands
  const logRef = useRef<{ hand: number; lines: { t: string; cls?: string }[] }[]>([]);
  const h = v.hand;
  const lines = useMemo(() => {
    if (!h) return [];
    const out: { t: string; cls?: string }[] = [];
    const name = (i: number) => v.seats[i].name ?? `seat ${i + 1}`;
    out.push({ t: `— Hand #${h.no} · dealer ${name(v.seats.findIndex((s) => s.isDealer))}`, cls: 'street' });
    let street = 'preflop';
    for (const a of h.history) {
      if (a.street !== street) { street = a.street; out.push({ t: `— ${street}: ${h.board.slice(0, street === 'flop' ? 3 : street === 'turn' ? 4 : 5).join(' ')}`, cls: 'street' }); }
      const what = a.action === 'sb' ? `posts SB ${fmt(a.amount)}` : a.action === 'bb' ? `posts BB ${fmt(a.amount)}` : a.action === 'ante' ? `ante ${fmt(a.amount)}` : a.action === 'fold' ? 'folds' : a.action === 'check' ? 'checks' : a.action === 'call' ? `calls ${fmt(a.amount)}` : a.action === 'bet' ? `bets ${fmt(a.to!)}` : `raises to ${fmt(a.to!)}`;
      out.push({ t: `${name(a.seat)} ${what}${a.allIn ? ' (all-in)' : ''}` });
    }
    if (h.done && h.results) {
      if (h.board.length > 0 && !out.some((l) => l.t === `— ${h.street === 'showdown' ? 'river' : h.street}: ${h.board.join(' ')}` ) && street !== 'river') out.push({ t: `— board: ${h.board.join(' ')}`, cls: 'street' });
      if (h.street === 'showdown') for (const s of v.seats) if (s.holeCards && s.inHand && !s.folded && s.idx !== v.you) out.push({ t: `${s.name} shows ${s.holeCards.join(' ')}` });
      for (const r of h.results) for (const w of r.winners) out.push({ t: `${name(w.seat)} wins ${fmt(w.amount)}${w.hand ? ` with ${w.hand}` : ''}`, cls: 'win' });
      out.push({ t: `deck commit ${h.deckCommit.slice(0, 12)}… nonce ${h.nonce?.slice(0, 8)}…`, cls: '' });
    }
    return out;
  }, [h?.no, h?.history.length, h?.done, v.you]);
  useEffect(() => {
    if (!h) return;
    const cur = logRef.current;
    const last = cur[cur.length - 1];
    if (last && last.hand === h.no) last.lines = lines; else { cur.push({ hand: h.no, lines }); if (cur.length > 20) cur.shift(); }
  }, [lines]);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = bodyRef.current; if (el) el.scrollTop = el.scrollHeight; }, [lines, es.chat.length, tab]);
  const [text, setText] = useState('');

  return (
    <div class={`side ${collapsed ? 'collapsed' : ''}`}>
      <div class="tabs">
        <button class={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>Log</button>
        <button class={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>Chat {es.chat.length ? `(${es.chat.length})` : ''}</button>
        {hostKey ? <button class={tab === 'host' ? 'on' : ''} onClick={() => setTab('host')}>Host</button> : null}
      </div>
      {tab === 'log' ? <div class="body log" ref={bodyRef}>{logRef.current.flatMap((x) => x.lines).map((l) => <div class={`line ${l.cls ?? ''}`}>{l.t}</div>)}{!h ? <div class="muted">No hand yet.</div> : null}</div> : null}
      {tab === 'chat' ? <>
        <div class="body chat" ref={bodyRef}>{es.chat.map((m) => <div class={`msg ${m.channel}`}><b>{m.from}</b> {m.text}</div>)}{es.error ? <div class="err">{es.error}</div> : null}</div>
        <form class="chat" style="display:flex" onSubmit={(e) => { e.preventDefault(); if (text.trim()) client.chat(text.trim()); setText(''); }}><input value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} placeholder="Say something…" maxLength={500} /><button type="submit">Send</button></form>
      </> : null}
      {tab === 'host' && hostKey ? <HostPanel v={v} hostKey={hostKey} gameId={gameId} api={api} /> : null}
    </div>
  );
}

function HostPanel({ v, hostKey, gameId, api }: { v: View; hostKey: string; gameId: string; api: string }) {
  const [persona, setPersona] = useState('default'); const [err, setErr] = useState(''); const [copied, setCopied] = useState(false);
  const call = async (cmd: string, body?: any) => { setErr(''); try { await hostCall(api, gameId, hostKey, cmd, body); } catch (e: any) { setErr(e.message); } };
  const invite = `${location.origin}/g/${gameId}`;
  const copy = async () => { try { await navigator.clipboard.writeText(invite); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };
  return (
    <div class="body host">
      <div class="sec"><h4>Invite</h4><div class="invite"><input readonly value={invite} onFocus={(e) => (e.target as HTMLInputElement).select()} /><button onClick={copy}>{copied ? '✓' : 'Copy'}</button></div></div>
      <div class="sec"><h4>Game</h4><div class="row">
        {v.table.running ? <button onClick={() => call('pause')}>Pause after hand</button> : <button class="primary" onClick={() => call('start')}>Start (fills to {v.table.autoFillTo} with agents)</button>}
        <button class="danger" onClick={() => { if (confirm('Close this table for everyone?')) call('close'); }}>Close table</button>
      </div></div>
      <div class="sec"><h4>Add agent</h4><div class="row">
        <select style="width:auto" value={persona} onChange={(e) => setPersona((e.target as HTMLSelectElement).value)}>
          <option value="default">Default (TAG)</option><option value="aggressive">Aggressive (LAG)</option><option value="weak">Weak (calling station)</option><option value="gto">GTO pro</option>
        </select>
        <button onClick={() => call('add_bot', { persona })}>Add</button>
      </div></div>
      <div class="sec"><h4>Seats</h4>
        {v.seats.filter((s) => s.name).map((s) => <div class="seatrow"><span>{s.idx + 1}. {s.name} <span class="muted mono">{s.stack}</span></span><span class="row" style="gap:4px"><button style="padding:2px 6px;font-size:11px" onClick={() => call('add_chips', { seat: s.idx, amount: v.table.bigBlind * 100 })}>+{v.table.bigBlind * 100}</button><button style="padding:2px 6px;font-size:11px" class="danger" onClick={() => call('kick', { seat: s.idx })}>kick</button></span></div>)}
      </div>
      {err ? <div class="err">{err}</div> : null}
    </div>
  );
}
