import { type Card, rankValue, suitOf } from './cards.js';

export const CATEGORY_NAMES = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
] as const;

export interface HandRank {
  score: number;       // higher is better; comparable across hands
  category: number;    // 0..8
  name: string;
  cards: Card[];       // best five
}

function score5(cards: Card[]): { score: number; category: number } {
  const ranks = cards.map(rankValue).sort((a, b) => b - a);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // groups sorted by count desc, then rank desc
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  let straightHigh = 0;
  if (groups.length === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    else if (ranks[0] === 14 && ranks[1] === 5 && ranks[4] === 2) straightHigh = 5; // wheel
  }
  let category: number;
  let kickers: number[];
  if (straightHigh && flush) { category = 8; kickers = [straightHigh]; }
  else if (groups[0][1] === 4) { category = 7; kickers = [groups[0][0], groups[1][0]]; }
  else if (groups[0][1] === 3 && groups[1][1] === 2) { category = 6; kickers = [groups[0][0], groups[1][0]]; }
  else if (flush) { category = 5; kickers = ranks; }
  else if (straightHigh) { category = 4; kickers = [straightHigh]; }
  else if (groups[0][1] === 3) { category = 3; kickers = groups.map((g) => g[0]); }
  else if (groups[0][1] === 2 && groups[1][1] === 2) { category = 2; kickers = groups.map((g) => g[0]); }
  else if (groups[0][1] === 2) { category = 1; kickers = groups.map((g) => g[0]); }
  else { category = 0; kickers = ranks; }
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 15 + (kickers[i] ?? 0);
  return { score, category };
}

/** Best 5-card hand out of 5..7 cards. */
export function evaluate(cards: Card[]): HandRank {
  if (cards.length < 5) throw new Error('need at least 5 cards');
  let best: { score: number; category: number; cards: Card[] } | null = null;
  const n = cards.length;
  const idx = [0, 1, 2, 3, 4];
  const combos: number[][] = [];
  if (n === 5) combos.push(idx);
  else {
    // enumerate 5-combinations of n
    const rec = (start: number, chosen: number[]) => {
      if (chosen.length === 5) { combos.push([...chosen]); return; }
      for (let i = start; i < n; i++) { chosen.push(i); rec(i + 1, chosen); chosen.pop(); }
    };
    rec(0, []);
  }
  for (const c of combos) {
    const five = c.map((i) => cards[i]);
    const s = score5(five);
    if (!best || s.score > best.score) best = { ...s, cards: five };
  }
  return { score: best!.score, category: best!.category, name: CATEGORY_NAMES[best!.category], cards: best!.cards };
}
