// Self-play: N random-legal-action hands at a 9-max table; asserts chip conservation and termination.
import { Table, viewFor, type ActionType } from '../src/index.js';
import { randomInt } from 'node:crypto';

const HANDS = Number(process.argv[2] ?? 10000);
const t = new Table({ smallBlind: 10, bigBlind: 20, ante: 0 });
for (let i = 0; i < 9; i++) t.takeSeat({ id: `b${i}`, name: `Bot${i}`, kind: 'bot', persona: 'weak' }, 1000 + randomInt(3000), i);
let total = t.seats.reduce((a, s) => a + s.stack, 0);
let maxSteps = 0; let allIns = 0; let showdowns = 0;
const t0 = Date.now();
for (let h = 0; h < HANDS; h++) {
  // rebuy busted
  for (const s of t.seats) if (s.player && s.stack === 0) { t.addChips(s.idx, 2000); total += 2000; }
  t.clearHand();
  if (!t.canStartHand()) throw new Error('cannot start hand ' + h);
  t.startHand();
  let steps = 0;
  while (!t.handDone) {
    const seat = t.hand!.actionOn!;
    const legal = t.legalActions(seat);
    const v = viewFor(t, seat);
    if (v.legalActions.length !== legal.length) throw new Error('view/legal mismatch');
    const pick = legal[randomInt(legal.length)];
    let amt: number | undefined;
    if (pick.action === 'bet' || pick.action === 'raise') {
      amt = pick.min! + randomInt(pick.max! - pick.min! + 1);
      if (randomInt(4) === 0) amt = pick.max!;
    }
    t.act(seat, pick.action as ActionType, amt, v.hand!.decisionId);
    steps++;
    if (steps > 500) throw new Error('hand did not terminate');
  }
  maxSteps = Math.max(maxSteps, steps);
  if (t.hand!.street === 'showdown') showdowns++;
  if (t.seats.some((s) => s.allIn)) allIns++;
  const now = t.seats.reduce((a, s) => a + s.stack, 0);
  if (now !== total) throw new Error(`chip conservation broken at hand ${h}: ${now} != ${total}`);
  if (t.seats.some((s) => s.stack < 0)) throw new Error('negative stack');
  for (const s of t.seats) if (s.handBet !== 0 || s.streetBet !== 0) throw new Error('bets not cleared');
}
const ms = Date.now() - t0;
console.log(JSON.stringify({ hands: HANDS, ms, perHandUs: Math.round(ms * 1000 / HANDS), maxSteps, showdowns, allIns, total }));
