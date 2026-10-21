import type { View } from '@pokergarden/engine';
import { config } from '../config.js';
import { log } from '../log.js';
import { chat, extractJson, safeNote } from './llm.js';
import { describeView, sanitize, type Decision, type PersonaAgent } from './types.js';
import { preflopAdvice, samplePreflop, positions } from './preflop.js';

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

/** Real 9-max context appended to PokerSkill's heads-up prompt. */
function contextLine(v: View): string {
  const pos = positions(v); const me = v.you!;
  const live = v.seats.filter((s) => s.inHand && !s.folded).length;
  const pfr = [...v.hand!.history].reverse().find((a) => a.street === 'preflop' && (a.action === 'raise' || a.action === 'bet'));
  const pfrText = pfr ? (pfr.seat === me ? 'you' : `${pos[pfr.seat] ?? 'seat ' + pfr.seat}`) : 'nobody (limped pot)';
  return `Real spot: ${live}-handed pot at a 9-max table; you are ${pos[me] ?? '?'}; preflop raiser: ${pfrText}.`;
}

/** Ask the PokerSkill sidecar for its prompts for this spot (empty strings if unavailable). */
async function pokerSkillPrompts(v: View, signal: AbortSignal): Promise<{ system: string; user: string }> {
  const { state } = toPokerSkillState(v);
  try {
    const res = await fetch(`${config.pokerskillUrl}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state), signal });
    if (!res.ok) throw new Error(`pokerskill http ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j: any = await res.json();
    return { system: j.system_prompt, user: j.user_prompt };
  } catch (e) {
    log('gto', 'pokerskill sidecar unavailable', { e: String(e).slice(0, 200) });
    return { system: '', user: '' };
  }
}

export interface Hint { freqs: { action: string; pct: number }[]; raiseTo?: number; source: string }

/** GTO hint for a human: action frequencies over the legal actions, from the same PokerSkill prompts the GTO agent uses. */
export async function gtoHint(v: View, signal: AbortSignal): Promise<Hint> {
  const legal = v.legalActions; const bb = v.table.bigBlind;
  const pre = preflopAdvice(v);
  if (pre) return { freqs: Object.entries(pre.freqs).map(([action, pct]) => ({ action, pct: pct! })).sort((a, b) => b.pct - a.pct), source: `chart:${pre.pos}:${pre.code}:${pre.spot}` };
  const names = [...new Set(legal.map((l) => (l.action === 'bet' ? 'raise' : l.action)))];
  const { system, user } = await pokerSkillPrompts(v, signal);
  const ask = `\n\n${contextLine(v)}\nOUTPUT FORMAT (overrides any format above): do not pick one action. Give the mixed-strategy frequency in percent for each of: ${names.join(', ')}; they sum to 100. Respond with ONLY JSON, e.g. {${names.map((n, i) => `"${n}": ${i === 0 ? 60 : Math.floor(40 / Math.max(1, names.length - 1))}`).join(', ')}}.`;
  // PokerSkill's user prompt ends with its own single-action JSON request; drop it so the frequency format wins
  const userBody = user.replace(/What is your action\?[\s\S]*$/i, '').trimEnd();
  const msgs = system && user
    ? [{ role: 'system' as const, content: system }, { role: 'user' as const, content: userBody + ask }]
    : [{ role: 'system' as const, content: 'You are a GTO No-Limit Hold\'em coach.' }, { role: 'user' as const, content: describeView(v) + ask }];
  const { text } = await chat(msgs, signal, { maxTokens: 300 });
  const p = extractJson(text) ?? {};
  // model ignored the format and named one action: treat it as 100% of that action
  if (typeof p.action === 'string' && !names.some((n) => p[n] !== undefined)) {
    const map: Record<string, string> = { f: 'fold', k: 'check', c: 'call', b: 'raise', bet: 'raise' };
    const a = map[p.action.toLowerCase()] ?? p.action.toLowerCase();
    if ((names as string[]).includes(a)) p[a] = 100;
  }
  let freqs = names.map((n) => ({ action: n, pct: Math.max(0, Number(p[n] ?? (n === 'raise' ? p.bet : 0)) || 0) }));
  const sum = freqs.reduce((a, f) => a + f.pct, 0);
  if (sum <= 0) throw new Error('hint: unparseable');
  freqs = freqs.map((f) => ({ ...f, pct: Math.round((100 * f.pct) / sum) })).filter((f) => f.pct > 0).sort((a, b) => b.pct - a.pct);
  const br = legal.find((l) => l.action === 'bet' || l.action === 'raise');
  const rt = Number(p.raise_to ?? p.raise_to_bb);
  const raiseTo = br && freqs.some((f) => f.action === 'raise') && Number.isFinite(rt) ? Math.min(br.max!, Math.max(br.min!, Math.round(rt * bb))) : undefined;
  return { freqs, raiseTo, source: system ? 'pokerskill+llm' : 'llm' };
}

export const gtoAgent: PersonaAgent = {
  name: 'gto',
  async decide(v: View, signal: AbortSignal): Promise<Decision> {
    const legal = v.legalActions;
    const bb = v.table.bigBlind;
    const pre = preflopAdvice(v);
    if (pre) {
      const a = samplePreflop(pre);
      const d = sanitize({ action: a, amount: a === 'raise' ? Math.round(pre.raiseToBB * bb) : undefined }, legal);
      if (d) { d.source = `chart:${pre.pos}:${pre.code}`; return d; }
    }
    const { system, user } = await pokerSkillPrompts(v, signal);
    const t0 = Date.now();
    let d: Decision | null = null;
    if (system && user) {
      const note = `\n\nNOTE: ${contextLine(v)} The heads-up framing above treats the main opponent as "villain". Amounts in the JSON must be in BB units as "bet/raise TO" sizes. Also add a "note" field: optional public table talk in 简体中文 (max 15 characters) that must NOT reveal or hint at your cards, hand strength or reasoning.`;
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
