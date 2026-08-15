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
  FIDELITY_CAVEAT,
} from './config.js';

// Deck model + loader.
export type { Deck, DeckEntry, LoadedDeck } from './deck.js';
export { loadDeck, validateDeck, DeckLoadError } from './deck.js';

// Sample decks (the provisional gauntlet — DESIGN §3.5 / §3.8).
export { SAMPLE_DECKS } from '../data/decks/index.js';

// Statistics (pure).
export type { ProportionCI, PairedTable, McNemarResult, MultipleComparisonsMethod } from './stats.js';
export {
  wilsonInterval,
  wilsonUpperBound,
  mcNemarTest,
  chiSquare1dfUpperTail,
  normalCdf,
  adjustPValues,
} from './stats.js';

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
export type { CardSwap, SwapVerdict, SwapEvaluation, PairedSwapSummaryInput } from './swap.js';
export { evaluateSwap, applySwap, decideVerdict, summarizePairedSwap } from './swap.js';

// The incremental paired-arm runner (shared base arm + provably-identical games).
export type {
  PairedArmRunner,
  PairedArmsOptions,
  PairedArmsUsage,
  PairedSlot,
  SwapArm,
  ArmHandle,
} from './paired-arms.js';
export { createPairedArmRunner, pairedSlotAt, swappedInstanceIdFor } from './paired-arms.js';
export {
  HERO_SEAT,
  LIBRARY_READING_PRIMITIVES,
  LIBRARY_SAFE_PRIMITIVES,
  PILOTS_THAT_READ_HIDDEN_LIBRARY,
} from './paired-arms-config.js';

// The suggestion engine (DESIGN §3.6) — ranked single-card-swap recommendations.
export type {
  SuggestConfig,
  HeuristicWeights,
  AdaptiveSearchConfig,
  ExplorationWeights,
} from './suggest-config.js';
export {
  DEFAULT_SUGGEST_CONFIG,
  DEFAULT_HEURISTIC_WEIGHTS,
  DEFAULT_ADAPTIVE_CONFIG,
  DEFAULT_EXPLORATION_WEIGHTS,
} from './suggest-config.js';
export type {
  SwapCandidate,
  SkippedCandidate,
  RankedSwap,
  EliminationNote,
  EliminatedSwap,
  WaveReport,
  MultipleComparisonsReport,
  SuggestionReport,
  SuggestionNotes,
  SuggestOptions,
} from './suggest.js';
export { suggestSwaps, generateCandidates, rankEvaluations, scoreCandidate, traitsOf } from './suggest.js';

// The adaptive scheduler (pure — plan, eliminate, explore).
export type {
  WaveSpec,
  ArmStanding,
  EliminatedArm,
  EliminationReason,
  CandidateTraits,
  SchedulableCandidate,
  PriorEvidence,
  PrioritisedCandidate,
} from './suggest-schedule.js';
export {
  planWaves,
  selectSurvivors,
  selectOffspring,
  prioritiseCandidates,
  pairedAdvantage,
  relatedness,
} from './suggest-schedule.js';

// The cross-run search record the caller persists (web Lab / CLI --history).
export type { SuggestionHistory, CandidateHistory, HistoryUpdate } from './suggest-history.js';
export {
  SUGGESTION_HISTORY_VERSION,
  emptyHistory,
  acceptHistory,
  mergeHistory,
  deckFingerprint,
  candidateKey,
  isSettled,
} from './suggest-history.js';

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
