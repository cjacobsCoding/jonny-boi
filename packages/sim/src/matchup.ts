/**
 * `runMatchup` — play n games of deck A vs deck B and aggregate A's win-rate with
 * a Wilson confidence interval (DESIGN §3.5).
 *
 * Fairness: we alternate who is "on the play" each game (the play is a real edge
 * in MTG), so a deck isn't flattered by always going first. Determinism: every
 * game's seed is a pure function of `baseSeed` and the game index, so the same
 * `baseSeed` always reproduces the same aggregate — the bedrock the paired A/B
 * test stands on.
 *
 * Per-game seeds are exposed (`gameSeeds`) so the A/B swap test can replay the
 * variant deck on the *identical* seeds (common random numbers).
 */

import type { PlayerId, RulesConfig } from '@jonny-boi/core';
import type { Pilot } from '@jonny-boi/ai';
import type { EffectRegistry } from '@jonny-boi/core';
import type { LoadedDeck } from './deck.js';
import { runMatch, type MatchResult, type MatchSeats } from './match.js';
import { DEFAULT_SIM_CONFIG, type SimConfig } from './config.js';
import { DEFAULT_STATS_CONFIG, type DeckRules, type StatsConfig } from './config.js';
import { wilsonInterval, type ProportionCI } from './stats.js';

/** The pilots driving each deck (selected by id upstream, resolved to instances). */
export interface MatchupPilots {
  readonly pilotA: Pilot;
  readonly pilotB: Pilot;
}

/** Options shared by matchup/gauntlet/swap runs. */
export interface RunOptions {
  readonly config?: RulesConfig;
  readonly sim?: SimConfig;
  readonly stats?: StatsConfig;
  /**
   * Deck-legality rules for runs that LOAD a deck themselves (`evaluateSwap`
   * builds and loads the variant). Callers that vet legality with custom rules
   * must hand the same rules down, or the variant is re-checked against the
   * defaults and a deck their rules called legal is rejected. Matchup/gauntlet
   * runs take already-loaded decks and ignore this.
   */
  readonly deckRules?: DeckRules;
}

/** The aggregate of an n-game matchup from deck A's perspective. */
export interface MatchupResult {
  readonly deckA: string;
  readonly deckB: string;
  readonly games: number;
  /** Games A won. */
  readonly winsA: number;
  /** Games B won. */
  readonly winsB: number;
  /** Games that ended in a timeout draw (counted toward neither win column). */
  readonly draws: number;
  /** A's win-rate point estimate + Wilson CI (draws count as non-wins for A). */
  readonly winRateA: ProportionCI;
  /** The per-game seeds used, in order — for paired replay (the swap test). */
  readonly gameSeeds: readonly number[];
}

/**
 * Derive a deterministic per-game seed from the base seed and the game index.
 * A cheap integer hash (xorshift-ish mix) spreads consecutive indices into very
 * different seeds, so adjacent games aren't correlated, while staying a pure
 * function of `(baseSeed, index)`.
 */
export function gameSeedFor(baseSeed: number, index: number): number {
  let h = (baseSeed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Who is on the play in game `index`: alternate A, B, A, B, … for fairness. */
export function onPlayFor(index: number): PlayerId {
  return index % 2 === 0 ? 'A' : 'B';
}

/** Build the seat bundle once and reuse it across all games in a matchup. */
export function makeSeats(
  deckA: LoadedDeck,
  deckB: LoadedDeck,
  pilots: MatchupPilots,
  registry: EffectRegistry,
): MatchSeats {
  return {
    deckA,
    deckB,
    pilotA: pilots.pilotA,
    pilotB: pilots.pilotB,
    registry,
  };
}

/**
 * Play n games and aggregate. The per-game `MatchResult`s are reduced on the fly
 * (no array of full results retained) to stay allocation-light over thousands of
 * games. Pass `onGame` to observe each result (e.g. for reporters) without the
 * harness holding them all.
 */
export function runMatchup(
  seats: MatchSeats,
  n: number,
  baseSeed: number,
  opts: RunOptions & { readonly onGame?: (r: MatchResult, index: number) => void } = {},
): MatchupResult {
  const stats = opts.stats ?? DEFAULT_STATS_CONFIG;
  const sim = opts.sim ?? DEFAULT_SIM_CONFIG;

  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  const gameSeeds: number[] = [];

  for (let i = 0; i < n; i++) {
    const seed = gameSeedFor(baseSeed, i);
    gameSeeds.push(seed);
    const result = runMatch(seats, seed, {
      config: opts.config,
      sim,
      startingPlayer: onPlayFor(i),
    });
    if (result.outcome.kind === 'win') {
      if (result.outcome.winner === 'A') winsA++;
      else winsB++;
    } else {
      draws++;
    }
    opts.onGame?.(result, i);
  }

  return {
    deckA: seats.deckA.name,
    deckB: seats.deckB.name,
    games: n,
    winsA,
    winsB,
    draws,
    winRateA: wilsonInterval(winsA, n, stats.z),
    gameSeeds,
  };
}
