import { describe, expect, it } from 'vitest';
import { createRng, shuffle } from './rng.js';

describe('seeded RNG', () => {
  it('is deterministic: same seed → same stream', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('different seeds produce different streams', () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('next() stays within [0, 1)', () => {
    const r = createRng(99);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('nextInt() stays within range', () => {
    const r = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.nextInt(6);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('shuffle is deterministic for a given seed and does not mutate input', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const out1 = shuffle(input, createRng(42));
    const out2 = shuffle(input, createRng(42));
    expect(out1).toEqual(out2);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // unmutated
    expect([...out1].sort((a, b) => a - b)).toEqual(input); // permutation
  });

  it('shuffle with different seeds usually differs', () => {
    const input = Array.from({ length: 30 }, (_, i) => i);
    const out1 = shuffle(input, createRng(1));
    const out2 = shuffle(input, createRng(2));
    expect(out1).not.toEqual(out2);
  });
});
