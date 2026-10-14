import { evaluate, rankValue, type View } from '@pokergarden/engine';
import type { PersonaAgent, Decision } from './types.js';

/** Rule-based calling station. No LLM. Loose-passive: calls a lot, rarely raises, folds only to big bets with junk. */
export const weakAgent: PersonaAgent = {
  name: 'weak',
  async decide(v: View): Promise<Decision> {
    const me = v.seats[v.you!];
    const h = v.hand!;
    const legal = v.legalActions;
    const has = (a: string) => legal.find((l) => l.action === a);
    const cards = me.holeCards!;
    const toCall = has('call')?.amount ?? 0;
    const r1 = rankValue(cards[0]), r2 = rankValue(cards[1]);
    const pair = r1 === r2;
    const suited = cards[0][1] === cards[1][1];
    const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
    const rnd = Math.random();
    let strength = 0; // 0..1
    if (h.street === 'preflop') {
      strength = pair ? 0.5 + (r1 - 2) / 24 : (hi + lo) / 28 * 0.6 + (suited ? 0.05 : 0) + (hi - lo <= 2 ? 0.05 : 0);
    } else {
      const r = evaluate([...cards, ...h.board]);
      const boardOnly = h.board.length >= 5 ? evaluate(h.board) : null;
      strength = Math.min(1, r.category / 8 + 0.1);
      if (r.category === 1) strength = (hi >= 11 ? 0.35 : 0.25) + (pair ? 0.05 : 0);
      if (boardOnly && boardOnly.score === r.score) strength = 0.1; // playing the board
      if (r.category === 0) strength = 0.08;
    }
    const potOdds = toCall / Math.max(1, h.pot + toCall);
    // calling station: call unless the price is awful for our hand
    if (toCall > 0) {
      const maxFrac = 0.12 + strength * 0.9; // junk calls up to ~12% of pot-incl, strong calls anything
      if (strength >= 0.7 && has('raise') && rnd < 0.35) return { action: 'raise', amount: Math.round(Math.max(has('raise')!.min!, h.currentBet * 2.5)) };
      if (potOdds <= maxFrac || toCall <= v.table.bigBlind) return { action: 'call' };
      if (toCall <= me.stack * 0.05 && rnd < 0.5) return { action: 'call' };
      return { action: 'fold' };
    }
    if (has('check')) {
      if (strength >= 0.6 && has('bet') && rnd < 0.5) {
        const bet = has('bet')!; const amt = Math.round(h.pot * 0.5);
        return { action: 'bet', amount: Math.min(bet.max!, Math.max(bet.min!, amt)) };
      }
      return { action: 'check' };
    }
    return { action: 'fold' };
  },
};
