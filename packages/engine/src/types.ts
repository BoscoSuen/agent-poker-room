import type { Card } from './cards.js';

export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise';
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
export type PlayerKind = 'human' | 'bot';
export type Persona = 'default' | 'aggressive' | 'weak' | 'gto';

export interface TableConfig {
  name: string;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  maxSeats: number;        // 9
  defaultStack: number;    // in chips
  decisionMs: number;      // per decision
  timeBankMs: number;      // extra, one-shot per hand refilled every hand
  autoFillTo: number;      // bots fill empty seats up to this many players (7)
  showdownMs: number;      // pause after hand ends before next hand
  botPersonas: Persona[];  // personas used when auto-filling (cycled)
}

export const DEFAULT_CONFIG: TableConfig = {
  name: 'Poker Garden',
  smallBlind: 10,
  bigBlind: 20,
  ante: 0,
  maxSeats: 9,
  defaultStack: 2000,
  decisionMs: 20_000,
  timeBankMs: 30_000,
  autoFillTo: 7,
  showdownMs: 5_000,
  botPersonas: ['default', 'aggressive', 'weak', 'gto'],
};

export interface Player {
  id: string;        // stable player id (token-derived for humans)
  name: string;
  kind: PlayerKind;
  persona?: Persona;
}

export interface Seat {
  idx: number;
  player: Player | null;
  stack: number;
  streetBet: number;
  handBet: number;
  inHand: boolean;      // dealt into current hand
  folded: boolean;
  allIn: boolean;
  sittingOut: boolean;
  holeCards: Card[];
  showCards: boolean;   // revealed (showdown)
  connected: boolean;
  timeBankMs: number;
  actedRaiseId: number;
  lastAction: string | null;
  pendingLeave: boolean;
}

export interface PlayerAction {
  seat: number;
  street: Street;
  action: ActionType | 'sb' | 'bb' | 'ante' | 'timeout';
  amount: number;       // chips put in by this action (for bet/raise: new street total "to")
  to?: number;          // street total after action (bet/raise/call)
  allIn: boolean;
}

export interface Pot {
  amount: number;
  eligible: number[];   // seat indices
}

export interface PotResult {
  potIndex: number;
  amount: number;
  winners: { seat: number; amount: number; hand?: string; cards?: Card[] }[];
}

export interface Hand {
  no: number;
  deckCommit: string;
  nonce: string | null;        // revealed when hand ends
  deck: Card[];                // PRIVATE. never leaves the engine
  board: Card[];
  street: Street;
  dealer: number;
  sb: number;
  bb: number;
  actionOn: number | null;
  currentBet: number;
  minRaise: number;
  raiseId: number;
  needAction: number[];
  lastAggressor: number | null;
  decisionId: string;
  deadline: number | null;
  usingTimeBank: boolean;
  history: PlayerAction[];
  pots: Pot[] | null;
  results: PotResult[] | null;
  deadMoney: number;           // chips left in the pot by players who left mid-hand
  startedAt: number;
  endedAt: number | null;
}

export type TableStatus = 'waiting' | 'playing' | 'paused' | 'closed';

export interface TableState {
  id: string;
  config: TableConfig;
  seats: Seat[];
  hand: Hand | null;
  handNo: number;
  status: TableStatus;
  dealerSeat: number | null;
  createdAt: number;
  running: boolean;  // host pressed start; hands auto-continue
}

export type TableEvent =
  | { type: 'seat_taken'; seat: number; player: Player; stack: number }
  | { type: 'seat_left'; seat: number; player: Player; stack: number }
  | { type: 'sit_out'; seat: number; sittingOut: boolean }
  | { type: 'hand_started'; no: number; dealer: number; sb: number; bb: number; deckCommit: string; seats: number[] }
  | { type: 'hole_cards'; seat: number; cards: Card[] }          // private
  | { type: 'post'; seat: number; kind: 'sb' | 'bb' | 'ante'; amount: number; allIn: boolean }
  | { type: 'action'; seat: number; action: ActionType; amount: number; to: number; allIn: boolean; timeout?: boolean }
  | { type: 'street'; street: Street; board: Card[] }
  | { type: 'showdown'; seat: number; cards: Card[]; hand: string }
  | { type: 'pot_awarded'; seat: number; amount: number; potIndex: number; hand?: string }
  | { type: 'hand_ended'; no: number; nonce: string; deck: Card[] }
  | { type: 'status'; status: TableStatus; running: boolean }
  | { type: 'chat'; from: string; seat: number | null; text: string; channel: 'table' | 'commentary' };

export interface LegalAction {
  action: ActionType;
  min?: number;   // for bet/raise: minimum "to" amount
  max?: number;   // for bet/raise: maximum "to" amount (all-in)
  amount?: number; // for call: chips needed
}
