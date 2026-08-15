/**
 * Pure presentation helpers shared by the Lab views — deck → sim-payload
 * conversion and number/verdict formatting. Kept DOM-free and side-effect-free so
 * they are unit-testable in Node (the heavy sim is already tested in
 * packages/sim; here we only test the glue: conversion + formatting).
 */
import type { Deck } from './deck.js';
import type { ProportionCI, SwapVerdict } from '@jonny-boi/sim';
import type { SimDeckPayload } from './sim-protocol.js';

/**
 * Convert a saved web `Deck` (cardId = Scryfall UUID) into the sim's `Deck`
 * payload. The sim resolves entries by id OR name and the curated pool's card
 * ids ARE these UUIDs, so the cardIds carry over verbatim. We also pass an
 * `archetype` (the sim's `Deck` requires one) derived from the deck name.
 */
export function toSimPayload(deck: Deck): SimDeckPayload {
  return {
    name: deck.name,
    archetype: deck.name,
    cards: deck.cards.map((entry) => ({ cardId: entry.cardId, count: entry.count })),
  };
}

/** Format a probability in [0,1] as a one-decimal percentage, e.g. "53.2%". */
export function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

/** Format a probability as a signed delta percentage, e.g. "+2.4%" / "-1.1%". */
export function signedPct(p: number): string {
  const sign = p >= 0 ? '+' : '';
  return `${sign}${pct(p)}`;
}

/** Render a Wilson CI as "53.2% (48.1–58.2%)". */
export function ciStr(ci: ProportionCI): string {
  return `${pct(ci.p)} (${pct(ci.low)}–${pct(ci.high)})`;
}

/** Format a p-value compactly: exponential when tiny, else 3 decimals. */
export function pValueStr(p: number): string {
  if (p === 0) return '0';
  return p < 0.001 ? p.toExponential(2) : p.toFixed(3);
}

/** A short human label + a CSS status class for a swap verdict. */
export interface VerdictDisplay {
  readonly label: string;
  /** One of the verdict status modifiers used in styles.css. */
  readonly tone: 'better' | 'worse' | 'inconclusive';
}

export function verdictDisplay(verdict: SwapVerdict): VerdictDisplay {
  switch (verdict) {
    case 'better':
      return { label: 'BETTER', tone: 'better' };
    case 'worse':
      return { label: 'WORSE', tone: 'worse' };
    default:
      return { label: 'INCONCLUSIVE', tone: 'inconclusive' };
  }
}

/** Games per second, guarding divide-by-zero (returns 0 when no time elapsed). */
export function gamesPerSecond(games: number, elapsedSeconds: number): number {
  return elapsedSeconds > 0 ? games / elapsedSeconds : 0;
}

/**
 * Below this rate, "games/sec" rounds to a flat `0` and the run looks broken even
 * though it is working — so a slow run is reported as seconds PER GAME instead.
 */
const SLOW_RUN_GAMES_PER_SECOND = 1;
/** Decimal places used when a throughput is small enough that rounding hides it. */
const THROUGHPUT_PRECISION = 1;

/**
 * Throughput as a readable phrase. A fast run reads "42 games/sec"; a slow one —
 * an MCTS pilot can take many seconds per game — reads "37.1s/game" rather than
 * the honest-but-useless "0 games/sec".
 */
export function throughputText(gamesPerSec: number): string {
  if (gamesPerSec <= 0) return '— games/sec';
  if (gamesPerSec >= SLOW_RUN_GAMES_PER_SECOND) return `${gamesPerSec.toFixed(0)} games/sec`;
  return `${(1 / gamesPerSec).toFixed(THROUGHPUT_PRECISION)}s/game`;
}

/** Above this many seconds, a remaining-time estimate reads better in minutes. */
const SECONDS_PER_MINUTE = 60;

/**
 * A remaining-time estimate for a run, extrapolated from what it has done so far,
 * or `null` while there is nothing to extrapolate from.
 *
 * A strong AI pilot can spend seconds on a single game, so a 600-game gauntlet is
 * a coffee break, not a moment — and a progress bar that creeps without ever
 * saying how long is the thing that makes a working run look broken.
 */
export function etaText(done: number, total: number, elapsedSeconds: number): string | null {
  if (done <= 0 || total <= 0 || elapsedSeconds <= 0 || done >= total) return null;
  const remaining = ((total - done) * elapsedSeconds) / done;
  if (remaining < SECONDS_PER_MINUTE) return `~${Math.max(1, Math.round(remaining))}s left`;
  return `~${Math.round(remaining / SECONDS_PER_MINUTE)} min left`;
}
