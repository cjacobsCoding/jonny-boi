/**
 * Seeded, deterministic RNG. All randomness in the engine (shuffles, coin flips)
 * flows through this so the same seed reproduces the same game — a hard
 * requirement for the sim harness and replay. No `Math.random`, no `Date.now`.
 *
 * Implementation: mulberry32, a tiny, fast, well-distributed 32-bit PRNG. The
 * RNG carries its own mutable cursor; it is the one intentionally-stateful object
 * the engine threads through state. We expose it behind an interface so callers
 * never depend on the algorithm.
 */

/** A deterministic random source. Advancing it mutates its internal cursor. */
export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  /** The current cursor — snapshot it to resume an identical stream later. */
  readonly state: number;
}

/** Create a seeded RNG. The same `seed` always yields the same stream. */
export function createRng(seed: number): Rng {
  // Normalise the seed into a 32-bit unsigned integer.
  let cursor = seed >>> 0;
  const rng: Rng = {
    next(): number {
      cursor = (cursor + 0x6d2b79f5) | 0;
      let t = cursor;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    nextInt(maxExclusive: number): number {
      if (maxExclusive <= 0) return 0;
      return Math.floor(rng.next() * maxExclusive);
    },
    get state(): number {
      return cursor >>> 0;
    },
  };
  return rng;
}

/**
 * Fisher–Yates shuffle using the injected RNG. Returns a new array; does not
 * mutate the input. Deterministic for a given RNG cursor.
 */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}
