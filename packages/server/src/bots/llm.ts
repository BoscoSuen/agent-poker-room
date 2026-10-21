import type { View } from '@pokergarden/engine';
import { config } from '../config.js';
import { log } from '../log.js';
import { describeView, sanitize, type Decision, type PersonaAgent } from './types.js';

export interface ChatMessage { role: 'system' | 'user'; content: string }

const cooldown = new Map<string, number>(); // model -> until (ms)

export async function chat(messages: ChatMessage[], signal: AbortSignal, opts: { maxTokens?: number } = {}): Promise<{ text: string; ms: number; model: string }> {
  const t0 = Date.now();
  let lastErr: Error | null = null;
  for (const model of config.llm.models) {
    if ((cooldown.get(model) ?? 0) > Date.now()) continue;
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({ model, messages, reasoning_effort: config.llm.reasoningEffort, max_tokens: opts.maxTokens ?? 300, temperature: 0.7 }),
      signal,
    });
    if (res.status === 429 || res.status >= 500) {
      const body = (await res.text()).slice(0, 200);
      lastErr = new Error(`llm ${model} http ${res.status}: ${body}`);
      cooldown.set(model, Date.now() + (res.status === 429 ? 60_000 : 10_000));
      log('llm', `model ${model} unavailable (${res.status}), trying next`, { body });
      continue;
    }
    if (!res.ok) throw new Error(`llm http ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j: any = await res.json();
    const text: string = j.choices?.[0]?.message?.content ?? '';
    return { text, ms: Date.now() - t0, model };
  }
  throw lastErr ?? new Error('no llm model available');
}

/** Public table talk must not leak private information. Drop notes that look like they mention cards or hand strength. */
const LEAK = /[♠♥♦♣]|\b[AKQJT2-9][AKQJT2-9]?[shdc]?\b(?=.*\b(suited|offsuit|off|pair|kicker)\b)|\b(ace|king|queen|jack|ten|nine|eight|seven|six|five|four|three|deuce|two)s?[- ](ace|king|queen|jack|ten|nine|eight|seven|six|five|four|three|deuce|two|high|rag|x)\b|\b(pair|two pair|trips|set|straight|flush|full house|quads|boat|draw|gutshot|blockers?|overcards?|top pair|nut|nuts|air|bluff(ing)?|missed|whiff)\b|\b[AKQJT2-9]{2}[so]\b|\b(AA|KK|QQ|JJ|TT|AK|AQ|AJ|KQ)\b/i;
const LEAK_ZH = /[AKQJT2-9][♠♥♦♣shdc]|(?:^|[^\u4e00-\u9fa5])(?:[AKQJT]|10|[2-9]){2}(?:[^\u4e00-\u9fa5]|$)|对子|两对|三条|顺子|同花|葫芦|四条|听牌|口袋|一对|顶对|中对|底对|踢脚|诈唬|偷鸡|空气|牌力|牌很|手牌|我的牌|起手|拿着|拿了|AA|KK|QQ|JJ|AK|AQ|大牌|小牌|烂牌|好牌|垃圾牌|同花听|顺子听|阻断/i;
export function safeNote(note: unknown): string | undefined {
  if (typeof note !== 'string') return undefined;
  const n = note.trim().slice(0, 60);
  if (!n || LEAK.test(n) || LEAK_ZH.test(n)) return undefined;
  return n;
}

export function extractJson(text: string): any | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { /* try trimming trailing junk */ }
  const m2 = text.match(/\{[^{}]*\}/);
  if (m2) { try { return JSON.parse(m2[0]); } catch { return null; } }
  return null;
}

const OUTPUT_RULES = `Respond with ONLY a JSON object: {"action": "fold|check|call|bet|raise", "amount": <number, only for bet/raise: the TOTAL you want your bet this street to be ("raise to"), in chips>, "note": "<optional table talk, 简体中文, at most 15 characters, shown to opponents>"}. Pick only from the legal actions given. The note is PUBLIC and must be written in Chinese: never mention or hint at your hole cards, hand strength, draws, or reasoning in it; keep it to banter in your persona's voice (solid player: calm and brief; aggressive player: cocky, taunting). No markdown.`;

const PERSONAS: Record<string, string> = {
  default: `You are a solid, balanced No-Limit Hold'em player at a 9-max cash table (tight-aggressive). Play a sound fundamental strategy: open strong hands, respect position, value bet made hands, bluff selectively with blockers or draws, fold junk to big bets. Size bets relative to the pot (typically 50-75% pot postflop, 2.5-3x open preflop, 3x the raise for a 3-bet). With a hand that only beats bluffs, call a bet if you find out this player bluffs.`,
  aggressive: `You are a loose-aggressive (LAG) No-Limit Hold'em player at a 9-max cash table. You open a wide range, 3-bet often, c-bet almost always, barrel turns, and apply maximum pressure, especially on short stacks and when checked to. You still fold truly hopeless hands facing big action, but prefer raising to calling and use larger sizes (70-100% pot, overbets on scary rivers).`,
  gto: `You are a GTO-oriented No-Limit Hold'em player. Follow the strategy guidance given in the user message exactly when present; otherwise play a balanced, theoretically sound strategy.`,
};

export function makeLlmAgent(persona: 'default' | 'aggressive'): PersonaAgent {
  const bluffRate = persona === 'aggressive' ? 0.2 : 0;
  return {
    name: persona,
    async decide(v: View, signal: AbortSignal, ctx?: { reads?: string }): Promise<Decision> {
      const legal = v.legalActions;
      const messages: ChatMessage[] = [
        { role: 'system', content: `${PERSONAS[persona]}\n${OUTPUT_RULES}` },
        { role: 'user', content: describeView(v) + (persona === 'default' && ctx?.reads ? '\n' + ctx.reads : '') + '\nWhat is your action?' },
      ];
      const { text, ms, model } = await chat(messages, signal);
      const parsed = extractJson(text);
      let d = sanitize(parsed, legal);
      if (!d) { log('llm', 'unparseable', { persona, text: text.slice(0, 200) }); throw new Error('unparseable llm output'); }
      // aggressive: random bluff raise on top of the model's decision
      if (bluffRate && Math.random() < bluffRate && (d.action === 'check' || d.action === 'call')) {
        const r = legal.find((l) => l.action === 'raise' || l.action === 'bet');
        if (r) d = { action: r.action, amount: Math.min(r.max!, Math.max(r.min!, Math.round((v.hand!.pot + (legal.find((l) => l.action === 'call')?.amount ?? 0)) * 0.75 + v.hand!.currentBet))), note: d.note, source: 'bluff' };
      }
      d.ms = ms; d.source ??= `llm:${model}`; d.note = safeNote(d.note);
      return d;
    },
  };
}
