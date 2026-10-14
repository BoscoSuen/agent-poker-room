import { describe, it, expect } from 'vitest';
import { evaluate } from '../src/evaluator.js';

const e = (s: string) => evaluate(s.split(' '));

describe('evaluator', () => {
  it('ranks categories in order', () => {
    const hands = [
      'As Ks Qs Js Ts 2c 3d', // straight flush
      'Ah Ad Ac As 2c 3d 4h', // quads
      'Ah Ad Ac Ks Kc 3d 4h', // full house
      'Ah 9h 7h 4h 2h Kc 3d', // flush
      'Ah Kd Qc Js Td 2c 3d', // straight
      'Ah Ad Ac 9s 7c 3d 4h', // trips
      'Ah Ad Kc Ks 7c 3d 4h', // two pair
      'Ah Ad Kc Qs 7c 3d 4h', // pair
      'Ah Kd Qc Js 9c 3d 4h', // high card
    ];
    const scores = hands.map((h) => e(h).score);
    for (let i = 0; i < scores.length - 1; i++) expect(scores[i]).toBeGreaterThan(scores[i + 1]);
    expect(e(hands[0]).name).toBe('Straight Flush');
    expect(e(hands[8]).name).toBe('High Card');
  });
  it('handles the wheel and compares straights by top card', () => {
    const wheel = e('Ah 2d 3c 4s 5d Kc Qd');
    expect(wheel.name).toBe('Straight');
    expect(e('2h 3d 4c 5s 6d Kc Qd').score).toBeGreaterThan(wheel.score);
    expect(e('Ah Kd Qc Js Td 2c 3d').score).toBeGreaterThan(e('Kh Qd Jc Ts 9d 2c 3d').score);
  });
  it('uses kickers', () => {
    expect(e('Ah Ad Kc 9s 7c 3d 2h').score).toBeGreaterThan(e('As Ac Qc 9d 7h 3s 2d').score);
    expect(e('Ah Ad Kc 9s 7c 3d 2h').score).toBe(e('As Ac Kd 9d 7h 3s 2d').score); // tie
  });
  it('two pair uses the top two pairs', () => {
    const r = e('Ah Ad Kc Ks 7c 7d 2h');
    expect(r.name).toBe('Two Pair');
    expect(r.cards.filter((c) => c[0] === '7').length).toBe(1);
  });
  it('full house picks best trips', () => {
    const r = e('Ah Ad Ac Kc Ks Kd 2h');
    expect(r.name).toBe('Full House');
    expect(r.cards.filter((c) => c[0] === 'A').length).toBe(3);
  });
});
