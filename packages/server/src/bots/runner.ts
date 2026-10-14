import type { Persona, View } from '@pokergarden/engine';
import { config } from '../config.js';
import { log, appendJsonl } from '../log.js';
import type { GameRuntime } from '../runtime.js';
import { weakAgent } from './weak.js';
import { makeLlmAgent } from './llm.js';
import { gtoAgent } from './gto.js';
import type { PersonaAgent, Decision } from './types.js';
import { TALK } from './names.js';

export const AGENTS: Record<Persona, PersonaAgent> = {
  weak: weakAgent,
  default: makeLlmAgent('default'),
  aggressive: makeLlmAgent('aggressive'),
  gto: gtoAgent,
};

export const stats = { decisions: 0, fallbacks: 0, latencies: [] as number[] };

/**
 * Drives in-process bots through the loopback seat gateway: bots receive only `runtime.view(seat)`
 * (the same redacted view a remote agent would get) and answer with one structured action.
 */
export class BotRunner {
  private inflight = new Map<number, string>(); // seatIdx -> decisionId
  private unsub: (() => void) | null = null;
  constructor(private rt: GameRuntime) {}

  start() {
    this.unsub = this.rt.onChange(() => this.poll());
    this.poll();
  }
  stop() { this.unsub?.(); }

  private poll() {
    const t = this.rt.table;
    const h = t.hand;
    if (!h || h.actionOn === null || t.handDone) return;
    const seat = t.seats[h.actionOn];
    if (!seat.player || seat.player.kind !== 'bot') return;
    if (this.inflight.get(seat.idx) === h.decisionId) return;
    this.inflight.set(seat.idx, h.decisionId);
    void this.decide(seat.idx, h.decisionId, seat.player.persona ?? 'weak');
  }

  private async decide(seatIdx: number, decisionId: string, persona: Persona) {
    const view: View = this.rt.view(seatIdx);
    if (view.hand?.decisionId !== decisionId) return;
    const agent = AGENTS[persona] ?? weakAgent;
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.llm.timeoutMs);
    let d: Decision | null = null;
    let fallback = false;
    try {
      d = await agent.decide(view, ctrl.signal);
    } catch (e) {
      log('bot', `${persona} seat ${seatIdx} failed, falling back to weak rules`, { e: String(e).slice(0, 200) });
      fallback = true;
    } finally { clearTimeout(timer); }
    if (!d) { d = await weakAgent.decide(view, ctrl.signal); d.source = 'fallback:weak'; }
    const elapsed = Date.now() - t0;
    // pace every agent: act no sooner than BOT_THINK_MS after its turn began (LLM latency counts toward it)
    const minThink = config.botThinkMs;
    if (elapsed < minThink) await new Promise((r) => setTimeout(r, minThink - elapsed));
    stats.decisions++; if (fallback) stats.fallbacks++; stats.latencies.push(Date.now() - t0);
    appendJsonl(`bots-${this.rt.id}.jsonl`, { ts: Date.now(), seat: seatIdx, persona, decisionId, hand: view.hand?.no, street: view.hand?.street, decision: d, ms: Date.now() - t0, fallback });
    try {
      this.rt.actSeat(seatIdx, d.action, d.amount, decisionId);
      const name = view.seats[seatIdx].name ?? 'bot';
      if (d.note) this.rt.say(name, seatIdx, d.note);
      else if (d.action !== 'fold' && Math.random() < (persona === 'weak' ? 0.2 : 0.15)) { const lines = TALK[persona] ?? TALK.weak; this.rt.say(name, seatIdx, lines[Math.floor(Math.random() * lines.length)]); }
    } catch (e) {
      // stale (timeout already acted) or illegal: try a safe action if still our turn
      const h = this.rt.table.hand;
      if (h && h.actionOn === seatIdx && h.decisionId === decisionId) {
        const legal = this.rt.table.legalActions(seatIdx);
        const safe = legal.some((l) => l.action === 'check') ? 'check' : legal.some((l) => l.action === 'call') ? 'call' : 'fold';
        log('bot', `illegal decision ${JSON.stringify(d)} -> ${safe}`, { e: String(e).slice(0, 120) });
        try { this.rt.actSeat(seatIdx, safe as any, undefined, decisionId); } catch { /* ignore */ }
      }
    }
  }
}
