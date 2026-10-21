import { RANKS, type View } from '@pokergarden/engine';

/**
 * 9-max preflop chart. Hands are ordered by a Chen-style strength score; each position plays the top X% of combos.
 * Border hands (within a small band around a threshold) are mixed 50/50. No LLM, deterministic, instant.
 */

const rv = (c: string) => RANKS.indexOf(c) + 2;

/**
 * Raise-first-in ranges for 9-max cash, 100bb, from pokerspot.gg/poker-preflop-chart (majority action per hand).
 * Their seats UTG, UTG+1, UTG+2, MP map to ours UTG, UTG+1, MP, LJ. A hand's "tier" is the tightest position that opens it
 * (1 = UTG ... 7 = BTN, 9 = never); it is reused to size calling ranges against an open.
 */
const RFI_RANGES: [string, string][] = [
  ['UTG', '77+, ATs+, A5s, KJs+, QJs, JTs, AQo+, KQo'],
  ['UTG+1', '77+, ATs+, A5s, KJs+, QJs, JTs, AJo+, KQo'],
  ['MP', '77+, ATs+, A5s, A4s, KTs+, QJs, JTs, AJo+, KQo'],
  ['LJ', '77+, ATs+, A5s, A4s, KTs+, QTs+, JTs, T9s, AJo+, KQo'],
  ['HJ', '55+, A2s+, K9s+, Q9s+, J9s+, T8s+, 98s, 87s, 76s, 65s, ATo+, KJo+, QJo'],
  ['CO', '22+, A2s+, K7s+, Q8s+, J8s+, T7s+, 97s+, 86s+, 75s+, 64s+, 53s+, 43s, A9o+, K9o+, Q9o+, J9o+, T9o'],
  ['BTN', '22+, A2s+, K2s+, Q5s+, J6s+, T6s+, 96s+, 85s+, 74s+, 63s+, 53s+, 43s, A4o+, K8o+, Q9o+, J9o+, T9o, 97o+, 86o+, 75o+, 65o'],
];
const SB_RANGE = '22+, A2s+, K6s+, Q7s+, J7s+, T7s+, 96s+, 85s+, 75s+, 64s+, 53s+, 43s, A5o+, K9o+, Q9o+, J9o+, T8o+, 98o, 87o, 76o';
const ORDER = 'AKQJT98765432';

function expand(token: string): string[] {
  const t = token.trim(); if (!t) return [];
  const m = t.match(/^([AKQJT2-9])([AKQJT2-9])([so]?)(\+)?$/);
  if (!m) throw new Error('bad range token ' + t);
  const [, x, y, suf, plus] = m;
  if (x === y) { // pair
    const i = ORDER.indexOf(x);
    return plus ? ORDER.slice(0, i + 1).split('').map((c) => c + c) : [x + x];
  }
  if (!plus) return [x + y + suf];
  const xi = ORDER.indexOf(x), yi = ORDER.indexOf(y);
  const out: string[] = [];
  for (let k = xi + 1; k <= yi; k++) out.push(x + ORDER[k] + suf);
  return out;
}
const parse = (r: string) => new Set(r.split(',').flatMap(expand));

const TIER = new Map<string, number>();
RFI_RANGES.forEach(([, r], i) => { for (const h of parse(r)) if (!TIER.has(h)) TIER.set(h, i + 1); });
const SB_SET = parse(SB_RANGE);
const POS_TIER: Record<string, number> = { UTG: 1, 'UTG+1': 2, MP: 3, LJ: 4, HJ: 5, CO: 6, BTN: 7, SB: 7, BB: 7 };
const tierOf = (code: string) => TIER.get(code) ?? 9;

// fixed lists for re-raise spots
const PREMIUM = parse('QQ+, AKs, AKo');
const LATE_3BET = parse('JJ+, AQs+, AKo');
const BLUFF_3BET = parse('A5s, A4s');
const CALL_VS_EARLY = parse('JJ, TT, 99, 88, 77, 66, 55, 44, 33, 22, AQs, AJs, KQs, AQo');
const CALL_3BET = parse('JJ, TT, 99, AQs, AJs, KQs');
const RAISE_4BET = parse('QQ+, AKs, AKo');
const JAM_5BET = parse('KK+, AKs');
const CALL_4BET = parse('QQ, AKo');

export function handCode(cards: string[]): string {
  const [a, b] = [...cards].sort((x, y) => rv(y[0]) - rv(x[0]));
  if (a[0] === b[0]) return a[0] + b[0];
  return a[0] + b[0] + (a[1] === b[1] ? 's' : 'o');
}

/** 9-max position names for every seat dealt in, clockwise from the small blind. */
export function positions(v: View): Record<number, string> {
  const out: Record<number, string> = {};
  const n9 = v.seats.length;
  const inHand = v.seats.filter((s) => s.inHand).map((s) => s.idx);
  const sb = v.seats.find((s) => s.isSB)?.idx;
  if (sb === undefined || inHand.length < 2) return out;
  const order: number[] = []; let cur = sb;
  for (let k = 0; k < n9 && order.length < inHand.length; k++) { if (inHand.includes(cur)) order.push(cur); cur = (cur + 1) % n9; }
  const n = order.length;
  let labels: string[];
  if (n === 2) labels = ['BTN', 'BB'];
  else if (n === 3) labels = ['SB', 'BB', 'BTN'];
  else if (n === 4) labels = ['SB', 'BB', 'CO', 'BTN'];
  else labels = ['SB', 'BB', ...['UTG', 'UTG+1', 'MP', 'LJ', 'HJ'].slice(-(n - 4)), 'CO', 'BTN'];
  order.forEach((idx, i) => { out[idx] = labels[i]; });
  return out;
}

export type Freqs = Partial<Record<'fold' | 'check' | 'call' | 'raise', number>>;
export interface PreflopAdvice { freqs: Freqs; raiseToBB: number; pos: string; code: string; spot: string }

export function preflopAdvice(v: View): PreflopAdvice | null {
  const h = v.hand; const me = v.you;
  if (!h || me === null || h.street !== 'preflop') return null;
  const seat = v.seats[me]; if (!seat.holeCards) return null;
  const pmap = positions(v);
  const pos = pmap[me] ?? 'MP';
  const code = handCode(seat.holeCards); const tier = tierOf(code);
  const bb = v.table.bigBlind;
  const acts = h.history.filter((a) => a.street === 'preflop' && a.action !== 'sb' && a.action !== 'bb' && a.action !== 'ante');
  const raises = acts.filter((a) => a.action === 'raise' || a.action === 'bet');
  const limpers = raises.length === 0 ? acts.filter((a) => a.action === 'call').length : 0;
  const canCheck = v.legalActions.some((l) => l.action === 'check');
  const toBB = (x: number) => x / bb;
  let raise = 0, call = 0, spot: string, raiseToBB: number;
  const ip = pos !== 'SB' && pos !== 'BB';

  if (raises.length === 0) {
    spot = limpers ? `${limpers} limper(s)` : 'unopened';
    if (pos === 'BB') raise = tier <= 3 ? 100 : 0;                                   // iso-raise limpers with strong hands, else check
    else if (pos === 'SB' && !limpers) raise = SB_SET.has(code) ? 100 : 0;
    else raise = tier <= Math.max(1, POS_TIER[pos] - (limpers ? 1 : 0)) ? 100 : 0;   // iso-raise a bit tighter over limpers
    raiseToBB = 2.5 + limpers + (ip ? 0 : 0.5);
  } else if (raises.length === 1) {
    spot = 'facing an open';
    const openerTier = POS_TIER[pmap[raises[0].seat] ?? 'MP'] ?? 3;
    const late = openerTier >= 4;
    if ((late ? LATE_3BET : PREMIUM).has(code)) raise = 100;
    else if (BLUFF_3BET.has(code)) raise = late ? 50 : 30;
    if (raise < 100) {
      const callOk = pos === 'BB' ? tier <= openerTier + 1 : pos === 'SB' ? false : openerTier <= 2 ? CALL_VS_EARLY.has(code) : tier < openerTier || /^(\w)\1$/.test(code);
      if (callOk) call = 100 - raise;
    }
    raiseToBB = toBB(raises[0].to ?? bb * 2.5) * (ip ? 3 : 4);
  } else if (raises.length === 2) {
    spot = 'facing a 3-bet';
    if (RAISE_4BET.has(code)) raise = 100;
    else if (BLUFF_3BET.has(code)) raise = 25;
    if (raise < 100 && CALL_3BET.has(code)) call = 100 - raise;
    raiseToBB = toBB(raises[1].to ?? bb * 9) * 2.3;
  } else {
    spot = 'facing a 4-bet+';
    if (JAM_5BET.has(code)) raise = 100;
    else if (CALL_4BET.has(code)) call = 100;
    raiseToBB = 999; // jam
  }
  const freqs: Freqs = {};
  const hasRaise = v.legalActions.some((l) => l.action === 'raise' || l.action === 'bet');
  const hasCall = v.legalActions.some((l) => l.action === 'call');
  let r = hasRaise ? raise : 0;
  let c = hasCall ? call : 0;
  if (!hasRaise && raise) c = Math.min(100, c + raise); // can't raise (short all-in): call instead
  if (r) freqs.raise = r;
  if (c) freqs.call = c;
  const rest = 100 - r - c;
  if (rest > 0) freqs[canCheck ? 'check' : 'fold'] = rest;
  return { freqs, raiseToBB, pos, code, spot };
}

/** Sample one action from the advice for the GTO agent. */
export function samplePreflop(a: PreflopAdvice): 'fold' | 'check' | 'call' | 'raise' {
  let x = Math.random() * 100;
  for (const k of ['raise', 'call', 'check', 'fold'] as const) { const p = a.freqs[k] ?? 0; if (x < p) return k; x -= p; }
  return a.freqs.check !== undefined ? 'check' : 'fold';
}
