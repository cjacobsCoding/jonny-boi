/**
 * `@jonny-boi/sim` — the headless simulation harness + statistics (DESIGN §3.5).
 *
 * The lab's public surface:
 *   - Deck model + loader:        `Deck`, `DeckEntry`, `LoadedDeck`, `loadDeck`,
 *                                 `validateDeck`, `DeckLoadError`.
 *   - Sample decks (data):        `SAMPLE_DECKS` (the provisional gauntlet).
 *   - Single game:                `runMatch` → `MatchResult`.
 *   - n-game matchup + Wilson CI: `runMatchup` → `MatchupResult`.
 *   - Deck vs the gauntlet:       `runGauntlet` → `GauntletResult`.
 *   - THE A/B swap test:          `evaluateSwap` → `SwapEvaluation` (verdict).
 *   - Statistics (pure):          `wilsonInterval`, `mcNemarTest`, …
 *   - Reporter registry (§2 seam):`createDefaultReporterRegistry`, `Reporter`.
 *   - Named config:               `DEFAULT_SIM_CONFIG`, `DEFAULT_STATS_CONFIG`,
 *                                 `DEFAULT_DECK_RULES`.
 *
 * Determinism: every entry point is a pure function of its seeds + data. No
 * `Math.random`, no `Date.now` — the same `baseSeed` reproduces the same numbers,
 * which is exactly what makes the paired A/B verdict trustworthy.
 */

/** Stable package identity (retained for the cross-workspace smoke test). */
export const PACKAGE_NAME = 'sim';

// Config / named constants.
export type { DeckRules, SimConfig, StatsConfig } from './config.js';
export {
  DEFAULT_DECK_RULES,
  DEFAULT_SIM_CONFIG,
  DEFAULT_STATS_CONFIG,
  BASIC_LAND_NAMES,
} from './config.js';

// Deck model + loader.
export type { Deck, DeckEntry, LoadedDeck } from './deck.js';
export { loadDeck, validateDeck, DeckLoadError } from './deck.js';

// Sample decks (the provisional gauntlet — DESIGN §3.5 / §3.8).
export { SAMPLE_DECKS } from '../data/decks/index.js';

// Statistics (pure).
export type { ProportionCI, PairedTable, McNemarResult } from './stats.js';
export { wilsonInterval, mcNemarTest, chiSquare1dfUpperTail, normalCdf } from './stats.js';

// Single game.
export type {
  MatchResult,
  MatchOutcome,
  MatchSeats,
  MatchOptions,
  TracedDecision,
} from './match.js';
export { runMatch } from './match.js';

// Matchup (n games + CI).
export type { MatchupResult, MatchupPilots, RunOptions } from './matchup.js';
export { runMatchup, makeSeats, gameSeedFor, onPlayFor } from './matchup.js';

// Gauntlet.
export type { GauntletResult } from './gauntlet.js';
export { runGauntlet } from './gauntlet.js';

// The A/B single-card-swap test.
export type { CardSwap, SwapVerdict, SwapEvaluation } from './swap.js';
export { evaluateSwap, applySwap, decideVerdict } from './swap.js';

// Reporter registry (the §2 seam).
export type { Reporter, ReporterFactory, ReporterRegistry, MetricRow } from './reporters.js';
export {
  createReporterRegistry,
  createDefaultReporterRegistry,
  WIN_RATE_REPORTER_ID,
  TURN_STATS_REPORTER_ID,
} from './reporters.js';

/** The core package this harness drives, surfaced for the scaffold smoke test. */
export { PACKAGE_NAME as CORE_DEPENDENCY } from '@jonny-boi/core';
