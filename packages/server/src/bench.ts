// 1b acceptance: N hands with the four built-in personas at one table (no tunnel, no network except the LLM proxy).
import { GameRuntime, parseTableConfig } from './runtime.js';
import { BotRunner, stats } from './bots/runner.js';
import type { Persona } from '@pokergarden/engine';

const HANDS = Number(process.argv[2] ?? 200);
const personas: Persona[] = (process.argv[3] ?? 'default,aggressive,weak,weak,gto,weak,default').split(',') as Persona[];
const rt = new GameRuntime(parseTableConfig({ smallBlind: 10, bigBlind: 20, decisionSec: 30, timeBankSec: 0, showdownSec: 0.1, autoFillTo: personas.length }), 'bench');
rt.table.config.showdownMs = 50;
const runner = new BotRunner(rt); runner.start();
const seats = personas.map((p) => rt.addBot(p));
const start: Record<string, number> = {};
for (const s of seats) start[s.seatIdx] = rt.table.seats[s.seatIdx].stack;
const t0 = Date.now();
rt.start();
let lastHand = 0; let timeouts = 0;
rt.table.onEvent((ev) => { if (ev.type === 'action' && ev.timeout) timeouts++; });
await new Promise<void>((resolve) => {
  const iv = setInterval(() => {
    const no = rt.table.state.handNo;
    if (no !== lastHand) { lastHand = no; if (no % 10 === 0) console.error(`hand ${no} decisions=${stats.decisions} fallbacks=${stats.fallbacks}`); }
    // rebuy busted bots so the table keeps 7 players
    for (const s of rt.table.seats) if (s.player && s.stack === 0 && !s.inHand) { rt.table.addChips(s.idx, 2000); start[s.idx] += 2000; }
    if (no >= HANDS && rt.table.handDone) { clearInterval(iv); rt.pause(); resolve(); }
  }, 100);
});
const lat = [...stats.latencies].sort((a, b) => a - b);
const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))];
const byPersona: Record<string, number> = {};
for (const s of seats) { const seat = rt.table.seats[s.seatIdx]; byPersona[`${seat.player!.name}`] = seat.stack - start[s.seatIdx]; }
console.log(JSON.stringify({ hands: rt.table.state.handNo, ms: Date.now() - t0, decisions: stats.decisions, fallbacks: stats.fallbacks, timeouts, p50: p(0.5), p95: p(0.95), max: lat[lat.length - 1], net: byPersona }, null, 1));
rt.close();
process.exit(0);
