import type { View, ActionType, LegalAction } from '@pokergarden/engine';

export interface Decision { action: ActionType; amount?: number; note?: string; source?: string; ms?: number }
export interface PersonaAgent {
  name: string;
  decide(view: View, signal: AbortSignal): Promise<Decision>;
}

/** Clamp a decision to the legal action set. Returns null if not salvageable. */
export function sanitize(d: Partial<Decision> | null | undefined, legal: LegalAction[]): Decision | null {
  if (!d || !d.action) return null;
  let action = String(d.action).toLowerCase() as ActionType;
  const map: Record<string, ActionType> = { f: 'fold', k: 'check', c: 'call', b: 'bet', r: 'raise', 'all-in': 'raise', allin: 'raise', shove: 'raise', 'all_in': 'raise' };
  if (map[action]) action = map[action];
  const has = (a: ActionType) => legal.find((l) => l.action === a);
  // bet<->raise interchangeable depending on street state
  if (action === 'bet' && !has('bet') && has('raise')) action = 'raise';
  if (action === 'raise' && !has('raise') && has('bet')) action = 'bet';
  if (action === 'check' && !has('check') && has('call')) action = 'call';
  if (action === 'call' && !has('call') && has('check')) action = 'check';
  let la = has(action);
  if (!la) {
    // aggressive intent without the right: call if possible
    if ((action === 'bet' || action === 'raise') && has('call')) { action = 'call'; la = has('call'); }
    else if ((action === 'bet' || action === 'raise') && has('check')) { action = 'check'; la = has('check'); }
    else return null;
  }
  const out: Decision = { action, note: d.note, source: d.source };
  if (action === 'bet' || action === 'raise') {
    let amt = Number(d.amount);
    if (!Number.isFinite(amt)) amt = la!.min!;
    amt = Math.round(amt);
    out.amount = Math.min(la!.max!, Math.max(la!.min!, amt));
  }
  return out;
}

export function describeView(v: View): string {
  const me = v.you!;
  const h = v.hand!;
  const seatsInHand = v.seats.filter((s) => s.inHand);
  const posName = (idx: number) => {
    const s = v.seats[idx];
    if (s.isDealer) return 'BTN'; if (s.isSB) return 'SB'; if (s.isBB) return 'BB';
    return `S${idx}`;
  };
  const lines: string[] = [];
  lines.push(`Blinds ${v.table.smallBlind}/${v.table.bigBlind}${v.table.ante ? ` ante ${v.table.ante}` : ''}. Hand #${h.no}. Street: ${h.street}.`);
  lines.push(`You are seat ${me} (${posName(me)}), stack ${v.seats[me].stack}, hole cards ${v.seats[me].holeCards?.join(' ')}.`);
  lines.push(`Board: ${h.board.length ? h.board.join(' ') : '(none)'}. Pot: ${h.pot}. Current bet to match: ${h.currentBet}; your bet this street: ${v.seats[me].streetBet}.`);
  lines.push('Players in hand (clockwise from dealer):');
  // order from dealer
  const dealer = v.seats.findIndex((s) => s.isDealer);
  const order: number[] = [];
  for (let k = 1; k <= v.seats.length; k++) { const i = (dealer + k) % v.seats.length; if (v.seats[i].inHand) order.push(i); }
  for (const i of order) {
    const s = v.seats[i];
    lines.push(`- seat ${i} ${posName(i)} "${s.name}" stack ${s.stack}, bet ${s.streetBet}${s.folded ? ' FOLDED' : ''}${s.allIn ? ' ALL-IN' : ''}${i === me ? ' (you)' : ''}`);
  }
  void seatsInHand;
  const hist = h.history.filter((a) => a.action !== 'ante').map((a) => `${a.street[0]}:${a.seat === me ? 'YOU' : 's' + a.seat}:${a.action}${a.to && (a.action === 'bet' || a.action === 'raise' || a.action === 'call') ? ' to ' + a.to : ''}${a.allIn ? '(all-in)' : ''}`);
  lines.push(`Action so far: ${hist.join(', ') || '(none)'}`);
  const legal = v.legalActions.map((l) => l.action === 'call' ? `call ${l.amount}` : (l.action === 'bet' || l.action === 'raise') ? `${l.action} to [${l.min}..${l.max}]` : l.action);
  lines.push(`Legal actions: ${legal.join(' | ')}.`);
  return lines.join('\n');
}
