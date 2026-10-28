import type { Card } from './cards.js';
import type { Table } from './table.js';
import type { LegalAction, PlayerAction, PotResult, Pot, Street, TableStatus, Persona, PlayerKind } from './types.js';

export interface SeatView {
  idx: number;
  name: string | null;
  kind: PlayerKind | null;
  persona?: Persona;
  stack: number;
  streetBet: number;
  handBet: number;
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  sittingOut: boolean;
  connected: boolean;
  holeCards: Card[] | null;   // own cards, or revealed cards at showdown; null = hidden
  lastAction: string | null;
  timeBankMs: number;
  isDealer: boolean;
  isSB: boolean;
  isBB: boolean;
}

export interface HandView {
  no: number;
  street: Street;
  board: Card[];
  pot: number;
  currentBet: number;
  minRaise: number;
  actionOn: number | null;
  decisionId: string;
  deadline: number | null;
  dealAt: number | null;
  usingTimeBank: boolean;
  deckCommit: string;
  nonce: string | null;
  history: PlayerAction[];
  pots: Pot[] | null;
  results: PotResult[] | null;
  done: boolean;
}

export interface View {
  table: { id: string; name: string; smallBlind: number; bigBlind: number; ante: number; status: TableStatus; running: boolean; handNo: number; decisionMs: number; maxSeats: number; autoFillTo: number; defaultStack: number; hintsEnabled: boolean };
  you: number | null;
  seats: SeatView[];
  hand: HandView | null;
  legalActions: LegalAction[];
  now: number;
}

/**
 * The ONLY way state leaves the engine. Redacts everything a seat must not see:
 * other players' hole cards (unless shown at showdown), the deck, the nonce before hand end.
 */
export function viewFor(table: Table, seatIdx: number | null, now = Date.now()): View {
  const st = table.state;
  const hand = st.hand;
  const seats: SeatView[] = st.seats.map((s) => {
    const own = seatIdx !== null && s.idx === seatIdx;
    const reveal = own || s.showCards;
    return {
      idx: s.idx,
      name: s.player?.name ?? null,
      kind: s.player?.kind ?? null,
      persona: s.player?.kind === 'bot' ? s.player.persona : undefined,
      stack: s.stack,
      streetBet: s.streetBet,
      handBet: s.handBet,
      inHand: s.inHand,
      folded: s.folded,
      allIn: s.allIn,
      sittingOut: s.sittingOut,
      connected: s.connected,
      holeCards: s.inHand && reveal ? [...s.holeCards] : null,
      lastAction: s.lastAction,
      timeBankMs: s.timeBankMs,
      isDealer: !!hand && hand.dealer === s.idx,
      isSB: !!hand && hand.sb === s.idx,
      isBB: !!hand && hand.bb === s.idx,
    };
  });
  const done = table.handDone;
  const handView: HandView | null = hand ? {
    no: hand.no, street: hand.street, board: [...hand.board], pot: table.potTotal + (hand.pots?.reduce((a, p) => a + p.amount, 0) ?? 0) * (done ? 1 : 0),
    currentBet: hand.currentBet, minRaise: hand.minRaise, actionOn: hand.actionOn, decisionId: hand.decisionId,
    deadline: hand.deadline, dealAt: hand.dealAt, usingTimeBank: hand.usingTimeBank, deckCommit: hand.deckCommit,
    nonce: done ? hand.nonce : null, history: hand.history.map((h) => ({ ...h })), pots: hand.pots, results: hand.results, done,
  } : null;
  return {
    table: {
      id: st.id, name: st.config.name, smallBlind: st.config.smallBlind, bigBlind: st.config.bigBlind, ante: st.config.ante,
      status: st.status, running: st.running, handNo: st.handNo, decisionMs: st.config.decisionMs, maxSeats: st.config.maxSeats, autoFillTo: st.config.autoFillTo, defaultStack: st.config.defaultStack, hintsEnabled: !!st.config.hintsEnabled,
    },
    you: seatIdx,
    seats,
    hand: handView,
    legalActions: seatIdx !== null ? table.legalActions(seatIdx) : [],
    now,
  };
}
