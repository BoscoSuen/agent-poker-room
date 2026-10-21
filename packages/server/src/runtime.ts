import { randomBytes } from 'node:crypto';
import { Table, viewFor, EngineError, type TableConfig, type TableEvent, type Player, type ActionType, type Persona, type View } from '@pokergarden/engine';
import { appendJsonl, log } from './log.js';
import { config } from './config.js';
import { BOT_LIST } from './bots/names.js';
import { Reads } from './reads.js';

const DISCONNECT_GRACE_MS = 3_000;   // disconnected human on action: auto check/fold after 3 s
const DISCONNECT_KICK_HANDS = 10;   // ...and after 10 such hands the seat is freed
const BOT_DEADLINE_MS = 10_000; // agents always get at most 10 s, even when the table has no decision timer

export interface SeatToken { token: string; seatIdx: number; playerId: string; gameId: string; }
export type ViewListener = (runtime: GameRuntime) => void;

/**
 * One table + its side effects: timers, auto next-hand, seat tokens, event log, listeners.
 * Bots and websockets subscribe through `onChange`; they only ever see `viewFor` output.
 */
export class GameRuntime {
  readonly table: Table;
  readonly reads: Reads;
  readonly id: string;
  hostKey = randomBytes(24).toString('hex');
  tokens = new Map<string, SeatToken>();
  ownerEmail: string | null = null;
  publicUrl: string | null = null;
  lastActivity = Date.now();
  private timer: NodeJS.Timeout | null = null;
  private nextHandTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<ViewListener>();
  private chat: { from: string; seat: number | null; text: string; ts: number; channel: 'table' | 'commentary' }[] = [];
  /** Per-name results across seatings at this table. Settled on leave; live rows computed from current seats. */
  leaderboard = new Map<string, { net: number; sessions: number; hands: number; wins: number }>();
  private wins = new Map<string, number>();         // playerId -> hands won
  private wonThisHand = new Set<string>();
  private buyIn = new Map<string, number>();   // playerId -> total chips bought in
  private handsPlayed = new Map<string, number>();
  closed = false;
  onClose: (() => void) | null = null;

  constructor(cfg: Partial<TableConfig>, id?: string) {
    this.id = id ?? randomBytes(6).toString('hex');
    this.table = new Table(cfg, { id: this.id });
    this.reads = new Reads(this.table);
    this.table.onEvent((ev) => this.handleEvent(ev));
  }

  // ----- subscriptions -----
  onChange(fn: ViewListener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private notify() { for (const l of this.listeners) { try { l(this); } catch (e) { log('runtime', 'listener error', { e: String(e) }); } } }

  private handleEvent(ev: TableEvent) {
    appendJsonl(`game-${this.id}.jsonl`, { ts: Date.now(), ...ev });
    this.reads.onEvent(ev);
    if (ev.type === 'seat_left') this.settle(ev.player.id, ev.player.name, ev.stack);
    if (ev.type === 'action' && ev.timeout) {
      const seat = this.table.seats[ev.seat];
      if (seat.player?.kind === 'human' && !seat.connected) {
        const rec = this.autoHands.get(seat.player.id) ?? { count: 0, lastHand: 0 };
        const no = this.table.hand?.no ?? 0;
        if (rec.lastHand !== no) { rec.count++; rec.lastHand = no; }
        this.autoHands.set(seat.player.id, rec);
        if (rec.count >= DISCONNECT_KICK_HANDS) {
          log('runtime', `kicking ${seat.player.name}: disconnected for ${rec.count} hands`);
          this.say('系统', null, `${seat.player.name} 断线超过 ${DISCONNECT_KICK_HANDS} 手，已请离座。`);
          queueMicrotask(() => this.kick(seat.idx));
        }
      }
    }
    if (ev.type === 'pot_awarded') { const p = this.table.seats[ev.seat].player; if (p) this.wonThisHand.add(p.id); }
    if (ev.type === 'hand_ended') { for (const id of this.wonThisHand) this.wins.set(id, (this.wins.get(id) ?? 0) + 1); this.wonThisHand.clear(); }
    if (ev.type === 'hand_started') for (const i of ev.seats) { const p = this.table.seats[i].player; if (p) this.handsPlayed.set(p.id, (this.handsPlayed.get(p.id) ?? 0) + 1); }
    this.lastActivity = Date.now();
    if (ev.type === 'hand_ended') this.scheduleNextHand();
    // the engine may still be mid-cascade (actionOn/deadline change after this event); finish in a microtask
    queueMicrotask(() => { this.armTimer(); this.armBotDeadline(); this.armDisconnectGrace(); this.notify(); });
  }

  private settle(playerId: string, name: string, stack: number) {
    const net = stack - (this.buyIn.get(playerId) ?? 0);
    const row = this.leaderboard.get(name) ?? { net: 0, sessions: 0, hands: 0, wins: 0 };
    row.net += net; row.sessions += 1; row.hands += this.handsPlayed.get(playerId) ?? 0; row.wins += this.wins.get(playerId) ?? 0;
    this.leaderboard.set(name, row);
    this.buyIn.delete(playerId); this.handsPlayed.delete(playerId); this.wins.delete(playerId);
  }
  /** Settled rows plus live rows for players currently seated (same name accumulates). */
  leaderboardRows() {
    const rows = new Map<string, { name: string; net: number; sessions: number; hands: number; wins: number; seated: boolean; kind?: string }>();
    for (const [name, r] of this.leaderboard) rows.set(name, { name, ...r, seated: false });
    for (const s of this.table.seats) {
      if (!s.player) continue;
      const live = s.stack + s.handBet - (this.buyIn.get(s.player.id) ?? 0);
      const r = rows.get(s.player.name) ?? { name: s.player.name, net: 0, sessions: 0, hands: 0, wins: 0, seated: false };
      r.net += live; r.sessions += 1; r.hands += this.handsPlayed.get(s.player.id) ?? 0; r.wins += this.wins.get(s.player.id) ?? 0; r.seated = true; r.kind = s.player.kind;
      rows.set(s.player.name, r);
    }
    return [...rows.values()].sort((a, b) => b.net - a.net);
  }

  // ----- views -----
  view(seatIdx: number | null): View { return viewFor(this.table, seatIdx); }
  recentChat(n = 50) { return this.chat.slice(-n); }

  // ----- seating -----
  /** Lost your token (new device, cleared storage)? A disconnected human seat with the same nickname can be reclaimed: old token revoked, new one issued. */
  reclaim(name: string): SeatToken | null {
    const seat = this.table.seats.find((s) => s.player?.kind === 'human' && s.player.name === name && !s.connected);
    if (!seat || !seat.player) return null;
    for (const [k, v] of this.tokens) if (v.seatIdx === seat.idx && v.playerId === seat.player.id) { this.tokens.delete(k); this.sockets.delete(k); }
    const token = randomBytes(32).toString('hex');
    const st: SeatToken = { token, seatIdx: seat.idx, playerId: seat.player.id, gameId: this.id };
    this.tokens.set(token, st);
    this.autoHands.delete(seat.player.id);
    log('runtime', `seat ${seat.idx} (${name}) reclaimed`);
    return st;
  }
  join(name: string, stack?: number, kind: 'human' | 'bot' = 'human', persona?: Persona, seatIdx?: number): SeatToken {
    if (kind === 'human') { const re = this.reclaim(name.slice(0, 20)); if (re) return re; }
    const player: Player = { id: randomBytes(8).toString('hex'), name: name.slice(0, 20) || 'Player', kind, persona };
    const seat = this.table.takeSeat(player, stack ?? this.table.config.defaultStack, seatIdx);
    this.buyIn.set(player.id, seat.stack); this.handsPlayed.set(player.id, 0);
    const token = randomBytes(32).toString('hex');
    const st: SeatToken = { token, seatIdx: seat.idx, playerId: player.id, gameId: this.id };
    this.tokens.set(token, st);
    this.maybeStartHand();
    return st;
  }
  addBot(persona: Persona, seatIdx?: number): SeatToken {
    const used = new Set(this.table.seats.map((s) => s.player?.name));
    const free = BOT_LIST.filter((n) => !used.has(n));
    const name = free.length ? free[randomBytes(2).readUInt16BE(0) % free.length] : `Bot${randomBytes(2).toString('hex')}`;
    return this.join(name, undefined, 'bot', persona, seatIdx);
  }
  resolve(token: string): SeatToken | undefined {
    const st = this.tokens.get(token);
    if (!st) return undefined;
    const seat = this.table.seats[st.seatIdx];
    if (seat.player?.id !== st.playerId) { this.tokens.delete(token); return undefined; }
    return st;
  }
  leave(token: string) {
    const st = this.resolve(token);
    if (!st) return;
    this.table.leaveSeat(st.seatIdx);
    this.tokens.delete(token);
    queueMicrotask(() => this.notify());
  }
  addChips(seatIdx: number, amount: number) {
    const seat = this.table.seats[seatIdx];
    this.table.addChips(seatIdx, amount);
    if (seat.player) this.buyIn.set(seat.player.id, (this.buyIn.get(seat.player.id) ?? 0) + Math.floor(amount));
    queueMicrotask(() => this.notify());
  }
  /** "Close table": everyone (humans and agents) leaves, game stops, leaderboard cleared. The table stays up for a fresh start. */
  reset() {
    this.pause();
    for (const s of this.table.seats) if (s.player) this.kick(s.idx);
    this.table.clearHand();
    this.table.state.handNo = 0; this.table.state.dealerSeat = null;
    this.reads.reset();
    this.leaderboard.clear(); this.buyIn.clear(); this.handsPlayed.clear(); this.wins.clear(); this.wonThisHand.clear();
    this.chat = [];
    this.say('系统', null, '牌桌已重置。', 'table');
  }
  kick(seatIdx: number) {
    const seat = this.table.seats[seatIdx];
    if (!seat.player) return;
    for (const [k, v] of this.tokens) if (v.seatIdx === seatIdx && v.playerId === seat.player.id) this.tokens.delete(k);
    this.table.leaveSeat(seatIdx);
    queueMicrotask(() => this.notify());
  }
  /** Host: reshuffle seats before the next hand (immediately if no hand is running). */
  pendingShuffle = false;
  requestShuffle(): { pending: boolean } {
    if (this.table.hand && !this.table.handDone) { this.pendingShuffle = true; this.say('系统', null, '下一手开始前重新分配座位。'); return { pending: true }; }
    this.applyShuffle();
    return { pending: false };
  }
  private applyShuffle() {
    this.pendingShuffle = false;
    const moves = this.table.shuffleSeats();
    const map = new Map(moves);
    for (const st of this.tokens.values()) { const to = map.get(st.seatIdx); if (to !== undefined) st.seatIdx = to; }
    this.say('系统', null, '座位已重新分配。');
    queueMicrotask(() => this.notify());
  }
  private randomEmptySeat(): number | undefined {
    const free = this.table.seats.filter((s) => !s.player).map((s) => s.idx);
    return free.length ? free[randomBytes(2).readUInt16BE(0) % free.length] : undefined;
  }

  /** Fill empty seats with bots up to config.autoFillTo players. */
  autoFill() {
    const cfg = this.table.config;
    let players = this.table.seats.filter((s) => s.player).length;
    let i = 0;
    while (players < cfg.autoFillTo && players < cfg.maxSeats) {
      const persona = cfg.botPersonas[i++ % cfg.botPersonas.length] ?? 'weak';
      this.addBot(persona, this.randomEmptySeat());
      players++;
    }
  }

  // ----- actions -----
  act(token: string, action: ActionType, amount?: number, decisionId?: string) {
    const st = this.resolve(token);
    if (!st) throw new EngineError('bad_token', 'unknown seat token');
    this.table.act(st.seatIdx, action, amount, decisionId);
  }
  actSeat(seatIdx: number, action: ActionType, amount?: number, decisionId?: string) {
    this.table.act(seatIdx, action, amount, decisionId);
  }
  sitOut(token: string, sittingOut: boolean) {
    const st = this.resolve(token);
    if (st) { this.table.setSittingOut(st.seatIdx, sittingOut); queueMicrotask(() => this.notify()); }
  }
  say(from: string, seat: number | null, text: string, channel: 'table' | 'commentary' = 'table') {
    const msg = { from, seat, text: text.slice(0, 500), ts: Date.now(), channel };
    this.chat.push(msg);
    if (this.chat.length > 500) this.chat.shift();
    appendJsonl(`game-${this.id}.jsonl`, { type: 'chat', ...msg });
    queueMicrotask(() => this.notify());
  }
  /** A busted player may rebuy the default stack between hands. */
  rebuy(token: string) {
    const st = this.resolve(token);
    if (!st) throw new EngineError('bad_token', 'unknown seat token');
    const seat = this.table.seats[st.seatIdx];
    if (seat.stack > 0 || (seat.inHand && !this.table.handDone)) throw new EngineError('not_busted', 'rebuy only when busted');
    this.table.addChips(st.seatIdx, this.table.config.defaultStack);
    this.buyIn.set(st.playerId, (this.buyIn.get(st.playerId) ?? 0) + this.table.config.defaultStack);
    queueMicrotask(() => this.notify());
    this.maybeStartHand();
  }
  private sockets = new Map<string, number>(); // token -> open sockets
  private autoHands = new Map<string, { count: number; lastHand: number }>(); // playerId -> hands auto-folded while disconnected
  setConnected(token: string, connected: boolean) {
    const st = this.resolve(token);
    if (!st) return;
    const n = Math.max(0, (this.sockets.get(token) ?? 0) + (connected ? 1 : -1));
    this.sockets.set(token, n);
    this.table.setConnected(st.seatIdx, n > 0);
    if (n > 0) this.autoHands.delete(st.playerId);
    queueMicrotask(() => this.notify());
    this.armDisconnectGrace();
  }
  /** Agents never block the table: 10 s hard cap regardless of the table timer, then check/fold. */
  private armBotDeadline() {
    const h = this.table.hand;
    if (!h || h.actionOn === null || this.table.handDone) return;
    const seat = this.table.seats[h.actionOn];
    if (!seat.player || seat.player.kind !== 'bot') return;
    const cap = Date.now() + BOT_DEADLINE_MS;
    if (h.deadline === null || h.deadline > cap) { h.deadline = cap; h.usingTimeBank = true; this.armTimer(); }
  }
  /** A disconnected human on action gets a grace period even when the table has no decision timer; then check/fold. */
  private graceTimer: NodeJS.Timeout | null = null;
  private armDisconnectGrace() {
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    const h = this.table.hand;
    if (!h || h.actionOn === null || this.table.handDone) return;
    const seat = this.table.seats[h.actionOn];
    if (!seat.player || seat.player.kind !== 'human' || seat.connected || h.deadline !== null) return;
    h.deadline = Date.now() + DISCONNECT_GRACE_MS;
    h.usingTimeBank = true; // no further time bank on top
    this.armTimer();
    queueMicrotask(() => this.notify());
  }

  // ----- host controls -----
  start() {
    if (this.closed) return;
    this.autoFill();
    this.table.setRunning(true);
    this.maybeStartHand();
  }
  pause() { this.table.setRunning(false); if (this.nextHandTimer) { clearTimeout(this.nextHandTimer); this.nextHandTimer = null; } }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.nextHandTimer) clearTimeout(this.nextHandTimer);
    this.table.close();
    queueMicrotask(() => this.notify());
    this.onClose?.();
  }

  private maybeStartHand() {
    if (!this.table.state.running || this.closed) return;
    if (this.table.hand && !this.table.handDone) return;
    if (this.nextHandTimer) return;
    this.scheduleNextHand(this.table.hand ? this.table.config.showdownMs : 300);
  }
  private scheduleNextHand(delay = this.table.config.showdownMs) {
    if (this.nextHandTimer) clearTimeout(this.nextHandTimer);
    this.nextHandTimer = setTimeout(() => {
      this.nextHandTimer = null;
      if (this.closed || !this.table.state.running) return;
      this.table.clearHand();
      if (this.pendingShuffle) { try { this.applyShuffle(); } catch (e) { log('runtime', 'shuffle failed', { e: String(e) }); } }
      if (this.table.canStartHand()) {
        try { this.table.startHand(); } catch (e) { log('runtime', 'startHand failed', { e: String(e) }); }
      } else {
        // not enough players: keep running but wait; retry when seats change
        this.table.setRunning(true);
        queueMicrotask(() => this.notify());
      }
    }, delay);
  }

  private armTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const h = this.table.hand;
    if (!h || h.deadline === null || this.closed) return;
    const wait = Math.max(0, h.deadline - Date.now()) + 5;
    this.timer = setTimeout(() => {
      this.timer = null;
      try { this.table.tick(Date.now()); } catch (e) { log('runtime', 'tick failed', { e: String(e) }); }
      this.armTimer();
      queueMicrotask(() => this.notify());
    }, wait);
  }

  /** Seats whose players need a hand to be dealt (used by lobby heartbeat). */
  summary() {
    const seats = this.table.seats.filter((s) => s.player);
    return {
      id: this.id, name: this.table.config.name, status: this.table.state.status, running: this.table.state.running,
      handNo: this.table.state.handNo, players: seats.length, humans: seats.filter((s) => s.player!.kind === 'human').length,
      bots: seats.filter((s) => s.player!.kind === 'bot').length, maxSeats: this.table.config.maxSeats,
      smallBlind: this.table.config.smallBlind, bigBlind: this.table.config.bigBlind, lastActivity: this.lastActivity,
    };
  }
}

export function parseTableConfig(input: any): Partial<TableConfig> {
  const num = (v: any, d: number, min: number, max: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : d; };
  const out: Partial<TableConfig> = {};
  if (input?.name) out.name = String(input.name).slice(0, 40);
  out.smallBlind = num(input?.smallBlind, 10, 1, 1_000_000);
  out.bigBlind = num(input?.bigBlind, out.smallBlind * 2, out.smallBlind, 2_000_000);
  out.ante = num(input?.ante, 0, 0, out.bigBlind);
  out.defaultStack = num(input?.defaultStack, out.bigBlind * 100, out.bigBlind, out.bigBlind * 100_000);
  out.decisionMs = input?.timerEnabled === false ? 0 : num(input?.decisionSec, 20, 5, 600) * 1000; // 0 = no decision timer
  out.timeBankMs = num(input?.timeBankSec, 30, 0, 300) * 1000;
  out.autoFillTo = num(input?.autoFillTo, 7, 2, 9);
  out.maxSeats = num(input?.maxSeats, 9, 2, 9);
  out.showdownMs = num(input?.showdownSec, 5, 1, 30) * 1000;
  out.hintsEnabled = input?.hintsEnabled === true;
  if (Array.isArray(input?.botPersonas) && input.botPersonas.length) {
    const ok = ['default', 'aggressive', 'weak', 'gto'];
    out.botPersonas = input.botPersonas.filter((p: any) => ok.includes(p));
  }
  void config;
  return out;
}
