import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { View } from '@pokergarden/engine';
import { EngineClient, engineJoin, engineLeave, hostCall, type EngineState } from '../engine';
import { Card } from './Card';

type Props = { client: EngineClient; es: EngineState; hostKey: string | null; gameId: string; api: string; onToken: (t: string | null) => void };

const N = 9;

const PERSONA_INFO: Record<string, { label: string; desc: string }> = {
  default: { label: 'Default', desc: 'Solid tight-aggressive: opens good hands, respects position, value bets, bluffs selectively.' },
  aggressive: { label: 'Aggressive', desc: 'Loose-aggressive: wide opens, frequent 3-bets and barrels, big sizes, extra random bluffs.' },
  weak: { label: 'Weak', desc: 'Rule-based calling station: calls almost anything, rarely raises, no LLM.' },
  gto: { label: 'GTO pro', desc: 'PokerSkill strategy prompts (heads-up approximation) plus the LLM; balanced, solver-style play.' },
};

/** Chip stack: discs colored by denomination (relative to the big blind), count grows with amount. */
function Chips({ amount, bb, big }: { amount: number; bb: number; big?: boolean }) {
  const x = amount / Math.max(1, bb);
  const cls = x >= 100 ? 'c-black' : x >= 50 ? 'c-purple' : x >= 20 ? 'c-blue' : x >= 5 ? 'c-green' : x >= 1 ? 'c-red' : 'c-white';
  const n = Math.max(1, Math.min(big ? 8 : 5, Math.round(Math.log2(x + 1) * 1.6)));
  return <span class={`chips ${cls} ${big ? 'big' : ''}`}>{Array.from({ length: n }, (_, i) => <i style={{ bottom: `${i * (big ? 4 : 3)}px` }} />)}</span>;
}

/** Position names clockwise from the small blind for the seats dealt into this hand. */
function positions(v: View): Record<number, string> {
  const out: Record<number, string> = {};
  const inHand = v.seats.filter((s) => s.inHand).map((s) => s.idx);
  if (inHand.length < 2) return out;
  const sb = v.seats.find((s) => s.isSB)?.idx; const dealer = v.seats.find((s) => s.isDealer)?.idx;
  if (sb === undefined || dealer === undefined) return out;
  const order: number[] = []; let cur = sb;
  for (let k = 0; k < N && order.length < inHand.length; k++) { if (inHand.includes(cur)) order.push(cur); cur = (cur + 1) % N; }
  const n = order.length;
  let labels: string[];
  if (n === 2) labels = ['BTN', 'BB'];
  else if (n === 3) labels = ['SB', 'BB', 'BTN'];
  else if (n === 4) labels = ['SB', 'BB', 'CO', 'BTN'];
  else { const mid = ['UTG', 'UTG+1', 'MP', 'LJ', 'HJ'].slice(-(n - 4)); labels = ['SB', 'BB', ...mid, 'CO', 'BTN']; }
  order.forEach((idx, i) => { out[idx] = labels[i]; });
  return out;
}
// Portrait phones: a "stadium" layout, hero at the bottom, three seats up each side, two across the top.
const MOBILE_POS = [[50, 86], [16, 73], [12, 52], [16, 31], [34, 12], [66, 12], [84, 31], [88, 52], [84, 73]];
function seatPos(d: number, mobile: boolean) {
  // d = clockwise offset from the hero seat (hero at bottom center)
  if (mobile) { const [x, y] = MOBILE_POS[d]; return { x, y }; }
  const a = (Math.PI / 2) + (d * 2 * Math.PI) / N;
  return { x: 50 + 44 * Math.cos(a), y: 50 + 43 * Math.sin(a) };
}

export function TableUI({ client, es, hostKey, gameId, api, onToken }: Props) {
  const v = es.view!;
  const you = v.you;
  const [mobile, setMobile] = useState(window.innerWidth <= 640);
  useEffect(() => { const on = () => setMobile(window.innerWidth <= 640); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  const [bbMode, setBbMode] = useState(false);
  const [join, setJoin] = useState<{ seat?: number } | null>(null);
  const [detail, setDetail] = useState<number | null>(null);
  const [tab, setTab] = useState<'log' | 'chat' | 'board' | 'host'>(hostKey ? 'host' : 'log');
  const [collapsed, setCollapsed] = useState(true);
  const seenChat = useRef(0);
  useEffect(() => { if (!collapsed || tab === 'chat') seenChat.current = es.chat.length; }, [collapsed, es.chat.length, tab]);
  const unread = Math.max(0, es.chat.length - seenChat.current);
  const fmt = (n: number) => bbMode ? (n / v.table.bigBlind).toFixed(n % v.table.bigBlind ? 1 : 0) + ' BB' : n.toLocaleString();

  // timer re-render
  const [, force] = useState(0);
  useEffect(() => { if (v.hand?.actionOn === null || !v.hand) return; const t = setInterval(() => force((x) => x + 1), 100); return () => clearInterval(t); }, [v.hand?.decisionId]);
  // re-render while chat bubbles are fading
  useEffect(() => { const t = setInterval(() => force((x) => x + 1), 1000); const stop = setTimeout(() => clearInterval(t), 9000); return () => { clearInterval(t); clearTimeout(stop); }; }, [es.chat.length]);
  const pos = positions(v);
  // action flash: latest history entry -> 1.2 s highlight on that seat (chip slide + label)
  const lastAct = v.hand?.history[v.hand.history.length - 1];
  const [flash, setFlash] = useState<{ seat: number; action: string; to: number; key: string } | null>(null);
  useEffect(() => {
    const hh = v.hand;
    if (!hh || !lastAct || lastAct.action === 'sb' || lastAct.action === 'bb' || lastAct.action === 'ante') return;
    const key = `${hh.no}:${hh.history.length}`;
    setFlash({ seat: lastAct.seat, action: lastAct.action, to: lastAct.to ?? lastAct.amount, key });
    const t = setTimeout(() => setFlash((f) => (f?.key === key ? null : f)), 1200);
    return () => clearTimeout(t);
  }, [v.hand?.no, v.hand?.history.length]);
  const feltRef = useRef<HTMLDivElement>(null);
  const ACT_LABEL: Record<string, string> = { fold: 'FOLD', check: 'CHECK', call: 'CALL', bet: 'BET', raise: 'RAISE', timeout: 'TIME' };
  const bubbleFor = (idx: number) => { const m = [...es.chat].reverse().find((c) => c.seat === idx); return m && Date.now() - m.ts < 7000 ? m.text : null; };

  const hero = you ?? 0;
  const rot = (idx: number) => (idx - hero + N) % N;
  const now = Date.now();
  const h = v.hand;
  const winners = new Set<number>(h?.done ? (h.results ?? []).flatMap((r) => r.winners.map((w) => w.seat)) : []);
  const winAmount = (idx: number) => (h?.results ?? []).flatMap((r) => r.winners).filter((w) => w.seat === idx).reduce((a, w) => a + w.amount, 0);
  const winHand = (idx: number) => (h?.results ?? []).flatMap((r) => r.winners).find((w) => w.seat === idx && w.hand)?.hand;
  const winCards = new Set<string>(h?.done ? (h.results ?? []).flatMap((r) => r.winners.flatMap((w) => w.cards ?? [])) : []);
  const hl = (c: string) => winCards.size ? (winCards.has(c) ? 'hl' : 'dim') : '';
  const winSummary = h?.done && h.results ? [...winners].map((idx) => `${v.seats[idx].name} wins ${fmt(winAmount(idx))}${winHand(idx) ? ` (${winHand(idx)})` : ''}`).join(' · ') : '';

  const [leaveErr, setLeaveErr] = useState('');
  const doLeave = async () => {
    if (!client.token) return;
    setLeaveErr('');
    try { await engineLeave(api, gameId, client.token); onToken(null); }
    catch (e: any) {
      // token already invalid (engine restarted / seat reclaimed): just drop it; otherwise keep the seat and tell the user
      if (/token/i.test(String(e.message))) onToken(null); else setLeaveErr(`Could not leave: ${e.message}. Check your connection and try again.`);
    }
  };
  const doJoin = async (name: string, stack: number, seat?: number) => {
    const r = await engineJoin(api, gameId, name, stack || undefined, seat);
    try { localStorage.setItem('pg:name', name); } catch { /* ignore */ }
    onToken(r.token);
    setJoin(null);
  };

  return (
    <div class="game">
      <div class="topbar">
        <a class="brand" href="/">♠ Poker <span>Garden</span></a>
        <span class="status">{mobile ? '' : `${v.table.name} · `}{v.table.smallBlind}/{v.table.bigBlind}{v.table.ante ? ` ante ${v.table.ante}` : ''} · #{v.table.handNo}</span>
        <div class="spacer" />
        <button class="iconbtn" onClick={() => location.reload()} title="Reload" aria-label="Reload"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" /></svg></button>
        <button style="padding:4px 8px;font-size:12px" onClick={() => setBbMode(!bbMode)} title="Toggle big-blind display (B)">{bbMode ? 'BB' : '$'}</button>
        <button class="side-toggle" style="padding:4px 8px;font-size:12px" onClick={() => setCollapsed(!collapsed)}>{collapsed ? `Panel${unread ? ` (${unread})` : ''}` : 'Hide'}</button>
        <span class={`status conn ${es.connected ? '' : 'bad'}`} title={es.connected ? 'live' : 'reconnecting'}>{es.connected ? (mobile ? '●' : '● live') : es.reconnecting ? (mobile ? '○' : '○ reconnecting…') : '○ offline'}</span>
      </div>
      {!es.connected && es.reconnecting ? <div class="banner bad">Connection lost — reconnecting… your seat is kept.</div> : null}
      {v.table.status === 'closed' ? <div class="banner bad">Table closed by host.</div> : null}
      {leaveErr ? <div class="banner bad">{leaveErr}</div> : null}
      {v.table.status !== 'closed' && !v.table.running ? <div class="banner">Waiting for the host to start the game{hostKey ? ' — use the Host tab' : ''}.</div> : null}
      {v.table.running && !h && v.seats.filter((s) => s.name && s.stack > 0 && !s.sittingOut).length < 2 ? <div class="banner">Waiting for at least two players with chips.</div> : null}
      <div class="game-main">
        <div class="felt-wrap">
          <div class="felt" ref={feltRef}>
            <div class="oval" data-label="Poker Garden" />
            <div class="center">
              <div class="board">{(h?.board ?? []).map((c) => <Card c={c} big cls={hl(c)} />)}</div>
              {h ? <div class="potwrap">{h.pot > 0 ? <><Chips amount={h.pot} bb={v.table.bigBlind} big /><Chips amount={h.pot / 3} bb={v.table.bigBlind} big /></> : null}<div class="pot"><small>POT</small>{fmt(h.pot)}</div></div> : <div class="handinfo">{v.table.running ? 'next hand starting…' : 'table idle'}</div>}
              {h ? <div class="handinfo">{h.street}{winSummary ? ` · ${winSummary}` : ''}</div> : null}
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
                <div class={`seat ${s.folded ? 'folded' : ''} ${s.sittingOut || (!s.inHand && h) ? 'out' : ''} ${acting ? 'acting' : ''} ${isYou ? 'you' : ''} ${winners.has(s.idx) ? 'win' : ''} ${flash?.seat === s.idx ? `flash flash-${flash.action}` : ''}`} style={{ left: `${p.x}%`, top: `${p.y}%` }}>
                  <div class="cards">{showCards ? (s.holeCards ? s.holeCards.map((c) => <Card c={c} big={isYou && !mobile} />) : [<Card c={null} />, <Card c={null} />]) : null}</div>
                  {winners.has(s.idx) && h?.done ? <div class="winbadge">🏆 +{fmt(winAmount(s.idx))}{winHand(s.idx) ? ` · ${winHand(s.idx)}` : ''}</div>
                    : flash?.seat === s.idx ? <div class={`actpop act-${flash.action}`} key={flash.key}>{ACT_LABEL[flash.action] ?? flash.action}{flash.action === 'bet' || flash.action === 'raise' ? ` ${fmt(flash.to)}` : ''}</div>
                    : bubbleFor(s.idx) ? <div class="bubble">{bubbleFor(s.idx)}</div> : null}
                  <div class="plate" role="button" onClick={() => setDetail(detail === s.idx ? null : s.idx)}>
                    <div class="name">{s.name}{s.kind === 'bot' ? <span class={`ptag p-${s.persona}`} title={s.persona}>{s.persona}</span> : ''}</div>
                    <div class="stack">{s.stack === 0 && s.inHand ? 'ALL-IN' : fmt(s.stack)}{pos[s.idx] ? <span class="posi"> · {pos[s.idx]}</span> : null}</div>
                    {pos[s.idx] ? <div class="posn">({pos[s.idx]})</div> : null}
                    <div class="sub">{!s.connected && s.kind === 'human' ? <span class="dc">disconnected</span> : s.sittingOut ? 'sitting out' : winners.has(s.idx) && h?.done ? <span class="ok">+{fmt(winAmount(s.idx))}</span> : s.lastAction ? s.lastAction.replace(/(\d+)$/, (m) => fmt(Number(m))) : ''}</div>
                    {acting ? <div class={`timer ${bank ? 'bank' : ''}`}><i style={{ transform: `scaleX(${frac})` }} /></div> : null}
                  </div>
                </div>
              );
            })}
            {v.seats.map((s) => {
              if (!s.name) return null;
              const p = seatPos(rot(s.idx), mobile);
              const center = { x: 50, y: mobile ? 50 : 44 };
              const bp = { x: p.x + (center.x - p.x) * 0.42, y: p.y + (center.y - p.y) * 0.42 };
              const dp = { x: p.x + (center.x - p.x) * 0.3 + 5, y: p.y + (center.y - p.y) * 0.3 + 3 };
              return (<>
                {s.streetBet > 0 ? (() => {
                  const sliding = flash?.seat === s.idx && (flash.action === 'bet' || flash.action === 'raise' || flash.action === 'call');
                  const fw = feltRef.current?.clientWidth ?? 0, fh = feltRef.current?.clientHeight ?? 0;
                  const st = sliding ? { '--dx': `${((p.x - bp.x) / 100) * fw}px`, '--dy': `${((p.y - bp.y) / 100) * fh}px` } as any : {};
                  return <div class={`chip ${sliding ? 'slide' : ''}`} key={sliding ? flash!.key : 'chip'} style={{ left: `${bp.x}%`, top: `${bp.y}%`, ...st }}><Chips amount={s.streetBet} bb={v.table.bigBlind} />{fmt(s.streetBet)}</div>;
                })() : null}
                {s.isDealer ? <div class="dbtn" style={{ left: `${dp.x}%`, top: `${dp.y}%` }}>D</div> : null}
              </>);
            })}
          </div>
        </div>
        {mobile && !collapsed ? <div class="sheet-bg" onClick={() => setCollapsed(true)} /> : null}
        <SidePanel tab={tab} setTab={setTab} collapsed={collapsed} onClose={() => setCollapsed(true)} v={v} es={es} client={client} hostKey={hostKey} gameId={gameId} api={api} fmt={fmt} />
      </div>
      <ActionBar v={v} client={client} fmt={fmt} you={you} onSit={() => setJoin({})} onBb={() => setBbMode(!bbMode)} onLeave={doLeave} />
      {detail !== null && v.seats[detail].name ? (() => {
        const s = v.seats[detail]; const row = es.leaderboard.find((r) => r.name === s.name); const pi = s.persona ? PERSONA_INFO[s.persona] : null;
        return <div class="modal-bg" onClick={() => setDetail(null)}><div class="modal detail" onClick={(e) => e.stopPropagation()}>
          <h3>{s.name} <span class="muted" style="font-weight:400;font-size:13px">{s.kind === 'bot' ? '🤖 agent' : '👤 human'}{s.idx === you ? ' · you' : ''}</span></h3>
          {pi ? <p><span class={`ptag big p-${s.persona}`}>{pi.label}</span><br /><span class="muted" style="font-size:13px">{pi.desc}</span></p> : null}
          <table class="kv"><tbody>
            <tr><td>Seat</td><td class="mono">{s.idx + 1}{pos[s.idx] ? ` · ${pos[s.idx]}` : ''}</td></tr>
            <tr><td>Stack</td><td class="mono">{fmt(s.stack)}{s.streetBet ? ` (+${fmt(s.streetBet)} in)` : ''}</td></tr>
            {row ? <tr><td>Session</td><td class="mono"><span class={row.net > 0 ? 'ok' : row.net < 0 ? 'neg' : ''}>{row.net > 0 ? '+' : ''}{fmt(row.net)}</span> · {row.wins} wins · {row.sessions} sit{row.sessions === 1 ? '' : 's'}</td></tr> : null}
            <tr><td>Status</td><td>{s.sittingOut ? 'sitting out' : h && s.inHand ? (s.folded ? 'folded' : s.allIn ? 'all-in' : 'in hand') : 'waiting for next hand'}{s.kind === 'human' && !s.connected ? ' · disconnected' : ''}</td></tr>
          </tbody></table>
          <div class="row" style="justify-content:flex-end">
            {s.kind === 'human' && !s.connected && you === null ? <button class="primary" onClick={async () => { try { await doJoin(s.name!, 0, undefined); setDetail(null); } catch (e: any) { alert(e.message); } }}>This is me — reclaim seat</button> : null}
            <button onClick={() => setDetail(null)}>Close</button></div>
        </div></div>;
      })() : null}
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
        <p class="muted" style="font-size:12px;margin-top:-6px">Use the same nickname as before to get your old seat back if it shows as disconnected.</p>
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
  const [confirmLeave, setConfirmLeave] = useState(false);
  useEffect(() => { setConfirmLeave(false); }, [h?.decisionId, you]);
  const leaveUI = confirmLeave
    ? <span class="confirm">Leave the table{h && you !== null && v.seats[you].inHand && !v.seats[you].folded && !h.done ? ' (folds your hand)' : ''}? <button class="danger" onClick={() => { setConfirmLeave(false); onLeave(); }}>Yes, leave</button><button onClick={() => setConfirmLeave(false)}>Cancel</button></span>
    : null;
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
      {leaveUI ?? <button class="danger" style="font-size:12px" onClick={() => setConfirmLeave(true)}>Leave table</button>}
    </div></div>;
  }
  const toCall = call?.amount ?? 0;
  const pot = h!.pot;
  const confirmRaise = () => { if (br) act(br.action, Math.min(br.max!, Math.max(br.min!, Math.round(amt || br.min!)))); };
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
          <input type="range" min={br.min} max={br.max} step={1} value={amt} onInput={(e) => setAmt(Number((e.target as HTMLInputElement).value))} onKeyDown={(e) => { if (e.key === 'Enter') confirmRaise(); }} />
          <input type="number" min={br.min} max={br.max} value={amt} inputMode="numeric" ref={(el) => { if (el && !('ontouchstart' in window) && document.activeElement !== el && !(document.activeElement instanceof HTMLInputElement)) { el.focus(); el.select(); } }} onInput={(e) => setAmt(Number((e.target as HTMLInputElement).value))} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmRaise(); } }} />
        </div>
      ) : null}
      {leaveUI ? <div class="idle">{leaveUI}</div> : null}
      <div class="btns">
        <button class="leave" title="Fold and leave" onClick={() => setConfirmLeave(true)}>Leave</button>
        <button class="fold" onClick={() => act('fold')}>Fold</button>
        {check ? <button class="call" onClick={() => act('check')}>Check</button> : <button class="call" onClick={() => act('call')}>Call {fmt(toCall)}{toCall >= me.stack ? ' (all-in)' : ''}</button>}
        {br ? (raising
          ? <button class="raise" onClick={confirmRaise}>{br.action === 'bet' ? 'Bet' : 'Raise to'} {fmt(Math.min(br.max!, Math.max(br.min!, Math.round(amt || 0))))}{amt >= br.max! ? ' (all-in)' : ''}</button>
          : <button class="raise" onClick={() => setRaising(true)}>{br.action === 'bet' ? 'Bet' : 'Raise'}</button>) : null}
      </div>
    </div>
  );
}

function SidePanel({ tab, setTab, collapsed, onClose, v, es, client, hostKey, gameId, api, fmt }: { tab: 'log' | 'chat' | 'board' | 'host'; setTab: (t: any) => void; collapsed: boolean; onClose: () => void; v: View; es: EngineState; client: EngineClient; hostKey: string | null; gameId: string; api: string; fmt: (n: number) => string }) {
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
  const [copied, setCopied] = useState(false);
  const copyHand = async () => {
    if (!h) return;
    const me = v.you !== null ? v.seats[v.you] : null;
    const head = [
      `Poker Garden · ${v.table.name} · ${v.table.smallBlind}/${v.table.bigBlind} NLH · Hand #${h.no}`,
      `Players: ${v.seats.filter((s) => s.inHand).map((s) => `${s.name} (${fmt(s.stack + s.handBet)}${s.isDealer ? ', BTN' : s.isSB ? ', SB' : s.isBB ? ', BB' : ''})`).join(', ')}`,
      me?.holeCards ? `My hand (${me.name}): ${me.holeCards.join(' ')}` : '',
      h.board.length ? `Board: ${h.board.join(' ')}` : '',
      '',
    ].filter((x) => x !== undefined);
    const text = [...head, ...lines.map((l) => l.t)].join('\n');
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 1500); } finally { ta.remove(); } }
  };
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = bodyRef.current; if (el) el.scrollTop = el.scrollHeight; }, [lines, es.chat.length, tab]);
  const [text, setText] = useState('');

  return (
    <div class={`side ${collapsed ? 'collapsed' : ''}`}>
      <div class="tabs">
        <button class={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>Log</button>
        <button class={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>Chat {es.chat.length ? `(${es.chat.length})` : ''}</button>
        <button class={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>Board</button>
        {hostKey ? <button class={tab === 'host' ? 'on' : ''} onClick={() => setTab('host')}>Host</button> : null}
        <button class="sheet-close" onClick={onClose} aria-label="Close panel">✕</button>
      </div>
      {tab === 'log' ? <div class="body log" ref={bodyRef}>
        {h ? <div class="logtools"><button onClick={copyHand}>{copied ? '✓ Copied' : 'Copy this hand'}</button></div> : null}
        {logRef.current.flatMap((x) => x.lines).map((l) => <div class={`line ${l.cls ?? ''}`}>{l.t}</div>)}{!h ? <div class="muted">No hand yet.</div> : null}
      </div> : null}
      {tab === 'chat' ? <>
        <div class="body chat" ref={bodyRef}>{es.chat.map((m) => <div class={`msg ${m.channel}`}><b>{m.from}</b> {m.text}</div>)}{es.error ? <div class="err">{es.error}</div> : null}</div>
        <form class="chat" style="display:flex" onSubmit={(e) => { e.preventDefault(); if (text.trim()) client.chat(text.trim()); setText(''); }}><input value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} placeholder="Say something…" maxLength={500} /><button type="submit">Send</button></form>
      </> : null}
      {tab === 'board' ? <div class="body lb">
        <table><thead><tr><th>#</th><th>Name</th><th class="r">Net</th><th class="r">Wins</th><th class="r">Sits</th></tr></thead><tbody>
          {es.leaderboard.map((r, i) => <tr class={r.seated ? 'seated' : ''}><td>{i + 1}</td><td>{r.name}{r.kind === 'bot' ? ' 🤖' : ''}{r.seated ? ' ●' : ''}</td><td class={`r mono ${r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}`}>{r.net > 0 ? '+' : ''}{fmt(r.net)}</td><td class="r mono">{r.wins}</td><td class="r mono">{r.sessions}</td></tr>)}
          {es.leaderboard.length === 0 ? <tr><td colSpan={5} class="muted">Nobody yet.</td></tr> : null}
        </tbody></table>
        <p class="muted" style="font-size:11px">Net = chips now − chips bought in; Wins = hands won; Sits = times seated. Per name, across seatings. ● currently seated.</p>
      </div> : null}
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
        <button class="danger" onClick={() => { if (confirm('Close table: everyone leaves (humans and agents), the game stops and the leaderboard is cleared. The table stays open for a fresh start. Continue?')) call('close'); }}>Close table</button>
        <button class="danger" onClick={() => { if (confirm('Exit game: shut this table down for good (tunnel closed, link dead). Continue?')) call('exit'); }}>Exit game</button>
      </div></div>
      <div class="sec"><h4>Add agent</h4><div class="row">
        <select style="width:auto" value={persona} onChange={(e) => setPersona((e.target as HTMLSelectElement).value)}>
          <option value="default">Default</option><option value="aggressive">Aggressive</option><option value="weak">Weak</option><option value="gto">GTO pro</option>
        </select>
        <button onClick={() => call('add_bot', { persona })}>Add</button>
      </div></div>
      <div class="sec"><h4>Seats</h4>
        {v.seats.filter((s) => s.name).map((s) => <div class="seatrow"><span>{s.idx + 1}. {s.name}{s.persona ? <span class={`ptag p-${s.persona}`} title={s.persona}>{s.persona}</span> : null} <span class="muted mono">{s.stack}</span></span><span class="row" style="gap:4px"><button style="padding:2px 6px;font-size:11px" onClick={() => call('add_chips', { seat: s.idx, amount: v.table.bigBlind * 100 })}>+{v.table.bigBlind * 100}</button><button style="padding:2px 6px;font-size:11px" class="danger" onClick={() => call('kick', { seat: s.idx })}>kick</button></span></div>)}
      </div>
      {err ? <div class="err">{err}</div> : null}
    </div>
  );
}
