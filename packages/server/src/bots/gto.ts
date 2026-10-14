import type { View } from '@pokergarden/engine';
import { config } from '../config.js';
import { log } from '../log.js';
import { chat, extractJson, safeNote } from './llm.js';
import { describeView, sanitize, type Decision, type PersonaAgent } from './types.js';

/**
 * Map a 9-max view onto PokerSkill's heads-up (BTN/BB) state:
 * hero is BTN when in position vs. the chosen villain, else BB.
 * Villain = last aggressor if any, else the biggest live stack other than hero.
 * All amounts in big blinds.
 */
export function toPokerSkillState(v: View) {
  const me = v.you!; const h = v.hand!; const bb = v.table.bigBlind;
  const toBB = (x: number) => Math.round((x / bb) * 100) / 100;
  const live = v.seats.filter((s) => s.inHand && !s.folded && s.idx !== me);
  let villainIdx: number;
  const lastAgg = [...h.history].reverse().find((a) => (a.action === 'bet' || a.action === 'raise') && a.seat !== me);
  if (lastAgg && live.some((s) => s.idx === lastAgg.seat)) villainIdx = lastAgg.seat;
  else villainIdx = (live.sort((a, b) => b.stack - a.stack)[0] ?? v.seats[me]).idx;
  const dealer = v.seats.findIndex((s) => s.isDealer);
  const dist = (i: number) => (i - dealer + v.seats.length) % v.seats.length; // 0 = dealer acts last postflop
  const heroIP = dist(me) === 0 || dist(me) > dist(villainIdx);
  const myBet = v.seats[me].streetBet;
  const toCall = v.legalActions.find((l) => l.action === 'call')?.amount ?? 0;
  const legal: string[] = [];
  for (const l of v.legalActions) {
    const m: Record<string, string> = { fold: 'f', check: 'k', call: 'c', bet: 'b', raise: 'b' };
    if (!legal.includes(m[l.action])) legal.push(m[l.action]);
  }
  const br = v.legalActions.find((l) => l.action === 'bet' || l.action === 'raise');
  // compress history: only bets/raises/calls/checks on the current and previous streets, as HU tokens
  const tokens: string[] = [];
  let street = 'preflop';
  for (const a of h.history) {
    if (a.action === 'sb' || a.action === 'bb' || a.action === 'ante') continue;
    if (a.street !== street) { tokens.push('_'); street = a.street; }
    if (a.action === 'fold') continue; // folds of third parties are not representable
    if (a.action === 'check') tokens.push('k');
    else if (a.action === 'call') tokens.push('c');
    else tokens.push(`b${toBB(a.to ?? a.amount)}`);
  }
  const state = {
    hand_id: h.no,
    street: h.street,
    hero_hole_cards: v.seats[me].holeCards!.join(''),
    board_cards: h.board.join(''),
    pot: toBB(h.pot - myBet - (v.seats[villainIdx].streetBet)), // pot before this street's bets approx
    total_pot: toBB(h.pot),
    hero_stack: toBB(v.seats[me].stack),
    villain_stack: toBB(v.seats[villainIdx].stack),
    hero_position: heroIP ? 'BTN' : 'BB',
    legal_actions: legal,
    raise_min: br ? toBB(br.min!) : null,
    raise_max: br ? toBB(br.max!) : null,
    action_history: tokens,
    use_skills: true,
  };
  if (state.pot <= 0) state.pot = Math.max(0.5, toBB(h.pot - toCall - myBet));
  return { state, villainIdx };
}

export const gtoAgent: PersonaAgent = {
  name: 'gto',
  async decide(v: View, signal: AbortSignal): Promise<Decision> {
    const legal = v.legalActions;
    const bb = v.table.bigBlind;
    const { state } = toPokerSkillState(v);
    let system = '', user = '';
    try {
      const res = await fetch(`${config.pokerskillUrl}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state), signal });
      if (!res.ok) throw new Error(`pokerskill http ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j: any = await res.json();
      system = j.system_prompt; user = j.user_prompt;
    } catch (e) {
      log('gto', 'pokerskill sidecar unavailable, falling back to plain prompt', { e: String(e).slice(0, 200) });
    }
    const t0 = Date.now();
    let d: Decision | null = null;
    if (system && user) {
      const note = `\n\nNOTE: this is actually a ${v.seats.filter((s) => s.inHand && !s.folded).length}-handed pot at a 9-max table; the heads-up framing above treats the main opponent as "villain". Amounts in the JSON must be in BB units as "bet/raise TO" sizes. Also add a "note" field: optional public table talk (max 12 words) that must NOT reveal or hint at your cards, hand strength or reasoning.`;
      const { text } = await chat([{ role: 'system', content: system }, { role: 'user', content: user + note }], signal, { maxTokens: 400 });
      const p = extractJson(text);
      if (p) {
        const amt = Number(p.amount);
        d = sanitize({ action: p.action, amount: Number.isFinite(amt) ? amt * bb : undefined, note: p.note ?? (typeof p.reasoning === 'string' ? p.reasoning.slice(0, 60) : undefined) }, legal);
      }
      if (d) { d.source = 'pokerskill+llm'; d.note = safeNote(d.note); }
    }
    if (!d) {
      const { text } = await chat([
        { role: 'system', content: `You are a GTO-oriented No-Limit Hold'em player at a 9-max cash table. Play a balanced, theoretically sound strategy with mixed frequencies. Respond with ONLY JSON {"action": "fold|check|call|bet|raise", "amount": <chips, total "to" size for bet/raise>, "note": "<max 12 words>"}.` },
        { role: 'user', content: describeView(v) + '\nWhat is your action?' },
      ], signal);
      d = sanitize(extractJson(text), legal);
      if (d) { d.source = 'llm-gto-fallback'; d.note = safeNote(d.note); }
    }
    if (!d) throw new Error('gto: unparseable');
    d.ms = Date.now() - t0;
    return d;
  },
};
