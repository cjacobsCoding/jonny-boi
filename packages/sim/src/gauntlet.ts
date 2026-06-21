/**
 * `runGauntlet` — play one deck against every deck in a gauntlet and report a
 * per-matchup win-rate+CI plus an overall win-rate+CI (DESIGN §3.5).
 *
 * The "hero" deck always sits in seat A so win-rates read from its perspective.
 * Each matchup uses a seed derived from the base seed and the opponent index, so
 * the whole gauntlet is reproducible from one `baseSeed`.
 */

import type { EffectRegistry } from '@jonny-boi/core';
import type { LoadedDeck } from './deck.js';
import {
  makeSeats,
  runMatchup,
  type MatchupPilots,
  type MatchupResult,
  type RunOptions,
} from './matchup.js';
import { gameSeedFor } from './matchup.js';
import { DEFAULT_STATS_CONFIG } from './config.js';
import { wilsonInterval, type ProportionCI } from './stats.js';

/** A deck's record across the whole gauntlet. */
export interface GauntletResult {
  readonly hero: string;
  /** One entry per gauntlet opponent, in order. */
  readonly matchups: readonly MatchupResult[];
  /** Total games played across all matchups. */
  readonly totalGames: number;
  /** Total games the hero won. */
  readonly totalWins: number;
  /** Total timeout draws. */
  readonly totalDraws: number;
  /** Hero's overall win-rate + Wilson CI over all gauntlet games. */
  readonly overallWinRate: ProportionCI;
}

/**
 * Run `hero` against each deck in `gauntletDecks`, `gamesPerMatchup` games each.
 * The hero is seat A in every matchup. Opponent i uses base seed
 * `gameSeedFor(baseSeed, i)` so matchups are independent yet reproducible.
 */
export function runGauntlet(
  hero: LoadedDeck,
  gauntletDecks: readonly LoadedDeck[],
  pilots: MatchupPilots,
  gamesPerMatchup: number,
  baseSeed: number,
  registry: EffectRegistry,
  opts: RunOptions = {},
): GauntletResult {
  const stats = opts.stats ?? DEFAULT_STATS_CONFIG;
  const matchups: MatchupResult[] = [];
  let totalGames = 0;
  let totalWins = 0;
  let totalDraws = 0;

  for (let i = 0; i < gauntletDecks.length; i++) {
    const opponent = gauntletDecks[i] as LoadedDeck;
    const seats = makeSeats(hero, opponent, pilots, registry);
    const matchupSeed = gameSeedFor(baseSeed, i);
    const result = runMatchup(seats, gamesPerMatchup, matchupSeed, opts);
    matchups.push(result);
    totalGames += result.games;
    totalWins += result.winsA;
    totalDraws += result.draws;
  }

  return {
    hero: hero.name,
    matchups,
    totalGames,
    totalWins,
    totalDraws,
    overallWinRate: wilsonInterval(totalWins, totalGames, stats.z),
  };
}
