import { randomBytes } from 'node:crypto';
import { type Card, newDeck, shuffle, commitDeck, newNonce, type Rng, cryptoRng } from './cards.js';
import { evaluate } from './evaluator.js';
import {
  type ActionType, type Hand, type LegalAction, type Player, type Pot, type PotResult, type Seat,
  type Street, type TableConfig, type TableEvent, type TableState, DEFAULT_CONFIG,
} from './types.js';

export class EngineError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface TableOptions {
  rng?: Rng;
  now?: () => number;
  id?: string;
}

const STREETS: Street[] = ['preflop', 'flop', 'turn', 'river', 'showdown'];

function emptySeat(idx: number): Seat {
  return {
    idx, player: null, stack: 0, streetBet: 0, handBet: 0, inHand: false, folded: false, allIn: false,
    sittingOut: false, holeCards: [], showCards: false, connected: true, timeBankMs: 0, actedRaiseId: -1,
    lastAction: null, pendingLeave: false,
  };
}

/**
 * Single-table No-Limit Hold'em engine. All state lives here. Mutating methods
 * append events to `events` and notify listeners. No I/O, no timers: the host
 * runtime calls `tick(now)` to enforce deadlines.
 */
export class Table {
  readonly state: TableState;
  readonly events: TableEvent[] = [];
  private listeners = new Set<(ev: TableEvent, t: Table) => void>();
  private rng: Rng;
  private now: () => number;

  constructor(config: Partial<TableConfig> = {}, opts: TableOptions = {}) {
    this.rng = opts.rng ?? cryptoRng;
    this.now = opts.now ?? Date.now;
    const cfg = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      id: opts.id ?? randomBytes(6).toString('hex'),
      config: cfg,
      seats: Array.from({ length: cfg.maxSeats }, (_, i) => emptySeat(i)),
      hand: null, handNo: 0, status: 'waiting', dealerSeat: null, createdAt: this.now(), running: false,
    };
  }

  onEvent(fn: (ev: TableEvent, t: Table) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(ev: TableEvent) {
    this.events.push(ev);
    for (const l of this.listeners) l(ev, this);
  }

  // ---------- seating ----------

  get seats(): Seat[] { return this.state.seats; }
  get hand(): Hand | null { return this.state.hand; }
  get config(): TableConfig { return this.state.config; }

  seatOfPlayer(playerId: string): Seat | undefined {
    return this.seats.find((s) => s.player?.id === playerId);
  }

  takeSeat(player: Player, stack: number, seatIdx?: number): Seat {
    if (this.state.status === 'closed') throw new EngineError('closed', 'table closed');
    if (this.seatOfPlayer(player.id)) throw new EngineError('already_seated', 'player already seated');
    if (!(stack > 0)) throw new EngineError('bad_stack', 'stack must be positive');
    let seat: Seat | undefined;
    if (seatIdx === undefined) seat = this.seats.find((s) => !s.player);
    else {
      seat = this.seats[seatIdx];
      if (!seat) throw new EngineError('bad_seat', 'no such seat');
      if (seat.player) throw new EngineError('seat_taken', 'seat is taken');
    }
    if (!seat) throw new EngineError('full', 'table is full');
    Object.assign(seat, emptySeat(seat.idx), { player, stack: Math.floor(stack), timeBankMs: this.config.timeBankMs });
    this.emit({ type: 'seat_taken', seat: seat.idx, player, stack: seat.stack });
    return seat;
  }

  /** Leave now if not in a hand; otherwise fold at next opportunity and leave when the hand ends. */
  leaveSeat(seatIdx: number): void {
    const seat = this.seats[seatIdx];
    if (!seat?.player) return;
    const hand = this.hand;
    if (seat.inHand && hand && !this.handDone) {
      // fold now; the chips already in the pot stay there as dead money and the seat is freed immediately
      seat.pendingLeave = true;
      if (!seat.folded) {
        if (hand.actionOn === seatIdx) this.act(seatIdx, 'fold');
        else this.foldOutOfTurn(seat);
      }
      if (!this.handDone) {
        hand.deadMoney += seat.handBet;
        seat.handBet = 0; seat.streetBet = 0;
      }
    }
    if (seat.player) this.removeSeat(seat);
  }
  /** Fold a seat that is not currently on action (player left). */
  private foldOutOfTurn(seat: Seat) {
    const hand = this.hand!;
    seat.folded = true;
    seat.lastAction = 'fold';
    hand.needAction = hand.needAction.filter((i) => i !== seat.idx);
    hand.history.push({ seat: seat.idx, street: hand.street, action: 'fold', amount: 0, to: seat.streetBet, allIn: false });
    this.emit({ type: 'action', seat: seat.idx, action: 'fold', amount: 0, to: seat.streetBet, allIn: false });
    const live = this.livePlayers();
    if (live.length === 1) { this.endHandUncontested(live[0]); return; }
    if (hand.actionOn === null && hand.needAction.length === 0) this.finishStreet();
  }
  private removeSeat(seat: Seat) {
    const player = seat.player!;
    const stack = seat.stack;
    Object.assign(seat, emptySeat(seat.idx));
    this.emit({ type: 'seat_left', seat: seat.idx, player, stack });
  }

  setSittingOut(seatIdx: number, sittingOut: boolean) {
    const seat = this.seats[seatIdx];
    if (!seat?.player) return;
    seat.sittingOut = sittingOut;
    this.emit({ type: 'sit_out', seat: seatIdx, sittingOut });
  }

  setConnected(seatIdx: number, connected: boolean) {
    const seat = this.seats[seatIdx];
    if (seat?.player) seat.connected = connected;
  }

  addChips(seatIdx: number, amount: number) {
    const seat = this.seats[seatIdx];
    if (!seat?.player) throw new EngineError('bad_seat', 'empty seat');
    seat.stack += Math.floor(amount);
  }

  /** Randomly reassign every seated player to a seat (between hands only). Button is re-drawn. Returns [from, to] moves. */
  shuffleSeats(): [number, number][] {
    if (this.hand && !this.handDone) throw new EngineError('hand_in_progress', 'cannot shuffle during a hand');
    this.clearHand();
    const occupied = this.seats.filter((s) => s.player);
    const targets = shuffle(this.seats.map((s) => s.idx), this.rng).slice(0, occupied.length);
    const next = this.seats.map((s) => emptySeat(s.idx));
    const moves: [number, number][] = [];
    occupied.forEach((s, i) => { const to = targets[i]; Object.assign(next[to], s, { idx: to }); moves.push([s.idx, to]); });
    this.state.seats = next;
    this.state.dealerSeat = null;
    this.emit({ type: 'seats_shuffled', moves });
    return moves;
  }

  setRunning(running: boolean) {
    this.state.running = running;
    if (!running && !this.hand) this.state.status = 'waiting';
    this.emit({ type: 'status', status: this.state.status, running });
  }

  close() {
    this.state.status = 'closed';
    this.state.running = false;
    this.emit({ type: 'status', status: 'closed', running: false });
  }

  /** Seats eligible to be dealt in. */
  private eligibleSeats(): Seat[] {
    return this.seats.filter((s) => s.player && s.stack > 0 && !s.sittingOut && !s.pendingLeave);
  }
  canStartHand(): boolean {
    return this.state.status !== 'closed' && !this.hand && this.eligibleSeats().length >= 2;
  }

  // ---------- hand lifecycle ----------

  private nextOccupied(from: number, pred: (s: Seat) => boolean): number {
    const n = this.seats.length;
    for (let k = 1; k <= n; k++) {
      const s = this.seats[(from + k) % n];
      if (pred(s)) return s.idx;
    }
    return -1;
  }

  startHand(): Hand {
    if (!this.canStartHand()) throw new EngineError('cannot_start', 'cannot start a hand');
    const players = this.eligibleSeats();
    const inHand = (s: Seat) => s.inHand;
    // reset seats
    for (const s of this.seats) {
      s.streetBet = 0; s.handBet = 0; s.folded = false; s.allIn = false; s.holeCards = []; s.showCards = false;
      s.lastAction = null; s.actedRaiseId = -1; s.inHand = players.includes(s);
      if (s.player) s.timeBankMs = this.config.timeBankMs;
    }
    const no = ++this.state.handNo;
    // button
    const dealer = this.state.dealerSeat === null
      ? players[this.rng(players.length)].idx
      : this.nextOccupied(this.state.dealerSeat, inHand);
    this.state.dealerSeat = dealer;
    const headsUp = players.length === 2;
    const sb = headsUp ? dealer : this.nextOccupied(dealer, inHand);
    const bb = this.nextOccupied(sb, inHand);

    const deck = shuffle(newDeck(), this.rng);
    const nonce = newNonce();
    const hand: Hand = {
      no, deckCommit: commitDeck(deck, nonce), nonce, deck, board: [], street: 'preflop', dealer, sb, bb,
      actionOn: null, currentBet: 0, minRaise: this.config.bigBlind, raiseId: 0, needAction: [], lastAggressor: null,
      decisionId: '', deadline: null, usingTimeBank: false, history: [], pots: null, results: null, deadMoney: 0,
      startedAt: this.now(), endedAt: null,
    };
    this.state.hand = hand;
    this.state.status = 'playing';
    this.emit({ type: 'hand_started', no, dealer, sb, bb, deckCommit: hand.deckCommit, seats: players.map((s) => s.idx) });

    // antes
    if (this.config.ante > 0) {
      for (const s of players) this.post(s, 'ante', this.config.ante);
    }
    // blinds
    this.post(this.seats[sb], 'sb', this.config.smallBlind);
    this.post(this.seats[bb], 'bb', this.config.bigBlind);
    hand.currentBet = Math.max(...players.map((s) => s.streetBet));
    hand.minRaise = this.config.bigBlind;

    // deal: one card at a time starting left of dealer, deck top = index 0
    let di = 0;
    const order: Seat[] = [];
    let cur = dealer;
    for (let k = 0; k < players.length; k++) { cur = this.nextOccupied(cur, inHand); order.push(this.seats[cur]); }
    for (let round = 0; round < 2; round++) for (const s of order) s.holeCards.push(deck[di++]);
    hand.deck = deck; // remaining deals read from deck[2*players.length + ...]
    (hand as any)._deckIdx = di;
    for (const s of order) this.emit({ type: 'hole_cards', seat: s.idx, cards: [...s.holeCards] });

    // action order preflop: left of BB
    this.beginStreet('preflop', bb);
    return hand;
  }

  private post(seat: Seat, kind: 'sb' | 'bb' | 'ante', amount: number) {
    const hand = this.hand!;
    const amt = Math.min(amount, seat.stack);
    seat.stack -= amt;
    if (kind === 'ante') seat.handBet += amt; // antes go straight to the pot
    else { seat.streetBet += amt; seat.handBet += amt; }
    if (seat.stack === 0) seat.allIn = true;
    hand.history.push({ seat: seat.idx, street: 'preflop', action: kind, amount: amt, to: seat.streetBet, allIn: seat.allIn });
    this.emit({ type: 'post', seat: seat.idx, kind, amount: amt, allIn: seat.allIn });
  }

  private livePlayers(): Seat[] { return this.seats.filter((s) => s.inHand && !s.folded); }
  private canActPlayers(): Seat[] { return this.livePlayers().filter((s) => !s.allIn); }

  private beginStreet(street: Street, lastBefore: number) {
    const hand = this.hand!;
    hand.street = street;
    if (street !== 'preflop') {
      for (const s of this.seats) { s.streetBet = 0; s.actedRaiseId = -1; }
      hand.currentBet = 0; hand.minRaise = this.config.bigBlind; hand.raiseId = 0; hand.lastAggressor = null;
    }
    const canAct = this.canActPlayers();
    if (canAct.length < 2 && !(street === 'preflop' && canAct.length === 1 && this.needsPreflopDecision(canAct[0]))) {
      hand.needAction = [];
      hand.actionOn = null;
      this.finishStreet();
      return;
    }
    // order of action: first canAct seat after `lastBefore`
    const order: number[] = [];
    let cur = lastBefore;
    for (let k = 0; k < this.seats.length; k++) {
      cur = (cur + 1) % this.seats.length;
      const s = this.seats[cur];
      if (s.inHand && !s.folded && !s.allIn && !order.includes(cur)) order.push(cur);
      if (order.length === canAct.length) break;
    }
    hand.needAction = order;
    this.setActionOn(order[0]);
  }
  /** Preflop special-case: one player can still act but faces an all-in blind bigger than their own bet. */
  private needsPreflopDecision(s: Seat): boolean {
    return s.streetBet < this.hand!.currentBet;
  }

  private setActionOn(seatIdx: number) {
    const hand = this.hand!;
    hand.actionOn = seatIdx;
    hand.decisionId = randomBytes(6).toString('hex');
    hand.deadline = this.config.decisionMs > 0 ? this.now() + this.config.decisionMs : null; // 0 = no timer, wait forever
    hand.usingTimeBank = false;
  }

  // ---------- actions ----------

  legalActions(seatIdx: number): LegalAction[] {
    const hand = this.hand;
    if (!hand || hand.actionOn !== seatIdx) return [];
    const seat = this.seats[seatIdx];
    const toCall = hand.currentBet - seat.streetBet;
    const out: LegalAction[] = [{ action: 'fold' }];
    if (toCall <= 0) out.push({ action: 'check' });
    else out.push({ action: 'call', amount: Math.min(toCall, seat.stack) });
    const maxTo = seat.streetBet + seat.stack;
    if (hand.currentBet === 0) {
      if (seat.stack > 0) out.push({ action: 'bet', min: Math.min(this.config.bigBlind, maxTo), max: maxTo });
    } else if (seat.stack > toCall && seat.actedRaiseId !== hand.raiseId) {
      const minTo = Math.min(hand.currentBet + hand.minRaise, maxTo);
      out.push({ action: 'raise', min: minTo, max: maxTo });
    }
    return out;
  }

  /**
   * Apply an action for a seat. `amount` is the street total ("to") for bet/raise.
   * Returns the recorded action. Throws EngineError on illegal input.
   */
  act(seatIdx: number, action: ActionType, amount?: number, decisionId?: string, opts: { timeout?: boolean } = {}): void {
    const hand = this.hand;
    if (!hand) throw new EngineError('no_hand', 'no hand in progress');
    if (hand.actionOn !== seatIdx) throw new EngineError('not_your_turn', 'not your turn');
    if (decisionId && decisionId !== hand.decisionId) throw new EngineError('stale_decision', 'stale decision id');
    const seat = this.seats[seatIdx];
    const legal = this.legalActions(seatIdx);
    const la = legal.find((l) => l.action === action);
    if (!la) throw new EngineError('illegal_action', `illegal action ${action}; legal: ${legal.map((l) => l.action).join(',')}`);

    let put = 0;
    let to = seat.streetBet;
    if (action === 'fold') {
      seat.folded = true;
    } else if (action === 'check') {
      // nothing
    } else if (action === 'call') {
      put = la.amount!;
      to = seat.streetBet + put;
    } else {
      // bet / raise: amount = street total "to"
      if (amount === undefined || !Number.isFinite(amount)) throw new EngineError('amount_required', 'amount required');
      to = Math.floor(amount);
      if (to < la.min! || to > la.max!) throw new EngineError('bad_amount', `amount must be between ${la.min} and ${la.max}`);
      put = to - seat.streetBet;
      const raiseBy = to - hand.currentBet;
      const full = raiseBy >= hand.minRaise;
      hand.currentBet = to;
      if (full) { hand.minRaise = raiseBy; hand.raiseId++; }
      hand.lastAggressor = seatIdx;
    }
    seat.stack -= put;
    seat.streetBet += put;
    seat.handBet += put;
    if (seat.stack === 0 && put > 0) seat.allIn = true;
    seat.actedRaiseId = hand.raiseId;
    seat.lastAction = action === 'fold' ? 'fold' : action === 'check' ? 'check' : `${action} ${to}`;
    hand.history.push({ seat: seatIdx, street: hand.street, action, amount: put, to, allIn: seat.allIn });
    this.emit({ type: 'action', seat: seatIdx, action, amount: put, to, allIn: seat.allIn, timeout: opts.timeout });

    // who still needs to act?
    if (action === 'bet' || action === 'raise') {
      // everyone else who can act must respond
      // everyone else who can act must respond, clockwise from the aggressor
      const order: number[] = [];
      let cur = seatIdx;
      for (let k = 0; k < this.seats.length - 1; k++) {
        cur = (cur + 1) % this.seats.length;
        const s = this.seats[cur];
        if (s.inHand && !s.folded && !s.allIn) order.push(cur);
      }
      hand.needAction = order;
    } else {
      hand.needAction = hand.needAction.filter((i) => i !== seatIdx);
    }
    hand.needAction = hand.needAction.filter((i) => { const s = this.seats[i]; return s.inHand && !s.folded && !s.allIn; });
    this.advance();
  }

  /** Enforce the decision deadline. Returns true if an auto action was taken. */
  tick(now = this.now()): boolean {
    const hand = this.hand;
    if (!hand || hand.actionOn === null || hand.deadline === null || now < hand.deadline) return false;
    const seat = this.seats[hand.actionOn];
    if (!hand.usingTimeBank && seat.timeBankMs > 0) {
      hand.usingTimeBank = true;
      hand.deadline = now + seat.timeBankMs;
      seat.timeBankMs = 0;
      return false;
    }
    const legal = this.legalActions(seat.idx);
    const auto: ActionType = legal.some((l) => l.action === 'check') ? 'check' : 'fold';
    this.act(seat.idx, auto, undefined, undefined, { timeout: true });
    return true;
  }

  private advance() {
    const hand = this.hand!;
    const live = this.livePlayers();
    if (live.length === 1) { this.endHandUncontested(live[0]); return; }
    if (hand.needAction.length === 0) { this.finishStreet(); return; }
    // next to act: keep order
    this.setActionOn(hand.needAction[0]);
  }

  private dealBoard(n: number) {
    const hand = this.hand!;
    const h = hand as any;
    for (let i = 0; i < n; i++) hand.board.push(hand.deck[h._deckIdx++]);
  }

  private finishStreet() {
    const hand = this.hand!;
    hand.actionOn = null; hand.deadline = null;
    const idx = STREETS.indexOf(hand.street);
    const next = STREETS[idx + 1];
    if (next === 'showdown') { this.showdown(); return; }
    this.dealBoard(next === 'flop' ? 3 : 1);
    this.emit({ type: 'street', street: next, board: [...hand.board] });
    this.beginStreet(next, hand.dealer);
  }

  // ---------- pots & showdown ----------

  computePots(): Pot[] {
    const contrib = this.seats.filter((s) => s.handBet > 0).map((s) => ({ idx: s.idx, amt: s.handBet, live: s.inHand && !s.folded }));
    if (this.hand && this.hand.deadMoney > 0) contrib.push({ idx: -1, amt: this.hand.deadMoney, live: false });
    const pots: Pot[] = [];
    for (;;) {
      const liveLeft = contrib.filter((c) => c.live && c.amt > 0);
      if (liveLeft.length === 0) break;
      const level = Math.min(...liveLeft.map((c) => c.amt));
      let amount = 0;
      const eligible: number[] = [];
      for (const c of contrib) {
        const take = Math.min(c.amt, level);
        amount += take; c.amt -= take;
        if (c.live && take === level) eligible.push(c.idx);
      }
      pots.push({ amount, eligible });
    }
    // leftover from folded players (contributed more than any live player) -> last pot
    const leftover = contrib.reduce((a, c) => a + c.amt, 0);
    if (leftover > 0) {
      if (pots.length === 0) pots.push({ amount: 0, eligible: this.livePlayers().map((s) => s.idx) });
      pots[pots.length - 1].amount += leftover;
      for (const c of contrib) c.amt = 0;
    }
    // merge pots with identical eligibility (cosmetic)
    const merged: Pot[] = [];
    for (const p of pots) {
      const last = merged[merged.length - 1];
      if (last && last.eligible.join() === p.eligible.join()) last.amount += p.amount; else merged.push({ ...p, eligible: [...p.eligible] });
    }
    return merged;
  }

  get potTotal(): number { return this.seats.reduce((a, s) => a + s.handBet, 0) + (this.hand?.deadMoney ?? 0); }

  private showdown() {
    const hand = this.hand!;
    hand.street = 'showdown';
    hand.actionOn = null; hand.deadline = null;
    const live = this.livePlayers();
    const ranks = new Map<number, ReturnType<typeof evaluate>>();
    // show order: last aggressor first, then clockwise
    const start = hand.lastAggressor ?? this.nextOccupied(hand.dealer, (s) => s.inHand && !s.folded);
    const order = [start];
    let cur = start;
    for (let k = 0; k < this.seats.length; k++) { cur = (cur + 1) % this.seats.length; const s = this.seats[cur]; if (s.inHand && !s.folded && !order.includes(cur)) order.push(cur); }
    for (const i of order) {
      const s = this.seats[i];
      const r = evaluate([...s.holeCards, ...hand.board]);
      ranks.set(i, r);
      s.showCards = true;
      this.emit({ type: 'showdown', seat: i, cards: [...s.holeCards], hand: r.name });
    }
    const pots = this.computePots();
    hand.pots = pots;
    const results: PotResult[] = [];
    pots.forEach((pot, pi) => {
      let best = -1; let winners: number[] = [];
      for (const i of pot.eligible) {
        const sc = ranks.get(i)!.score;
        if (sc > best) { best = sc; winners = [i]; } else if (sc === best) winners.push(i);
      }
      // odd chips: first winner clockwise from the dealer
      const ordered: number[] = [];
      let c = hand.dealer;
      for (let k = 0; k < this.seats.length; k++) { c = (c + 1) % this.seats.length; if (winners.includes(c)) ordered.push(c); }
      const share = Math.floor(pot.amount / ordered.length);
      let odd = pot.amount - share * ordered.length;
      const res: PotResult = { potIndex: pi, amount: pot.amount, winners: [] };
      for (const w of ordered) {
        const amt = share + (odd > 0 ? 1 : 0); if (odd > 0) odd--;
        this.seats[w].stack += amt;
        const r = ranks.get(w)!;
        res.winners.push({ seat: w, amount: amt, hand: r.name, cards: r.cards });
        this.emit({ type: 'pot_awarded', seat: w, amount: amt, potIndex: pi, hand: r.name });
      }
      results.push(res);
    });
    hand.results = results;
    void live;
    this.endHand();
  }

  private endHandUncontested(winner: Seat) {
    const hand = this.hand!;
    hand.actionOn = null; hand.deadline = null;
    const pots = this.computePots();
    hand.pots = pots;
    const total = pots.reduce((a, p) => a + p.amount, 0);
    winner.stack += total;
    // agents always show their cards when they win, even uncontested; humans keep theirs hidden
    if (winner.player?.kind === 'bot') {
      winner.showCards = true;
      this.emit({ type: 'showdown', seat: winner.idx, cards: [...winner.holeCards], hand: 'uncontested' });
    }
    hand.results = [{ potIndex: 0, amount: total, winners: [{ seat: winner.idx, amount: total }] }];
    this.emit({ type: 'pot_awarded', seat: winner.idx, amount: total, potIndex: 0 });
    this.endHand();
  }

  private endHand() {
    const hand = this.hand!;
    hand.endedAt = this.now();
    for (const s of this.seats) { s.handBet = 0; s.streetBet = 0; }
    hand.deadMoney = 0;
    this.emit({ type: 'hand_ended', no: hand.no, nonce: hand.nonce!, deck: [...hand.deck] });
    // keep hand visible as "last hand" until next startHand; status stays 'playing'
    (hand as any)._done = true;
    for (const s of this.seats) {
      if (s.player && s.pendingLeave) this.removeSeat(s);
    }
  }

  /** True when the current hand object is finished (showdown done / uncontested). */
  get handDone(): boolean { return !!this.hand && !!(this.hand as any)._done; }

  /** Clear the finished hand so a new one can start. */
  clearHand() {
    if (this.hand && this.handDone) {
      for (const s of this.seats) { s.inHand = false; s.holeCards = []; s.showCards = false; s.folded = false; s.allIn = false; s.lastAction = null; }
      this.state.hand = null;
      if (!this.state.running) this.state.status = 'waiting';
    }
  }
}
