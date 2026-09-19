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
 *   - THE PILOT A/B (deck-neutral):`runPilotAb` → `PilotAbResult` (verdict) — the
 *                                 question a gauntlet row cannot answer.
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

// The OWNER'S real, physical decks — the SEED the web app mints his own copies
// from. A separate registry from the gauntlet above on purpose (see
// `data/owner-decks/index.ts`: adding them to it would move every A/B baseline
// the lab has ever recorded), and NOT a separate kind of deck once seeded.
//
// ⚠️ `ownerDeckRules` used to be exported here and is gone. It set a deck's
// legal minimum to its own transcribed size so a 59-card list could call itself
// legal; it existed for one deck that is no longer seeded at all. A seeded deck
// obeys `DEFAULT_DECK_RULES` like every other deck.
export {
  OWNER_DECKS,
  OWNER_DECK_ENTRIES,
  applyDeckRevisions,
  currentOwnerDeck,
  transcribedSize,
} from '../data/owner-decks/index.js';
export type { DeckRevision, OwnerDeckEntry } from '../data/owner-decks/index.js';

// Statistics (pure).
export type { ProportionCI, PairedTable, McNemarResult, MultipleComparisonsMethod } from './stats.js';
// The group-sequential boundary (§3.92). Exported because the web Lab runs the
// same paired A/B and must stop on the same rule — two stopping rules would be
// two answers to one question.
export { planSequentialLooks, SUPPORTED_LOOK_COUNTS } from './sequential.js';
export type { SequentialPlan, SequentialOutcome } from './sequential.js';
// The two-stage fixed-width rule (§3.94) — the gauntlet ESTIMATES rather than
// tests, so the Lab must reach for this and not the boundary above.
export { planPrecision, decidePrecision } from './precision.js';
export type { PrecisionPlan, PrecisionDecision } from './precision.js';
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

/**
 * THE OBSERVATION CHOKEPOINT — the one place an engine event becomes something a
 * pilot may see (`docs/plans/superhuman-ai-program.md` §13–17). The vocabulary is
 * `@jonny-boi/ai`'s `Observation`; the masking is here, because the harness holds
 * the secrets and the pilot is the untrusted consumer.
 *
 * `hiddenInstanceIds` is exported for the same reason `@jonny-boi/protocol`
 * exports `collectInstanceIds`: an anti-cheat guarantee that cannot be re-run by
 * the next person to add a field is not a guarantee.
 */
export type { MatchObservers, ObservationPolicy } from './observation.js';
export { OBSERVATION_POLICY, observationOf, deliverObservation, hiddenInstanceIds } from './observation.js';

// Matchup (n games + CI). `RunRange` is the shard seam: a slice of the
// (opponent, game) grid, so a parallel host reuses these loops instead of
// restating them.
export type { MatchupResult, MatchupPilots, RunOptions, RunRange } from './matchup.js';
export { runMatchup, makeSeats, gameSeedFor, onPlayFor, resolveRunRange } from './matchup.js';

// Gauntlet.
export type { GauntletResult } from './gauntlet.js';
export { runGauntlet } from './gauntlet.js';

// The A/B single-card-swap test.
export type { CardSwap, SwapVerdict, SwapEvaluation, PairedSwapSummaryInput } from './swap.js';
export {
  evaluateSwap,
  applySwap,
  decideVerdict,
  summarizePairedSwap,
  copiesSwappedBy,
  GAMES_PER_PAIRED_GAME,
} from './swap.js';
export type { SwapScope } from './config.js';
export { DEFAULT_SWAP_SCOPE, copiesForScope, describeScope } from './config.js';

/**
 * WHAT A CARD IS FOR, AND WHAT A DECK IS MISSING (§3.135, §3.137) — the job a
 * compiled card holds, and how a deck's mix of jobs compares to real decks like
 * it. Exported because the Lab shows the gaps ("this deck has no removal") before
 * a single game is played, not only inside a finished suggestion report.
 */
export { roleOf, compareForUpgrade, primitivesOf, castableIn, type CardRole } from './card-role.js';
export {
  shapeOf,
  familyOf,
  familyFromTag,
  detectFamily,
  referenceProfile,
  findRoleGaps,
  describeGap,
  countRoles,
  ANSWER_ROLES,
  CARD_FLOW_ROLES,
  BOARD_ROLES,
  MIN_COHORT,
  type ArchetypeFamily,
  type DeckShape,
  type ReferenceProfile,
  type RoleGap,
  type GapKind,
} from './deck-shape.js';

/**
 * THE DECK-NEUTRAL PILOT A/B (DESIGN §3.46) — "is this pilot stronger?", asked so
 * that no single deck can answer for it.
 *
 * Exported as a tool, not just a CLI command: the gauntlet's win-rate is a
 * property of the meta (both seats run the same pilot), so anything that wants to
 * judge a PILOT change — the CLI, a Lab button, a future regression job — must
 * call this rather than read a gauntlet row. See `pilot-ab.ts` for the case that
 * proves it.
 */
export type {
  DeckPair,
  PilotAbContestants,
  PilotAbDeckRow,
  PilotAbOptions,
  PilotAbResult,
  PilotAbSlots,
  PilotAbVerdict,
} from './pilot-ab.js';
export {
  deckPairsOf,
  DEFAULT_PILOT_AB_GAMES_PER_ORIENTATION,
  ORIENTATIONS_PER_PAIR,
  PILOT_AB_BUILD_COMPARISON_NOTE,
  runPilotAb,
} from './pilot-ab.js';

// The incremental paired-arm runner (shared base arm + provably-identical games).
export type {
  PairedArmRunner,
  PairedArmsOptions,
  PairedArmsUsage,
  PairedBaseRecord,
  PairedSlice,
  PairedSlot,
  SwapArm,
  ArmHandle,
} from './paired-arms.js';
export { createPairedArmRunner, pairedBetweenArms, pairedSlotAt, swappedInstanceIdsFor } from './paired-arms.js';
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
  CandidateGenerationOptions,
  RankedSwap,
  EliminationNote,
  EliminatedSwap,
  WaveReport,
  MultipleComparisonsReport,
  SuggestionReport,
  SuggestionNotes,
  SuggestOptions,
  SuggestProgress,
  CandidateOutcome,
  SuggestionSearchResult,
  SuggestionReportInput,
} from './suggest.js';
export {
  suggestSwaps,
  generateCandidates,
  rankEvaluations,
  scoreCandidate,
  traitsOf,
  candidateSeedSalt,
  finishSuggestionRun,
} from './suggest.js';

// The search as a DRIVEABLE generator — the seam the parallel Lab runs on. It
// schedules the rounds; the elimination rule and the statistics stay in here.
export type {
  SuggestionRunPlan,
  PrepareSuggestionRunOptions,
  AdaptiveRound,
  AdaptiveArmRequest,
  AdaptiveArmOutcome,
  AdaptiveRoundResult,
  AdaptiveArmResult,
  AdaptiveSearchOutcome,
  AdaptiveSearchSettings,
  AdaptiveSearchDriver,
} from './suggest-run.js';
export { prepareSuggestionRun, driveAdaptiveSearch } from './suggest-run.js';

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

/*
 * THE FULL-POOL SOAK (`soak.ts`) — thousands of seeded games over randomised
 * legal decks built from the WHOLE pool, asserting invariants and requiring
 * every mechanic the pool prints to actually fire.
 *
 * Exported because it is a tool, not just a test: the CLI's `soak` command and
 * `soak-deep.test.ts` are two front ends onto the same function, and anything
 * that wants to soak a change (a Lab button, a CI job) should call this rather
 * than grow a third copy of the loop.
 */
export type { SoakMechanic, SoakMechanicId, SoakInvariantName, SoakWitnessKind } from './soak-config.js';
export {
  SOAK_BASE_SEED,
  SOAK_DEEP_DEFAULT_GAMES,
  SOAK_DEEP_ENV_VAR,
  SOAK_EVENT_WITNESS,
  SOAK_FAST_MIXED_GAMES,
  SOAK_INVARIANTS,
  SOAK_MECHANICS,
  SOAK_MECHANIC_SEED_ATTEMPTS,
} from './soak-config.js';
export type { SoakCardIndex, SoakDeck } from './soak-decks.js';
export { buildAnchoredDeck, buildMixedDeck, describeDeck, indexPoolForSoak } from './soak-decks.js';
export type { SoakOptions, SoakReport, SoakViolation } from './soak.js';
export {
  compareApplyPaths,
  formatSoakReport,
  formatViolations,
  requiredMechanicsOf,
  runSoak,
  soakSimConfig,
} from './soak.js';

/** The core package this harness drives, surfaced for the scaffold smoke test. */
export { PACKAGE_NAME as CORE_DEPENDENCY } from '@jonny-boi/core';
