import { RANKS, type View } from '@pokergarden/engine';

/**
 * 9-max preflop chart. Hands are ordered by a Chen-style strength score; each position plays the top X% of combos.
 * Border hands (within a small band around a threshold) are mixed 50/50. No LLM, deterministic, instant.
 */

const rv = (c: string) => RANKS.indexOf(c) + 2;

function chen(hi: number, lo: number, suited: boolean, pair: boolean): number {
  const pts = (r: number) => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2);
  let s = pts(hi);
  if (pair) return Math.max(5, s * 2) + 0.01 * hi;
  if (suited) s += 2;
  const gap = hi - lo - 1;
  s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && hi < 12) s += 1;
  return s + 0.01 * hi + 0.001 * lo;
}

/** hand code ("AKs", "T9o", "77") -> percentile of combos at least as strong (0 = best, 100 = worst) */
const PCT = (() => {
  const hands: { code: string; score: number; combos: number }[] = [];
  for (let i = 12; i >= 0; i--) for (let j = i; j >= 0; j--) {
    const hi = i + 2, lo = j + 2; const a = RANKS[i], b = RANKS[j];
    if (i === j) hands.push({ code: a + b, score: chen(hi, lo, false, true), combos: 6 });
    else { hands.push({ code: a + b + 's', score: chen(hi, lo, true, false), combos: 4 }); hands.push({ code: a + b + 'o', score: chen(hi, lo, false, false), combos: 12 }); }
  }
  hands.sort((x, y) => y.score - x.score);
  const m = new Map<string, number>(); let acc = 0;
  for (const h of hands) { acc += h.combos; m.set(h.code, (100 * acc) / 1326); }
  return m;
})();

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

// % of combos opened from each position (raise first in)
const RFI: Record<string, number> = { UTG: 12, 'UTG+1': 14, MP: 17, LJ: 20, HJ: 24, CO: 29, BTN: 45, SB: 38, BB: 100 };

export type Freqs = Partial<Record<'fold' | 'check' | 'call' | 'raise', number>>;
export interface PreflopAdvice { freqs: Freqs; raiseToBB: number; pos: string; code: string; spot: string }

/** band: 100% if pct <= t - w, 50% inside the band, 0% beyond */
const band = (pct: number, t: number, w = 2) => (pct <= t - w ? 100 : pct <= t + w ? 50 : 0);

export function preflopAdvice(v: View): PreflopAdvice | null {
  const h = v.hand; const me = v.you;
  if (!h || me === null || h.street !== 'preflop') return null;
  const seat = v.seats[me]; if (!seat.holeCards) return null;
  const pos = positions(v)[me] ?? 'MP';
  const code = handCode(seat.holeCards); const pct = PCT.get(code) ?? 100;
  const bb = v.table.bigBlind;
  const acts = h.history.filter((a) => a.street === 'preflop' && a.action !== 'sb' && a.action !== 'bb' && a.action !== 'ante');
  const raises = acts.filter((a) => a.action === 'raise' || a.action === 'bet');
  const limpers = raises.length === 0 ? acts.filter((a) => a.action === 'call').length : 0;
  const canCheck = v.legalActions.some((l) => l.action === 'check');
  const passive: 'check' | 'fold' = canCheck ? 'check' : 'fold';
  let raise = 0, call = 0, spot: string, raiseToBB: number;
  const toBB = (x: number) => x / bb;

  if (raises.length === 0) {
    spot = limpers ? `${limpers} limper(s)` : 'unopened';
    raise = band(pct, pos === 'BB' ? 14 : (RFI[pos] ?? 20) * (limpers ? 0.7 : 1));
    if (pos === 'SB' && !limpers && raise < 100) call = (band(pct, 55) * (100 - raise)) / 100; // SB completes some
    raiseToBB = 2.5 + limpers + (pos === 'SB' || pos === 'BB' ? 0.5 : 0);
  } else if (raises.length === 1) {
    spot = 'facing an open';
    const openerPos = positions(v)[raises[0].seat] ?? 'MP';
    const openerRange = RFI[openerPos] ?? 20;
    const threeBet = Math.max(3, openerRange * 0.22);
    const callWidth = pos === 'BB' ? openerRange * 1.1 : pos === 'SB' ? 0 : pos === 'BTN' || pos === 'CO' ? openerRange * 0.55 : openerRange * 0.4;
    raise = band(pct, threeBet, 1);
    call = raise === 100 ? 0 : band(pct, threeBet + callWidth) * (100 - raise) / 100;
    const ip = pos !== 'SB' && pos !== 'BB';
    raiseToBB = toBB(raises[0].to ?? bb * 2.5) * (ip ? 3 : 4);
  } else if (raises.length === 2) {
    spot = 'facing a 3-bet';
    raise = band(pct, 2.5, 0.6);
    call = raise === 100 ? 0 : band(pct, 5, 1) * (100 - raise) / 100;
    raiseToBB = toBB(raises[1].to ?? bb * 9) * 2.3;
  } else {
    spot = 'facing a 4-bet+';
    raise = band(pct, 1.5, 0.3);
    call = raise === 100 ? 0 : band(pct, 3, 0.6) * (100 - raise) / 100;
    raiseToBB = 999; // jam
  }
  const freqs: Freqs = {};
  const hasRaise = v.legalActions.some((l) => l.action === 'raise' || l.action === 'bet');
  const hasCall = v.legalActions.some((l) => l.action === 'call');
  let r = hasRaise ? Math.round(raise) : 0;
  let c = hasCall ? Math.round(call) : 0;
  if (!hasRaise && raise) c = Math.min(100, c + Math.round(raise)); // can't raise (short all-in): call instead
  if (r) freqs.raise = r;
  if (c) freqs.call = c;
  const rest = 100 - r - c;
  if (rest > 0) freqs[passive] = rest;
  return { freqs, raiseToBB, pos, code, spot };
}

/** Sample one action from the advice for the GTO agent. */
export function samplePreflop(a: PreflopAdvice): 'fold' | 'check' | 'call' | 'raise' {
  let x = Math.random() * 100;
  for (const k of ['raise', 'call', 'check', 'fold'] as const) { const p = a.freqs[k] ?? 0; if (x < p) return k; x -= p; }
  return a.freqs.check !== undefined ? 'check' : 'fold';
}
