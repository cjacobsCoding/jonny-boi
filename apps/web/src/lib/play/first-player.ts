/**
 * WHO GOES FIRST — the choice, and the coin flip behind "Random".
 *
 * Reported: the setup screen let you pick a seat but never let you flip for it,
 * which is how the first turn is actually decided at a table. This module is the
 * whole feature: a preference the player sets, and one pure resolution step.
 *
 * ## Why the flip resolves HERE and not deeper in
 * The engine is deterministic — seed + decklists + actions replay a game exactly,
 * which is what §3.58's saved games and the whole Lab depend on. A "random"
 * starting player that stayed unresolved inside the game would break that: the
 * saved record would say "random" and every resume would re-flip into a
 * DIFFERENT game wearing the same clothes. So the flip happens once, at setup,
 * and everything downstream — the created game, the saved record, the replay —
 * only ever sees a concrete seat.
 *
 * ## Why it is not derived from the game seed
 * That would be the natural trick in a codebase this deterministic, and it is
 * wrong here for a boring reason: the seed field defaults to a FIXED value
 * (`HOTSEAT_CONFIG.defaultSeed`), so a seed-derived flip would hand the first
 * turn to the same seat every single game until the player thought to change a
 * number they have no reason to touch. A coin that always lands heads is not a
 * coin. The entropy is real, and its RESULT is what gets recorded.
 */
import type { PlayerId } from '@jonny-boi/core';

/** What the player picked on the setup screen. */
export type StarterPreference = PlayerId | 'random';

/** The value the "Who goes first" control uses for the flip option. */
export const RANDOM_STARTER: StarterPreference = 'random';

/**
 * A source of randomness for the flip, injected so the rule is testable: it
 * returns a number in [0, 1), exactly like `Math.random`.
 */
export type CoinFlip = () => number;

/**
 * The default flip. Prefers the platform CSPRNG and falls back to `Math.random`
 * — not for cryptographic strength (this is a coin toss for a card game), but
 * because `crypto` is absent in some embedded webviews and a missing global
 * must not be able to break starting a game.
 */
export const defaultCoinFlip: CoinFlip = () => {
  try {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    // 2^32 as the divisor keeps the result in [0, 1) for every possible draw.
    return (values[0] as number) / 4_294_967_296;
  } catch {
    return Math.random();
  }
};

/**
 * Resolve a preference to the seat that actually takes the first turn.
 *
 * An explicit seat passes straight through — the flip is never consulted, so
 * picking a seat cannot surprise you. 'random' splits the interval in half:
 * below 0.5 is A, at or above is B.
 */
export function resolveStartingPlayer(
  preference: StarterPreference,
  flip: CoinFlip = defaultCoinFlip,
): PlayerId {
  if (preference !== 'random') return preference;
  return flip() < 0.5 ? 'A' : 'B';
}
