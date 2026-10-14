import { randomInt, createHash, randomBytes } from 'node:crypto';

export type Card = string; // e.g. "As", "Td", "2c"

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';

export function newDeck(): Card[] {
  const d: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  return d;
}

export type Rng = (maxExclusive: number) => number;
export const cryptoRng: Rng = (n) => randomInt(n);

/** Unbiased Fisher-Yates shuffle (in place) using the given rng. */
export function shuffle<T>(arr: T[], rng: Rng = cryptoRng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function rankValue(c: Card): number {
  return RANKS.indexOf(c[0]) + 2;
}
export function suitOf(c: Card): string {
  return c[1];
}

/** Deck commitment: sha256(deck joined by space + '|' + nonce). Published before dealing, nonce revealed after the hand. */
export function commitDeck(deck: Card[], nonce: string): string {
  return createHash('sha256').update(deck.join(' ') + '|' + nonce).digest('hex');
}
export function newNonce(): string {
  return randomBytes(16).toString('hex');
}
