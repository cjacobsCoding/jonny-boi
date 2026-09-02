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
import type { CardSwap, SwapEvaluation } from './swap.js';
import { copiesSwappedBy, evaluateSwap, summarizePairedSwap } from './swap.js';
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
import type { ArmHandle, PairedArmRunner, PairedArmsUsage, SwapArm } from './paired-arms.js';
import { createPairedArmRunner } from './paired-arms.js';
import type { SkippedCandidate, SwapCandidate } from './suggest-candidates.js';
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
   * The pilot playing this run. Stamps the returned record and lets a supplied
   * one be refused if it was gathered at a different level of play — evidence is
   * not comparable across pilots (see `SuggestionHistory.pilotId`).
   */
  readonly pilotId?: string;
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
 *
 * This is the SYNCHRONOUS entry point, and it plays every game on the calling
 * thread. `suggestSwapsWith` is the same search over a transport that can play
 * an arm's games elsewhere — the two share `prepareSuggestion`, the round loop
 * (`driveSuggestionArms`) and `finishSuggestion`, so they cannot drift apart.
 */
export function suggestSwaps(base: Deck, options: SuggestOptions): SuggestionReport {
  const setup = prepareSuggestion(base, options);
  const start = nowSeconds();
  const search =
    options.adaptive === false
      ? runFixedBudget(base, setup.plan, options, {
          games: setup.games,
          rules: setup.ctx.rules,
          stats: setup.ctx.stats,
        })
      : runAdaptiveSearchLocally(base, setup.plan, options, setup.ctx);
  return finishSuggestion(base, setup, search, nowSeconds() - start);
}

/**
 * THE SAME SEARCH, over an injectable arm transport (DESIGN §3.77).
 *
 * The only thing a caller supplies is "play these arms to these depths" — the
 * candidate generation, the wave ladder, the elimination rules, the report and
 * every number in it are the shared code below. That is what makes a pooled run
 * a TRANSPORT choice rather than a second search with its own answers.
 */
export async function suggestSwapsWith(
  base: Deck,
  options: SuggestOptions,
  transport: ArmTransport,
): Promise<SuggestionReport> {
  const setup = prepareSuggestion(base, options);
  const start = nowSeconds();
  const search = await runAdaptiveSearchOverTransport(base, setup.plan, options, setup.ctx, transport);
  return finishSuggestion(base, setup, search, nowSeconds() - start);
}

/** Everything both entry points settle before a single game is played. */
interface SuggestionSetup {
  readonly plan: SuggestionRunPlan;
  readonly games: number;
  readonly ctx: SearchContext & {
    readonly adaptiveConfig: AdaptiveSearchConfig;
    readonly exploration: ExplorationWeights;
  };
}

function prepareSuggestion(base: Deck, options: SuggestOptions): SuggestionSetup {
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
    ...(options.pilotId === undefined ? {} : { pilotId: options.pilotId }),
    ...(options.cutOnly ? { cutOnly: options.cutOnly } : {}),
    ...(options.inOnly ? { inOnly: options.inOnly } : {}),
  });

  return { plan, games, ctx: { rules, stats, adaptiveConfig, exploration } };
}

function finishSuggestion(
  base: Deck,
  setup: SuggestionSetup,
  search: SuggestionSearchResult,
  elapsedSeconds: number,
): SuggestionReport {
  const { plan, ctx } = setup;
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
    method: ctx.adaptiveConfig.multipleComparisons,
    exploration: ctx.exploration,
    stats: ctx.stats,
  });
}

/** Shared knobs the two search strategies both need. */
interface SearchContext {
  readonly rules: DeckRules;
  readonly stats: StatsConfig;
}

// --- the arm transport seam ----------------------------------------------------

/**
 * ONE ARM'S WORK FOR ONE ROUND: bring it from `fromGames` to `toGames` played
 * slots. The slot range is explicit because a transport that plays the games
 * somewhere else cannot ask a local runner how far the arm has got.
 */
export interface ArmAdvanceRequest {
  readonly key: string;
  readonly handle: ArmHandle;
  readonly swap: CardSwap;
  readonly outName: string;
  readonly inName: string;
  readonly fromGames: number;
  readonly toGames: number;
  /**
   * The built variant deck. Carried because the REPORT needs its name and a
   * transport that plays the games elsewhere has no runner to ask.
   */
  readonly variantDeck: Deck;
}

/** An arm's ACCUMULATED state after the advance — not just the new slice. */
export interface ArmAdvanceOutcome {
  readonly key: string;
  readonly arm: SwapArm;
}

/**
 * WHERE THE GAMES ARE PLAYED. The sequential implementation is a `PairedArmRunner`
 * and nothing else; the pooled one ships slot ranges to workers and merges the
 * tallies back. `usage` is asked of the TRANSPORT rather than read off the host's
 * runner because in a pooled run the host plays nothing, and a usage report
 * sourced from the host would claim a run of zero games.
 */
export interface ArmTransport {
  /**
   * Called ONCE before any advance, with the seed the run is played on.
   *
   * ⚠️ This exists because `runSeed` is NOT the caller's `baseSeed`: a run that
   * continues a history plays on `gameSeedFor(baseSeed, runsCompleted)` so a
   * re-run plays different games. A transport that derived the seed itself would
   * agree with the host on run 1 and silently play a DIFFERENT set of games on
   * every run after it — with a report that looked perfectly well-formed.
   */
  readonly begin?: (runSeed: number) => void;
  readonly advance: (requests: readonly ArmAdvanceRequest[]) => Promise<readonly ArmAdvanceOutcome[]>;
  readonly usage: (identicalGameSkip: { readonly enabled: boolean; readonly reason?: string }) => PairedArmsUsage;
}

/**
 * THE ROUND LOOP, SHARED BY BOTH TRANSPORTS.
 *
 * A generator, so the caller supplies the transport: it yields a whole round's
 * arm requests at once — which is exactly what lets a pooled caller shard the
 * round across workers — and is resumed with the advanced arms. Everything that
 * decides an ANSWER lives in here: opening arms, recording the ones that fail to
 * build, the progress callbacks, and building each verdict from the arm's own
 * tally. The scheduling decisions all happen inside `driveAdaptiveSearch`, so
 * this contains no elimination logic at all.
 */
function* driveSuggestionArms(
  base: Deck,
  plan: SuggestionRunPlan,
  options: SuggestOptions,
  ctx: SearchContext & {
    readonly adaptiveConfig: AdaptiveSearchConfig;
    readonly exploration: ExplorationWeights;
  },
  runner: PairedArmRunner,
): Generator<readonly ArmAdvanceRequest[], Omit<SuggestionSearchResult, 'usage'>, readonly ArmAdvanceOutcome[]> {
  const progress = options.onProgress;
  const scope = options.runOptions?.swapScope ?? DEFAULT_SWAP_SCOPE;
  /**
   * One arm's verdict, from the arm alone.
   *
   * `summarizePairedSwap` is a PURE function of the paired tally plus the swap's
   * names and scope — everything a `SwapArm` already carries — so the report
   * does not need the runner that played the games. That is the whole point:
   * a pooled run plays an arm's slots on workers and the host has only the
   * accumulated tally, and this is the one place both cases meet.
   */
  const evaluationOf = (arm: SwapArm): SwapEvaluation =>
    summarizePairedSwap({
      baseDeckName: base.name,
      variantDeckName: arm.variantDeck.name,
      swap: arm.swap,
      outName: arm.outName,
      inName: arm.inName,
      paired: arm.paired,
      ...(options.runOptions?.stats ? { stats: options.runOptions.stats } : {}),
      scope,
      copiesSwapped: copiesSwappedBy(base, arm.swap, options.pool, scope),
    });

  const handles = new Map<string, ArmHandle>();
  /** How deep each arm already is — the transport's `fromGames`. */
  const depth = new Map<string, number>();
  /** The latest arm read per candidate — the report's input. See below. */
  const lastArm = new Map<string, SwapArm>();
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
    const requests: ArmAdvanceRequest[] = [];
    const askedBy = new Map<string, SwapCandidate>();
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
      askedBy.set(candidate.key, candidate);
      requests.push({
        key: candidate.key,
        handle,
        swap: { out: candidate.outId, in: candidate.inId },
        outName: candidate.outName,
        inName: candidate.inName,
        fromGames: depth.get(candidate.key) ?? 0,
        toGames: request.toGames,
        variantDeck: runner.read(handle).variantDeck,
      });
    }

    // The whole round goes to the transport at once. A sequential transport walks
    // it in order and is identical to the loop this replaced; a pooled one cuts it
    // into slot ranges across every worker it has.
    const advanced = requests.length > 0 ? yield requests : [];
    for (const { key, arm } of advanced) {
      const candidate = askedBy.get(key);
      if (!candidate) continue;
      // ⚠️ THE ARM IS KEPT, not just its numbers, because the REPORT is built
      // from it below rather than from `runner.summarize`. A pooled run plays an
      // arm's slots on WORKERS, so the host's runner never sees those games and
      // `summarize` would report zeros — see COORDINATION.md. Reading the arm
      // here is what lets one loop serve both transports.
      lastArm.set(key, arm);
      depth.set(key, arm.gamesPlayed);
      answers.push({ key, gamesPlayed: arm.gamesPlayed, paired: arm.paired });
      progress?.onCandidate?.({
        key,
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
    // Built from the arm's own accumulated tally through the SAME pure
    // summariser `runner.summarize` calls. Identical output, and it no longer
    // requires the host to have played the games — the prerequisite for running
    // an arm's slots on workers.
    evaluation: evaluationOf(lastArm.get(arm.candidate.key) as SwapArm),
    gamesPlayed: arm.gamesPlayed,
    ...(arm.elimination ? { elimination: arm.elimination } : {}),
  }));

  return {
    outcomes,
    waves: outcome.waves,
    failures: outcome.failures,
    fixedSchemeGames: outcome.fixedSchemeGames,
  };
}

/** Build the runner both drivers use — for the pooled one, for metadata only. */
function armRunnerFor(
  base: Deck,
  plan: SuggestionRunPlan,
  options: SuggestOptions,
  ctx: SearchContext,
): PairedArmRunner {
  return createPairedArmRunner(base, {
    gauntletDecks: options.gauntletDecks,
    pilots: options.pilots,
    pool: options.pool,
    registry: options.registry,
    seed: plan.runSeed,
    deckRules: ctx.rules,
    ...(options.runOptions ? { runOptions: options.runOptions } : {}),
    ...(options.onProgress?.onGame ? { onGame: options.onProgress.onGame } : {}),
  });
}

/**
 * THE SINGLE-THREADED DRIVER of the adaptive search.
 *
 * It plays each round the generator asks for inline, on one incremental
 * `PairedArmRunner` — which is what makes base-arm reuse and the identical-game
 * skip free here: the runner already remembers every base slot it played.
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
  const runner = armRunnerFor(base, plan, options, ctx);
  const search = driveSuggestionArms(base, plan, options, ctx, runner);
  let step = search.next();
  while (!step.done) {
    step = search.next(
      step.value.map((request) => ({ key: request.key, arm: runner.advance(request.handle, request.toGames) })),
    );
  }
  return { ...step.value, usage: runner.usage() };
}

/**
 * THE POOLED DRIVER — the same generator, resumed with arms someone else played.
 *
 * The host still opens every arm (that is what vets legality and builds the
 * variant deck), but `transport.advance` decides where the games happen.
 */
async function runAdaptiveSearchOverTransport(
  base: Deck,
  plan: SuggestionRunPlan,
  options: SuggestOptions,
  ctx: SearchContext & {
    readonly adaptiveConfig: AdaptiveSearchConfig;
    readonly exploration: ExplorationWeights;
  },
  transport: ArmTransport,
): Promise<SuggestionSearchResult> {
  const runner = armRunnerFor(base, plan, options, ctx);
  transport.begin?.(plan.runSeed);
  const search = driveSuggestionArms(base, plan, options, ctx, runner);
  let step = search.next();
  while (!step.done) {
    step = search.next(await transport.advance(step.value));
  }
  return { ...step.value, usage: transport.usage(runner.identicalGameSkip) };
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
