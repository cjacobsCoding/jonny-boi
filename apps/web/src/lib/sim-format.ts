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
