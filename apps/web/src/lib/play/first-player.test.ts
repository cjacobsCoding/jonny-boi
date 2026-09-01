/**
 * §3.63 — "Random" for who goes first.
 *
 * The reported gap was that the setup screen had no way to flip for the first
 * turn. The risk in adding one is not the flip itself but WHERE it happens: a
 * preference that stayed unresolved would reach the saved game, and every
 * resume would re-flip into a different game. These pin both halves — the flip
 * is fair, and an explicit seat is never touched by it.
 */
import { describe, expect, it } from 'vitest';
import { defaultCoinFlip, RANDOM_STARTER, resolveStartingPlayer } from './first-player.js';

describe('resolveStartingPlayer', () => {
  it('passes an explicit seat straight through, never consulting the flip', () => {
    const exploded = (): number => {
      throw new Error('the coin must not be flipped when a seat was chosen');
    };
    expect(resolveStartingPlayer('A', exploded)).toBe('A');
    expect(resolveStartingPlayer('B', exploded)).toBe('B');
  });

  it('splits the interval evenly — neither seat is favoured', () => {
    expect(resolveStartingPlayer(RANDOM_STARTER, () => 0)).toBe('A');
    expect(resolveStartingPlayer(RANDOM_STARTER, () => 0.4999)).toBe('A');
    expect(resolveStartingPlayer(RANDOM_STARTER, () => 0.5)).toBe('B');
    expect(resolveStartingPlayer(RANDOM_STARTER, () => 0.9999)).toBe('B');
  });

  it('resolves to a CONCRETE seat, so nothing downstream can re-flip', () => {
    // The whole determinism argument in one assertion: whatever comes out of
    // here is a PlayerId, never the word "random", so the saved record and the
    // replay cannot disagree about who started.
    for (const value of [0, 0.25, 0.5, 0.75]) {
      expect(['A', 'B']).toContain(resolveStartingPlayer(RANDOM_STARTER, () => value));
    }
  });

  it('the default flip stays in range and reaches both seats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const value = defaultCoinFlip();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      seen.add(resolveStartingPlayer(RANDOM_STARTER, () => value));
    }
    // 200 flips landing on one seat every time is ~1 in 10^60: a stuck coin.
    expect([...seen].sort()).toEqual(['A', 'B']);
  });
});
