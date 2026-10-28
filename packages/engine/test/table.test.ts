import { describe, it, expect } from 'vitest';
import { Table, viewFor, type Player } from '../src/index.js';

function seqRng(seq: number[]) { let i = 0; return (n: number) => seq[i++ % seq.length] % n; }
const p = (i: number, kind: 'human' | 'bot' = 'human'): Player => ({ id: `p${i}`, name: `P${i}`, kind });
function mk(n: number, stacks: number[] = [], cfg = {}) {
  const t = new Table({ smallBlind: 10, bigBlind: 20, ...cfg }, { rng: () => 0 }); // deterministic deck (identity), dealer = first player
  for (let i = 0; i < n; i++) t.takeSeat(p(i), stacks[i] ?? 1000, i);
  return t;
}
function cur(t: Table) { return t.hand!.actionOn!; }
function a(t: Table, action: any, amt?: number) { t.act(cur(t), action, amt); }

describe('Table betting', () => {
  it('posts blinds and orders action preflop/postflop (3-handed)', () => {
    const t = mk(3);
    t.startHand();
    const h = t.hand!;
    expect(h.dealer).toBe(0); expect(h.sb).toBe(1); expect(h.bb).toBe(2);
    expect(t.seats[1].streetBet).toBe(10); expect(t.seats[2].streetBet).toBe(20);
    expect(cur(t)).toBe(0); // UTG = dealer when 3-handed
    a(t, 'call'); expect(cur(t)).toBe(1);
    a(t, 'call'); expect(cur(t)).toBe(2); // BB option
    expect(t.legalActions(2).map((l) => l.action)).toEqual(['fold', 'check', 'raise']);
    a(t, 'check');
    expect(h.street).toBe('flop'); expect(h.board.length).toBe(3);
    expect(cur(t)).toBe(1); // SB first postflop
    expect(t.potTotal).toBe(60);
  });

  it('heads-up: dealer is SB and acts first preflop, last postflop', () => {
    const t = mk(2);
    t.startHand();
    const h = t.hand!;
    expect(h.sb).toBe(h.dealer); expect(cur(t)).toBe(h.dealer);
    a(t, 'call'); a(t, 'check');
    expect(h.street).toBe('flop'); expect(cur(t)).toBe(h.bb);
  });

  it('min-raise rules and short all-in not reopening action', () => {
    const t = mk(3, [1000, 1000, 1000]);
    t.startHand();
    // seat0 raises to 60 (raise by 40)
    a(t, 'raise', 60);
    expect(t.hand!.minRaise).toBe(40);
    const la1 = t.legalActions(1).find((l) => l.action === 'raise')!;
    expect(la1.min).toBe(100);
    expect(() => t.act(1, 'raise', 90)).toThrow();
    a(t, 'raise', 100); // seat1 raise to 100 (by 40)
    a(t, 'fold'); // seat2 (BB)
    // seat0 faces 100, can re-raise
    expect(t.legalActions(0).map((l) => l.action)).toContain('raise');
    a(t, 'call');
    expect(t.hand!.street).toBe('flop');
  });

  it('player who already acted cannot re-raise after a short all-in', () => {
    const t = mk(3, [1000, 1000, 50]);
    t.startHand(); // BB (seat2) has 50, posts 20
    a(t, 'raise', 60); // seat0 to 60
    a(t, 'call');      // seat1 calls 60
    // seat2 all-in to 50 total? already has 20 in; stack 30 -> max 50 < currentBet 60 -> can only call (all-in) or fold
    expect(t.legalActions(2).map((l) => l.action)).toEqual(['fold', 'call']);
    a(t, 'call');
    expect(t.seats[2].allIn).toBe(true);
    expect(t.hand!.street).toBe('flop'); // no further preflop action: everyone matched
  });

  it('short all-in raise: already-acted players may only call/fold', () => {
    const t = mk(4, [1000, 1000, 1000, 70]);
    t.startHand(); // dealer 0, sb 1, bb 2, utg 3
    a(t, 'call'); // seat3 calls 20
    a(t, 'raise', 60); // seat0 raises to 60
    a(t, 'fold'); a(t, 'fold'); // seat1, seat2
    // seat3 raises all-in to 70 (raise by 10 < minRaise 40): short
    expect(t.legalActions(3).find((l) => l.action === 'raise')!.min).toBe(70);
    a(t, 'raise', 70);
    expect(cur(t)).toBe(0);
    expect(t.legalActions(0).map((l) => l.action)).toEqual(['fold', 'call']);
    a(t, 'call');
    expect(t.hand!.street).toBe('showdown'); // both all-in or matched, runs out
    expect(t.handDone).toBe(true);
  });

  it('uncontested pot goes to last player; humans do not show, agents do', () => {
    const t = mk(3);
    t.startHand();
    a(t, 'fold'); a(t, 'fold');
    expect(t.handDone).toBe(true);
    expect(t.seats[2].stack).toBe(1010);
    const v = viewFor(t, 0);
    expect(v.seats[2].holeCards).toBeNull();
    expect(v.seats[1].holeCards).toBeNull();
    const t2 = new Table({ smallBlind: 10, bigBlind: 20 }, { rng: () => 0 });
    t2.takeSeat(p(0), 1000, 0); t2.takeSeat(p(1), 1000, 1); t2.takeSeat(p(2, 'bot'), 1000, 2);
    t2.startHand();
    t2.act(0, 'fold'); t2.act(1, 'fold');
    expect(viewFor(t2, 0).seats[2].holeCards).toHaveLength(2);
  });

  it('side pots: three-way all-in with different stacks', () => {
    const t = mk(3, [100, 300, 500]);
    t.startHand(); // d0 sb1 bb2
    a(t, 'raise', 100); // seat0 all-in 100
    a(t, 'raise', 300); // seat1 all-in 300
    a(t, 'call');       // seat2 calls 300
    expect(t.handDone).toBe(true);
    const pots = t.hand!.pots!;
    expect(pots.map((p) => p.amount)).toEqual([300, 400]);
    expect(pots[0].eligible).toEqual([0, 1, 2]);
    expect(pots[1].eligible).toEqual([1, 2]);
    const total = t.seats.reduce((a, s) => a + s.stack, 0);
    expect(total).toBe(900);
  });

  it('folded player leftover goes to the pot', () => {
    const t = mk(3, [50, 1000, 1000]);
    t.startHand();
    a(t, 'call'); // seat0 calls 20 (stack 30 left)
    a(t, 'raise', 200); // seat1 to 200
    a(t, 'fold'); // seat2 folds (20 in)
    a(t, 'call'); // seat0 calls all-in 50
    expect(t.handDone).toBe(true);
    // pot: 50+50+20 =120 main for seat0/1; seat1's extra 150 returned via last pot (only seat1 eligible)
    const total = t.seats.reduce((a, s) => a + s.stack, 0);
    expect(total).toBe(2050);
    expect(t.seats[2].stack).toBe(980);
  });

  it('timeout: check if possible else fold, with one-shot time bank', () => {
    let now = 1_000_000;
    const t = new Table({ decisionMs: 1000, timeBankMs: 500 }, { rng: () => 0, now: () => now });
    for (let i = 0; i < 3; i++) t.takeSeat(p(i), 1000, i);
    t.startHand();
    const first = cur(t);
    expect(t.tick(now + 999)).toBe(false);
    expect(t.tick(now + 1000)).toBe(false); // time bank kicks in
    expect(t.hand!.usingTimeBank).toBe(true);
    expect(t.tick(now + 1499)).toBe(false);
    expect(t.tick(now + 1500)).toBe(true);
    expect(t.seats[first].folded).toBe(true);
  });

  it('streetDelayMs: next street is dealt by tick() after the pause, all-in runouts street by street', () => {
    let now = 1_000_000;
    const t = new Table({ decisionMs: 0, streetDelayMs: 1000 }, { rng: () => 0, now: () => now });
    for (let i = 0; i < 2; i++) t.takeSeat(p(i), 1000, i);
    t.startHand();
    t.act(cur(t), 'raise', 1000); // shove
    t.act(cur(t), 'call');
    expect(t.hand!.board.length).toBe(0);
    expect(t.hand!.actionOn).toBeNull();
    expect(t.hand!.dealAt).toBe(now + 1000);
    expect(t.tick(now + 999)).toBe(false);
    expect(t.tick(now + 1000)).toBe(true);
    expect(t.hand!.board.length).toBe(3);
    expect(t.hand!.dealAt).toBe(now + 1000); // next pause scheduled from the same clock
    now += 1000; expect(t.tick(now)).toBe(true); expect(t.hand!.board.length).toBe(4);
    expect(t.tick(now)).toBe(false);
    now += 1000; expect(t.tick(now)).toBe(true); expect(t.hand!.board.length).toBe(5);
    expect(t.handDone).toBe(false);
    now += 1000; expect(t.tick(now)).toBe(true); expect(t.handDone).toBe(true);
    expect(t.tick(now + 5000)).toBe(false);
  });

  it('decision id must match', () => {
    const t = mk(3);
    t.startHand();
    expect(() => t.act(cur(t), 'call', undefined, 'nope')).toThrow(/stale/);
    t.act(cur(t), 'call', undefined, t.hand!.decisionId);
  });

  it('leaving mid-hand folds immediately (even out of turn) and removes after the hand', () => {
    const t = mk(3);
    t.startHand();
    const total = t.seats.reduce((x, s) => x + s.stack, 0) + t.potTotal;
    t.leaveSeat(1); // not their turn: folded, seat freed at once, their 10 SB stays in the pot
    expect(t.seats[1].player).toBeNull();
    expect(t.potTotal).toBe(30);
    const left = t.events.find((e) => e.type === 'seat_left') as any;
    expect(left.stack).toBe(990); // leaver keeps their stack
    // someone can take the freed seat right away (dealt in next hand)
    t.takeSeat(p(9), 500, 1);
    expect(t.seats[1].inHand).toBe(false);
    a(t, 'call'); // seat0
    expect(cur(t)).toBe(2); // seat1 skipped
    a(t, 'check');
    while (!t.handDone) a(t, 'check');
    expect(t.seats.reduce((x, s) => x + s.stack, 0) - 500 + left.stack).toBe(total);
    expect(t.potTotal).toBe(0);
  });
  it('leaving when everyone else folded awards the pot and ends the hand', () => {
    const t = mk(3);
    t.startHand();
    a(t, 'fold'); // seat0
    t.leaveSeat(1); // seat1 (SB) leaves while on action -> fold -> seat2 wins
    expect(t.handDone).toBe(true);
    expect(t.seats[2].stack).toBe(1010);
  });
  it('leaving out of turn when only one other player is live ends the hand', () => {
    const t = mk(3);
    t.startHand();
    a(t, 'fold'); // seat0; action on seat1
    t.leaveSeat(2); // BB leaves out of turn -> seat1 wins uncontested
    expect(t.handDone).toBe(true);
    expect(t.seats[1].stack).toBe(1020);
  });
});

describe('view redaction', () => {
  it('never shows other players hole cards before showdown, and shows own', () => {
    const t = mk(4);
    t.startHand();
    for (let i = 0; i < 4; i++) {
      const v = viewFor(t, i);
      expect(v.seats[i].holeCards).toEqual(t.seats[i].holeCards);
      for (let j = 0; j < 4; j++) if (j !== i) expect(v.seats[j].holeCards).toBeNull();
      expect(JSON.stringify(v)).not.toContain('"deck":');
      expect(v.hand!.nonce).toBeNull();
    }
    const spec = viewFor(t, null);
    for (let j = 0; j < 4; j++) expect(spec.seats[j].holeCards).toBeNull();
    expect(spec.legalActions).toEqual([]);
  });
  it('reveals shown cards and nonce after showdown', () => {
    const t = mk(2);
    t.startHand();
    while (!t.handDone) a(t, t.legalActions(cur(t)).some((l) => l.action === 'check') ? 'check' : 'call');
    const v = viewFor(t, null);
    expect(v.seats[0].holeCards).toHaveLength(2);
    expect(v.seats[1].holeCards).toHaveLength(2);
    expect(v.hand!.nonce).not.toBeNull();
  });
});

describe('leaves during random play conserve chips', () => {
  it('random leaves/rejoins never create or destroy chips', () => {
    const randomInt = (n: number) => Math.floor(Math.random() * n);
    const t = new Table({ smallBlind: 10, bigBlind: 20 });
    let next = 0; let bank = 0; // chips held by players who left
    for (let i = 0; i < 6; i++) t.takeSeat(p(next++), 1000, i);
    let total = 6000;
    for (let h = 0; h < 300; h++) {
      t.clearHand();
      while (t.seats.filter((s) => s.player && s.stack > 0).length < 2) { t.takeSeat(p(next++), 1000); total += 1000; }
      for (const s of t.seats) if (s.player && s.stack === 0) { t.leaveSeat(s.idx); }
      t.startHand();
      while (!t.handDone) {
        if (randomInt(8) === 0) { const occ = t.seats.filter((s) => s.player && s.inHand); const v = occ[randomInt(occ.length)]; bank += v.stack; t.leaveSeat(v.idx); if (t.handDone) break; }
        if (randomInt(10) === 0 && t.seats.some((s) => !s.player)) { t.takeSeat(p(next++), 500 + randomInt(1500)); total += t.seats.find((s) => s.player?.id === `p${next - 1}`)!.stack; }
        const seat = t.hand!.actionOn!; const legal = t.legalActions(seat); const pick = legal[randomInt(legal.length)];
        t.act(seat, pick.action as any, pick.action === 'bet' || pick.action === 'raise' ? pick.min! + randomInt(pick.max! - pick.min! + 1) : undefined);
      }
      const onTable = t.seats.reduce((a, s) => a + s.stack, 0);
      expect(onTable + bank).toBe(total);
      expect(t.potTotal).toBe(0);
    }
  });
});

describe('no decision timer', () => {
  it('decisionMs = 0 means no deadline and tick never auto-acts', () => {
    const t = new Table({ decisionMs: 0, timeBankMs: 30000 }, { rng: () => 0 });
    for (let i = 0; i < 3; i++) t.takeSeat(p(i), 1000, i);
    t.startHand();
    expect(t.hand!.deadline).toBeNull();
    expect(t.tick(Date.now() + 10 * 60 * 60 * 1000)).toBe(false);
    expect(t.hand!.actionOn).not.toBeNull();
  });
});

describe('shuffle seats', () => {
  it('moves every player to a new random seat, keeps stacks, refuses mid-hand', () => {
    const t = new Table({ smallBlind: 10, bigBlind: 20 });
    for (let i = 0; i < 5; i++) t.takeSeat(p(i), 1000 + i, i);
    t.startHand();
    expect(() => t.shuffleSeats()).toThrow(/during a hand/);
    while (!t.handDone) { const s = t.hand!.actionOn!; t.act(s, t.legalActions(s).some((l) => l.action === 'check') ? 'check' : 'fold'); }
    const before = new Map(t.seats.filter((s) => s.player).map((s) => [s.player!.id, s.stack]));
    const moves = t.shuffleSeats();
    expect(moves).toHaveLength(5);
    const after = t.seats.filter((s) => s.player);
    expect(after).toHaveLength(5);
    for (const s of after) { expect(before.get(s.player!.id)).toBe(s.stack); expect(t.seats[s.idx]).toBe(s); }
    expect(t.hand).toBeNull();
    t.startHand(); // still playable
  });
});
