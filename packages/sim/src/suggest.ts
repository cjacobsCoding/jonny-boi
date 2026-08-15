/**
 * THE DECK SUGGESTION ENGINE (DESIGN §3.6) — "tell me how to make my deck better".
 *
 * Given a base deck + the gauntlet, propose candidate single-card swaps, evaluate
 * them through the EXISTING paired A/B machinery (common random numbers + McNemar,
 * §3.5), and rank them by win-rate improvement and significance. We do NOT reinvent
 * the swap math or the stats (DRY) — `summarizePairedSwap` is shared with
 * `evaluateSwap` — and candidate generation, scheduling and ranking stay separate
 * pure functions so each is testable on its own.
 *
 * ### The search is ADAPTIVE
 *
 * The original engine enumerated ~1500 candidates, pre-ranked them with a cheap
 * deterministic heuristic, took the top K, and gave every one of them the same
 * fixed games budget. Two things were wrong with that, and a user found both:
 *
 *   1. It spent as much compute on an obvious loser as on a real contender.
 *   2. The pre-ranking ignored outcomes, so **re-running produced the identical
 *      shortlist** — "it just started comparing to Eternal Witness AGAIN". If the
 *      first K were all worse-or-inconclusive, the tool could never make progress.
 *
 * The search now:
 *
 *   - **Samples adaptively** (`suggest-schedule.ts`). Successive halving: every
 *     candidate gets a cheap scout batch, then the field halves while the budget
 *     doubles, so the finalists still reach FULL depth while hopeless arms are
 *     dropped after a fraction of the games. Clear losers exit even earlier under a
 *     futility rule (§ `selectSurvivors`).
 *   - **Corrects for multiplicity** (`stats.ts`). Testing 139 candidates at alpha
 *     0.05 yields ~7 false "better" verdicts by chance, so the reported verdict is
 *     decided from a Holm-corrected p-value over the whole family — including
 *     candidates PREVIOUS runs tested, so repeated runs cannot p-hack a winner.
 *   - **Progresses across runs** (`suggest-history.ts`). A run returns a
 *     serializable record; hand it back and the next run skips settled losers,
 *     prioritises untried candidates, and refines the promising ones.
 *   - **Exploits promising directions**. When a candidate scores well, untried
 *     candidates that resemble it (same add, same cut, same colour/curve/role) are
 *     pulled into the next wave — the user's "genetic algo" intuition, kept simple
 *     and explainable rather than a black box.
 *   - **Plays the base arm ONCE** (`paired-arms.ts`). Under common random numbers
 *     the base result for a given game is the same for every candidate; the old
 *     loop replayed the whole base gauntlet per candidate, so half of all games run
 *     were redundant.
 *
 * ### This file is now the COMPOSITION, not the algorithm
 *
 * The pieces live where they can be reused by a host that plays the games
 * elsewhere — the web Lab spreads one search over twelve Web Workers:
 *
 *   - `suggest-candidates.ts` — enumerate, pre-rank, rank (pure).
 *   - `suggest-run.ts`        — prepare a run; drive the wave ladder as a
 *                               *generator*, so the same elimination rule serves a
 *                               synchronous and an asynchronous driver.
 *   - `suggest-report.ts`     — multiplicity correction, verdicts, the record.
 *
 * `suggestSwaps` below is one driver of that generator: the single-threaded one,
 * which plays each round inline with `createPairedArmRunner`. The Lab is the
 * other. Neither owns the search.
 *
 * Honesty (CLAUDE.md rule 6, DESIGN §3.6): the report says how many games each
 * candidate actually got, what was eliminated early and why, what was never tried,
 * and how the multiple-comparisons correction was applied. Nothing is truncated
 * silently.
 *
 * Determinism: `suggestSwaps` is a pure function of its decks, options, seed and
 * supplied history. Wave scheduling changes WHICH games get played, never their
 * outcomes — every game's seed is derived from the run seed and its (opponent,
 * game index) slot, so a candidate's numbers do not depend on when it was played,
 * nor on which core played it.
 */

import type { EffectRegistry } from '@jonny-boi/core';
import type { CardPool } from '@jonny-boi/cards';
import type { Deck, LoadedDeck } from './deck.js';
import type { CardSwap } from './swap.js';
import { evaluateSwap } from './swap.js';
import type { MatchupPilots, RunOptions } from './matchup.js';
import { gameSeedFor } from './matchup.js';
import {
  DEFAULT_DECK_RULES,
  DEFAULT_STATS_CONFIG,
  DEFAULT_SWAP_SCOPE,
  type DeckRules,
  type StatsConfig,
} from './config.js';
import {
  DEFAULT_ADAPTIVE_CONFIG,
  DEFAULT_EXPLORATION_WEIGHTS,
  DEFAULT_SUGGEST_CONFIG,
  type AdaptiveSearchConfig,
  type ExplorationWeights,
  type HeuristicWeights,
  type SuggestConfig,
} from './suggest-config.js';
import type { ArmHandle } from './paired-arms.js';
import { createPairedArmRunner } from './paired-arms.js';
import type { SkippedCandidate } from './suggest-candidates.js';
import { candidateSeedSalt } from './suggest-candidates.js';
import type { SuggestionHistory } from './suggest-history.js';
import type {
  AdaptiveArmOutcome,
  AdaptiveSearchOutcome,
  SuggestionRunPlan,
} from './suggest-run.js';
import { driveAdaptiveSearch, prepareSuggestionRun } from './suggest-run.js';
import type { CandidateOutcome, SuggestionReport, SuggestionSearchResult } from './suggest-report.js';
import { finishSuggestionRun } from './suggest-report.js';

// Re-exported so `suggest.ts` stays the one import site for the engine's surface.
export type {
  SwapCandidate,
  SkippedCandidate,
  CandidateGenerationOptions,
} from './suggest-candidates.js';
export {
  generateCandidates,
  rankEvaluations,
  scoreCandidate,
  traitsOf,
  candidateSeedSalt,
} from './suggest-candidates.js';
export type {
  RankedSwap,
  EliminationNote,
  EliminatedSwap,
  WaveReport,
  MultipleComparisonsReport,
  SuggestionReport,
  SuggestionNotes,
  CandidateOutcome,
  SuggestionSearchResult,
  SuggestionReportInput,
} from './suggest-report.js';
export { finishSuggestionRun } from './suggest-report.js';
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

/** Progress callbacks so a long search can say what it is doing. */
export interface SuggestProgress {
  /**
   * A wave started: which one, how deep every arm in it will be played, and how
   * many arms are left. This is the honest unit of an adaptive search — "12 of 24
   * candidates, round 3 of 5" says far more than a bare percentage.
   */
  readonly onWave?: (info: {
    readonly wave: number;
    readonly totalWaves: number;
    readonly cumulativeGames: number;
    readonly candidates: number;
  }) => void;
  /** One candidate finished a wave, with the depth it has now reached. */
  readonly onCandidate?: (info: {
    readonly key: string;
    readonly outName: string;
    readonly inName: string;
    readonly wave: number;
    readonly gamesPlayed: number;
  }) => void;
  /** Games played since the previous tick (base and variant games alike). */
  readonly onGame?: (games: number) => void;
}

/** Options controlling a `suggestSwaps` run. */
export interface SuggestOptions {
  /** The gauntlet the candidates are judged against. Required. */
  readonly gauntletDecks: readonly LoadedDeck[];
  /** The pilots driving both seats. Required. */
  readonly pilots: MatchupPilots;
  /** The card pool (resolves names/ids and supplies `in` candidates). Required. */
  readonly pool: CardPool;
  /** The effect registry the sim plays with. Required. */
  readonly registry: EffectRegistry;
  /** Base RNG seed — same seed + inputs + history ⇒ same ranking. Required. */
  readonly baseSeed: number;
  /**
   * Games per matchup at FULL depth: what a finalist is measured with (adaptive),
   * or what every candidate gets (fixed). Defaults to `DEFAULT_SUGGEST_CONFIG`.
   */
  readonly gamesPerCandidate?: number;
  /** Bounds + thresholds (roster cap, basic-land floor). */
  readonly suggestConfig?: SuggestConfig;
  /** Cheap pre-rank heuristic weights. */
  readonly heuristicWeights?: HeuristicWeights;
  /** Wave shape, elimination thresholds, multiple-comparisons method. */
  readonly adaptiveConfig?: AdaptiveSearchConfig;
  /** Exploration weights: untried vs refine vs settled, and relatedness. */
  readonly explorationWeights?: ExplorationWeights;
  /** Deck-legality rules (4-of, min size, basics). */
  readonly deckRules?: DeckRules;
  /** Sim/stats run options threaded into the paired evaluation. */
  readonly runOptions?: RunOptions;
  /**
   * The record a previous run returned. Supply it and this run skips settled
   * losers, prioritises untried candidates, and plays DIFFERENT games (the run
   * counter offsets the seed). Omit for a first run.
   */
  readonly history?: SuggestionHistory;
  /**
   * Use the adaptive wave scheduler (default). Set false for the legacy
   * fixed-budget sweep — retained so the two can be compared head-to-head.
   */
  readonly adaptive?: boolean;
  /**
   * FOCUSED MODE — restrict which cards may be cut (names or ids). Omit for auto.
   */
  readonly cutOnly?: readonly string[];
  /**
   * FOCUSED MODE — restrict the `in` candidates to this shortlist (names or ids).
   * Omit for auto.
   */
  readonly inOnly?: readonly string[];
  /** Live progress, so a CLI or a UI can say what the search is doing. */
  readonly onProgress?: SuggestProgress;
}

// --- the engine ----------------------------------------------------------------

/**
 * THE SUGGESTION LOOP (DESIGN §3.6). See the module header for the full design;
 * in short: prepare → drive the wave ladder → correct for multiplicity → rank →
 * report, returning the record the next run builds on.
 *
 * Robust: a candidate that throws is recorded as skipped with its reason, not
 * crashed on; zero valid candidates ⇒ a well-formed empty report.
 */
export function suggestSwaps(base: Deck, options: SuggestOptions): SuggestionReport {
  const config = options.suggestConfig ?? DEFAULT_SUGGEST_CONFIG;
  const adaptiveConfig = options.adaptiveConfig ?? DEFAULT_ADAPTIVE_CONFIG;
  const exploration = options.explorationWeights ?? DEFAULT_EXPLORATION_WEIGHTS;
  const rules = options.deckRules ?? DEFAULT_DECK_RULES;
  const stats = options.runOptions?.stats ?? DEFAULT_STATS_CONFIG;
  const games = options.gamesPerCandidate ?? config.defaultGamesPerCandidate;
  const swapScope = options.runOptions?.swapScope ?? DEFAULT_SWAP_SCOPE;

  const plan = prepareSuggestionRun(base, {
    pool: options.pool,
    opponentCount: options.gauntletDecks.length,
    baseSeed: options.baseSeed,
    gamesPerCandidate: games,
    suggestConfig: config,
    ...(options.heuristicWeights ? { heuristicWeights: options.heuristicWeights } : {}),
    adaptiveConfig,
    explorationWeights: exploration,
    deckRules: rules,
    swapScope,
    ...(options.history ? { history: options.history } : {}),
    ...(options.cutOnly ? { cutOnly: options.cutOnly } : {}),
    ...(options.inOnly ? { inOnly: options.inOnly } : {}),
  });

  const start = nowSeconds();
  const search =
    options.adaptive === false
      ? runFixedBudget(base, plan, options, { games, rules, stats })
      : runAdaptiveSearchLocally(base, plan, options, { rules, stats, adaptiveConfig, exploration });
  const elapsedSeconds = nowSeconds() - start;

  // Candidates the roster cap left out this run — honest, not silent.
  const evaluatedKeys = new Set(search.outcomes.map((o) => o.candidate.key));
  const capped: SkippedCandidate[] = plan.reserves
    .filter((c) => !evaluatedKeys.has(c.key))
    .map((c) => ({ outName: c.outName, inName: c.inName, reason: 'capped' as const, details: [] }));

  return finishSuggestionRun({
    baseDeckName: base.name,
    search,
    skipped: [...plan.skipped, ...search.failures, ...capped],
    candidatesGenerated: plan.candidatesGenerated,
    cappedByBudget: capped.length > 0,
    elapsedSeconds,
    history: plan.history,
    ...(plan.historyRejected ? { historyRejected: plan.historyRejected } : {}),
    method: adaptiveConfig.multipleComparisons,
    exploration,
    stats,
  });
}

/** Shared knobs the two search strategies both need. */
interface SearchContext {
  readonly rules: DeckRules;
  readonly stats: StatsConfig;
}

/**
 * THE SINGLE-THREADED DRIVER of the adaptive search.
 *
 * It plays each round the generator asks for inline, on one incremental
 * `PairedArmRunner` — which is what makes base-arm reuse and the identical-game
 * skip free here: the runner already remembers every base slot it played. The
 * scheduling decisions all happen inside `driveAdaptiveSearch`, so this function
 * contains no elimination logic at all.
 */
function runAdaptiveSearchLocally(
  base: Deck,
  plan: SuggestionRunPlan,
  options: SuggestOptions,
  ctx: SearchContext & {
    readonly adaptiveConfig: AdaptiveSearchConfig;
    readonly exploration: ExplorationWeights;
  },
): SuggestionSearchResult {
  const progress = options.onProgress;
  const runner = createPairedArmRunner(base, {
    gauntletDecks: options.gauntletDecks,
    pilots: options.pilots,
    pool: options.pool,
    registry: options.registry,
    seed: plan.runSeed,
    deckRules: ctx.rules,
    ...(options.runOptions ? { runOptions: options.runOptions } : {}),
    ...(progress?.onGame ? { onGame: progress.onGame } : {}),
  });

  const handles = new Map<string, ArmHandle>();
  const driver = driveAdaptiveSearch(plan, {
    adaptiveConfig: ctx.adaptiveConfig,
    explorationWeights: ctx.exploration,
    stats: ctx.stats,
  });

  let step = driver.next();
  while (!step.done) {
    const round = step.value;
    progress?.onWave?.({
      wave: round.wave,
      totalWaves: plan.waves.length,
      cumulativeGames: round.cumulativeGames,
      candidates: round.arms.length,
    });

    const answers: AdaptiveArmOutcome[] = [];
    for (const request of round.arms) {
      const candidate = request.candidate;
      let handle = handles.get(candidate.key);
      if (!handle) {
        try {
          handle = runner.openArm({ out: candidate.outId, in: candidate.inId }, candidate.outName, candidate.inName);
        } catch (err) {
          // Survived legality but still failed to build — recorded, never fatal.
          answers.push({
            key: candidate.key,
            gamesPlayed: 0,
            paired: { bothWon: 0, baseOnly: 0, variantOnly: 0, neither: 0 },
            failure: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        handles.set(candidate.key, handle);
      }
      const arm = runner.advance(handle, request.toGames);
      answers.push({ key: candidate.key, gamesPlayed: arm.gamesPlayed, paired: arm.paired });
      progress?.onCandidate?.({
        key: candidate.key,
        outName: candidate.outName,
        inName: candidate.inName,
        wave: round.wave,
        gamesPlayed: arm.gamesPlayed,
      });
    }

    step = driver.next({ arms: answers });
  }

  const outcome: AdaptiveSearchOutcome = step.value;
  const outcomes: CandidateOutcome[] = outcome.arms.map((arm) => ({
    candidate: arm.candidate,
    evaluation: runner.summarize(handles.get(arm.candidate.key) as ArmHandle),
    gamesPlayed: arm.gamesPlayed,
    ...(arm.elimination ? { elimination: arm.elimination } : {}),
  }));

  return {
    outcomes,
    waves: outcome.waves,
    usage: runner.usage(),
    failures: outcome.failures,
    fixedSchemeGames: outcome.fixedSchemeGames,
  };
}

/**
 * THE LEGACY FIXED-BUDGET SWEEP — every candidate gets the same games, on its own
 * derived seed, through `evaluateSwap`. Retained (behind `adaptive: false`) so the
 * adaptive search can be compared against it head-to-head on the same inputs.
 */
function runFixedBudget(
  base: Deck,
  plan: SuggestionRunPlan,
  options: SuggestOptions,
  ctx: SearchContext & { readonly games: number },
): SuggestionSearchResult {
  const outcomes: CandidateOutcome[] = [];
  const failures: SkippedCandidate[] = [];
  let totalGamesPlayed = 0;

  for (const candidate of plan.roster) {
    // Per-candidate seed derived from the base seed and the STABLE candidate key,
    // so reordering candidates can't change any single evaluation's outcome.
    const candidateSeed = gameSeedFor(options.baseSeed, candidateSeedSalt(candidate.outId, candidate.inId));
    const swap: CardSwap = { out: candidate.outId, in: candidate.inId };
    try {
      const evaluation = evaluateSwap(
        base,
        swap,
        options.gauntletDecks,
        options.pilots,
        ctx.games,
        candidateSeed,
        options.pool,
        options.registry,
        // Hand the SAME legality rules down that generated the candidates.
        {
          ...options.runOptions,
          deckRules: ctx.rules,
          ...(options.onProgress?.onGame ? { onGame: options.onProgress.onGame } : {}),
        },
      );
      outcomes.push({ candidate, evaluation, gamesPlayed: evaluation.nGames });
      totalGamesPlayed += evaluation.nGames * 2;
    } catch (err) {
      failures.push({
        outName: candidate.outName,
        inName: candidate.inName,
        reason: 'illegal',
        details: [err instanceof Error ? err.message : String(err)],
      });
    }
  }

  return {
    outcomes,
    waves: [],
    usage: {
      baseGamesPlayed: totalGamesPlayed / 2,
      variantGamesPlayed: totalGamesPlayed / 2,
      variantGamesSkipped: 0,
      totalGamesPlayed,
      identicalGameSkipEnabled: false,
      identicalGameSkipDisabledReason: 'fixed-budget mode re-runs both arms per candidate',
    },
    failures,
    fixedSchemeGames: totalGamesPlayed,
  };
}

/** Wall-clock seconds; isolated so the engine stays a pure-ish data transform. */
function nowSeconds(): number {
  return Date.now() / 1000;
}
