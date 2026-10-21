import type { View } from '@pokergarden/engine';
import { chat, extractJson, safeNote } from './llm.js';
import { describeView, sanitize, type Decision, type PersonaAgent } from './types.js';

const FISH_SYSTEM = `You are a recreational No-Limit Hold'em player at a 9-max cash table: loose and a bit passive. You enjoy seeing flops, so you play more hands than a solid player and like to call rather than raise. You will call small and medium bets with a pair or a decent draw, but you fold weak hands to big bets and you do not go broke without a strong hand. When you bet, use normal sizes (about half to full pot).
Respond with ONLY a JSON object: {"action": "fold|check|call|bet|raise", "amount": <only for bet/raise: the TOTAL you want your bet this street to be, in chips>, "note": "<optional table talk, 简体中文, at most 15 characters, never hint at your cards>"}. Pick only from the legal actions given. No markdown.`;

// tilt context: remember each fish's stack at the start of its previous hand
const memory = new Map<string, { handNo: number; startStack: number; lastDelta: number }>();
function tiltLine(v: View): string {
  const me = v.seats[v.you!]; const key = `${v.table.id}:${v.you}`; const no = v.hand!.no;
  const now = me.stack + me.handBet;
  const m = memory.get(key);
  if (!m) { memory.set(key, { handNo: no, startStack: now, lastDelta: 0 }); return ''; }
  if (m.handNo !== no) { m.lastDelta = now - m.startStack; m.handNo = no; m.startStack = now; }
  if (m.lastDelta <= -v.table.bigBlind * 15) return `\n上一手你输了 ${-m.lastDelta} 筹码，心里很不服气。`;
  if (m.lastDelta >= v.table.bigBlind * 15) return `\n上一手你赢了 ${m.lastDelta} 筹码，觉得今天手气很旺。`;
  return '';
}

export const fishAgent: PersonaAgent = {
  name: 'weak',
  async decide(v: View, signal: AbortSignal): Promise<Decision> {
    const legal = v.legalActions;
    const prev = tiltLine(v);
    const { text, ms, model } = await chat([
      { role: 'system', content: FISH_SYSTEM },
      { role: 'user', content: describeView(v) + prev + '\nWhat is your action?' },
    ], signal);
    let d = sanitize(extractJson(text), legal);
    if (!d) throw new Error('fish: unparseable');
    d.note = safeNote(d.note); d.ms = ms; d.source = `fish:${model}`;
    return d;
  },
};

