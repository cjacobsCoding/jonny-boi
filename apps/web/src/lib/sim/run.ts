/**
 * **Running a Lab request across a pool of workers** — plan → dispatch → merge.
 *
 * The orchestration lives here rather than in the pool so it is testable without
 * a browser: the runner is injected (`ShardRunner`), so the determinism suite can
 * drive the exact same code path with a synchronous in-process runner, at one
 * "worker" and at twelve, and with shards deliberately completing out of order.
 *
 * Nothing here plays a game or computes a statistic — `execute.ts` plays, and
 * `merge.ts` aggregates. This module only decides *what to dispatch*, *how to
 * count progress honestly*, and *what a failure means*.
 */
import {
  decidePrecision,
  planPrecision,
  planSequentialLooks,
  type PrecisionDecision,
  type SequentialOutcome,
  type SwapScope,
} from '@jonny-boi/sim';
import type {
  GauntletRequest,
  JointPhaseRequest,
  ManabaseRequest,
  MatchRequest,
  SimProgress,
  SimResultPayload,
  SuggestRequest,
  SwapRequest,
  TrimRequest,
  VerdictBarRequest,
} from '../sim-protocol.js';
import { TRIM_SWAP_SCOPE, finishTrimRound } from '@jonny-boi/sim';
import {
  finishManabaseRun,
  variantForCandidateKey,
  type PairedGameObservation,
} from '@jonny-boi/sim';
import { JOINT_PHASES, finishJointPhase, moveForCandidateKey } from '@jonny-boi/sim';
import {
  DEFAULT_ADAPTIVE_CONFIG,
  DEFAULT_EXPLORATION_WEIGHTS,
  DEFAULT_SWAP_SCOPE,
  GAMES_PER_PAIRED_GAME,
  driveAdaptiveSearch,
  finishSuggestionRun,
  statsConfigFor,
  summarizePairedSwap,
  type StatsConfig,
  type AdaptiveRound,
  type AdaptiveSearchOutcome,
  type PairedBaseRecord,
  type PairedTable,
  type SkippedCandidate,
  type SuggestionRunPlan,
} from '@jonny-boi/sim';
import { resolveOpponentNames } from './opponents.js';
import {
  planBaseSlotShards,
  planGauntletShards,
  planManabaseBaseSlotShards,
  planManabaseVariantSliceShards,
  planPairedShards,
  planVariantSliceShards,
  totalGauntletGames,
  totalPairedGames,
} from './plan.js';
import { mergeGauntlet, mergePairedEvaluation, mergeVariantSlices } from './merge.js';
import type {
  BaseSlotShardResult,
  GauntletShardResult,
  ManabaseBaseSlotShardResult,
  JointPlanResult,
  ManabasePlanResult,
  ManabaseVariantSliceShardResult,
  MatchJobResult,
  PairedShardResult,
  ShardContext,
  ShardJob,
  ShardResult,
  SuggestPlanResult,
  TrimPlanResult,
  VariantSliceShardResult,
} from './shard-protocol.js';

/**
 * A shard failed. `permanent` distinguishes "this job can never succeed" (an
 * illegal swap, an unknown deck) from "this attempt failed" (the worker died),
 * which is what lets the pool retry the second kind and only the second kind.
 */
export class ShardFailure extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = 'ShardFailure';
    this.permanent = permanent;
  }
}

/** Thrown when a run is cancelled; the UI treats it as "back to idle", not an error. */
export class RunCancelled extends Error {
  constructor() {
    super('run cancelled');
    this.name = 'RunCancelled';
  }
}

export function isCancellation(err: unknown): boolean {
  return err instanceof RunCancelled || (err instanceof Error && err.name === 'RunCancelled');
}

/** Anything that can execute shards concurrently — a worker pool, or a test double. */
export interface ShardRunner {
  /** How many shards this runner executes at once (drives the plan's granularity). */
  readonly workerCount: number;
  /**
   * Dispatch one shard. `onGames` is called with the number of games finished
   * since the previous call, so progress is a sum of deltas and never depends on
   * which worker reports first. Rejects with `ShardFailure` or `RunCancelled`.
   */
  submit(job: ShardJob, onGames: (games: number) => void): Promise<ShardResult>;
  /**
   * Get every worker ready before a long run's first shard, when the runner has
   * a start-up cost worth overlapping. Optional: an in-process runner has none.
   */
  warmUp?(): void;
}

/**
 * THE BAR A REQUEST ASKED FOR (DESIGN §3.179), as a `StatsConfig`.
 *
 * ⚠️ ONE function, read by every run kind, and `z` is DERIVED here rather than
 * carried on the wire: two fields that can disagree are a bug waiting to be
 * filed, and a 90% verdict printed beside a 95% interval is exactly that bug.
 * `statsConfigFor` refuses an alpha with no row in `VERDICT_BARS` instead of
 * snapping it to the nearest one.
 *
 * These three call sites used to read DEFAULT_STATS_CONFIG directly, which was
 * invisible while alpha was a constant and became a lie the moment it was a
 * control.
 */
function statsOf(request: VerdictBarRequest): StatsConfig {
  return statsConfigFor(request.verdictAlpha, request.verdictMinGames);
}

/** Everything a run reports back as it goes. */
export type ProgressSink = (progress: SimProgress) => void;

/** Wall-clock seconds, isolated so the run logic stays a data transform. */
function nowSeconds(): number {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}

/**
 * Tracks games completed across every worker and turns them into ONE honest
 * total. Workers report deltas, so the aggregate is a plain sum: it cannot
 * double-count a retried shard's partial progress, because a retry starts a fresh
 * delta stream and the tally is reconciled from the completed shards' own game
 * counts when the run ends.
 */
class ProgressTally {
  private games = 0;
  private readonly startedAt = nowSeconds();
  private lastEmittedAt = -Infinity;

  constructor(
    private total: number,
    private readonly sink: ProgressSink,
    private readonly intervalSeconds: number,
  ) {}

  get gamesDone(): number {
    return this.games;
  }

  get elapsedSeconds(): number {
    return nowSeconds() - this.startedAt;
  }

  add(games: number): void {
    this.games += games;
  }

  /**
   * Revise the denominator.
   *
   * An adaptive search cannot know its total up front — how many games it plays
   * depends on who survives, and the identical-game skip answers an unpredictable
   * share of them for free. So the total is a live ESTIMATE, revised each round
   * and settled exactly when the run ends. Revising it is honest; pretending a
   * guess was a plan, and letting the bar sit at 87% forever, is not.
   */
  setTotal(total: number): void {
    this.total = Math.max(total, this.games);
  }

  /** Emit a progress message, rate-limited unless `force`. */
  emit(label: string, force = false): void {
    const elapsedSeconds = this.elapsedSeconds;
    if (!force && elapsedSeconds - this.lastEmittedAt < this.intervalSeconds) return;
    this.lastEmittedAt = elapsedSeconds;
    this.sink({
      type: 'progress',
      done: Math.min(this.games, this.total),
      total: this.total,
      gamesRun: this.games,
      elapsedSeconds,
      label,
    });
  }
}

/**
 * Build the shard context shared by every job in a run.
 *
 * Taking the whole request rather than loose fields is what makes it impossible
 * to plan a run that forgot the pilot: the context is built once per run, from the
 * one object the user's choices arrived in.
 */
function contextFor(
  request: {
    readonly hero: GauntletRequest['hero'];
    readonly seed: number;
    readonly pilotId: string;
    /** §3.136 — carried when the caller asked for a non-default swap scope. */
    readonly swapScope?: SwapScope;
  },
  opponentNames: readonly string[],
): ShardContext {
  return {
    hero: request.hero,
    opponentNames,
    seed: request.seed,
    pilotId: request.pilotId,
    // Omitted (not `undefined`) when unset, so the context stays byte-identical
    // to what every previous run sent and no cache key shifts under it.
    ...(request.swapScope ? { swapScope: request.swapScope } : {}),
  };
}

/** The opponents a request will actually face, in canonical order. */
function opponentsFor(request: {
  readonly hero: { readonly name: string };
  readonly opponentNames: readonly string[];
}): readonly string[] {
  const names = resolveOpponentNames(request.opponentNames, request.hero.name);
  if (names.length === 0) throw new Error('no gauntlet opponents selected.');
  return names;
}

/** How many workers a run should tell the user it is using. */
function workersLabel(count: number): string {
  return count === 1 ? '1 worker' : `${count} workers`;
}

// --- gauntlet ------------------------------------------------------------------

export async function runGauntlet(
  request: GauntletRequest,
  runner: ShardRunner,
  sink: ProgressSink,
  progressIntervalSeconds: number,
): Promise<SimResultPayload> {
  const opponentNames = opponentsFor(request);
  const context = contextFor(request, opponentNames);

  /*
   * ⚠️ THE PROGRESS BAR COUNTS THE WHOLE BUDGET, even when the run may size
   * itself down. A bar scaled to what the run turned out to need would leap when
   * the pilot decided — reporting the stopping rule as progress rather than work.
   */
  const total = totalGauntletGames(
    planGauntletShards(context, request.gamesPerOpponent, runner.workerCount),
  );
  const tally = new ProgressTally(total, sink, progressIntervalSeconds);
  const label = `${opponentNames.length === 1 ? `vs ${opponentNames[0]}` : `${opponentNames.length} opponents`} · ${workersLabel(runner.workerCount)}`;
  // Say we are alive BEFORE the first (potentially multi-second) game.
  tally.emit(label, true);

  /** Play one window's shards and return their results. */
  const playWindow = async (window?: { gameStart: number; gameEnd: number }) => {
    if (window && window.gameEnd <= window.gameStart) return [] as GauntletShardResult[];
    const jobs = planGauntletShards(context, request.gamesPerOpponent, runner.workerCount, window);
    return Promise.all(
      jobs.map(async (job) => {
        const result = (await runner.submit(job, (games) => {
          tally.add(games);
          tally.emit(label);
        })) as GauntletShardResult;
        tally.emit(label);
        return result;
      }),
    );
  };

  const results: GauntletShardResult[] = [];
  let precision: PrecisionDecision | undefined;

  if (request.untilPrecise !== undefined) {
    /*
     * TWO STAGES, ONE DECISION (§3.94). A gauntlet ESTIMATES a win rate, so the
     * group-sequential boundary the A/B panel uses would be answering the wrong
     * question — there is no null here to reject. The pilot sizes the run, the
     * run reports the interval it actually earned, and nothing peeks between.
     */
    const plan = planPrecision(request.gamesPerOpponent, request.untilPrecise);
    results.push(...(await playWindow({ gameStart: 0, gameEnd: plan.pilotGames })));
    const pilot = mergeGauntlet(results);
    precision = decidePrecision(plan, pilot.totalWins, pilot.totalGames, opponentNames.length);
    results.push(...(await playWindow({ gameStart: plan.pilotGames, gameEnd: precision.totalGames })));
  } else {
    results.push(...(await playWindow()));
  }

  const elapsedSeconds = tally.elapsedSeconds;
  const merged = mergeGauntlet(results);
  tally.emit(label, true);
  return {
    kind: 'gauntlet',
    result: merged,
    gamesPerSecond: elapsedSeconds > 0 ? merged.totalGames / elapsedSeconds : 0,
    pilotId: request.pilotId,
    ...(precision ? { precision } : {}),
  };
}

// --- A/B swap ------------------------------------------------------------------

/**
 * Looks the Lab plans an early-stopping A/B for. Four matches the CLI default:
 * enough to stop early on a decided swap, few enough that the Pocock penalty per
 * look stays mild. Named so the Lab and the CLI cannot drift to different bars.
 */
const LAB_SEQUENTIAL_LOOKS = 4;

export async function runSwap(
  request: SwapRequest,
  runner: ShardRunner,
  sink: ProgressSink,
  progressIntervalSeconds: number,
): Promise<SimResultPayload> {
  const opponentNames = opponentsFor(request);
  const context = contextFor(request, opponentNames);
  const swap = {
    outCardId: request.outCardId,
    inCardId: request.inCardId,
    // Carried from the user's choice in the A/B panel. Dropping it here would
    // not fail — it would quietly answer the OTHER question.
    swapScope: request.swapScope,
  };

  /*
   * ⚠️ THE WHOLE BUDGET IS STILL PLANNED, even when stopping early is on: the
   * progress bar must show what the user asked for, not what the run turned out
   * to need. A bar that reached 100% and then kept going — or one that jumped to
   * the end when a window closed — would be reporting the stopping rule as
   * progress.
   */
  const total = totalPairedGames(
    planPairedShards(context, swap, request.gamesPerOpponent, runner.workerCount, request.seed, null),
  );
  const tally = new ProgressTally(total, sink, progressIntervalSeconds);
  const label = `paired A/B games · ${workersLabel(runner.workerCount)}`;
  tally.emit(label, true);

  /** Play one window's shards and return their results. */
  const playWindow = async (window?: { gameStart: number; gameEnd: number }) => {
    const jobs = planPairedShards(
      context,
      swap,
      request.gamesPerOpponent,
      runner.workerCount,
      request.seed,
      null,
      window,
    );
    return Promise.all(
      jobs.map(async (job) => {
        const result = (await runner.submit(job, (games) => {
          tally.add(games);
          tally.emit(label);
        })) as PairedShardResult;
        tally.emit(label);
        return result;
      }),
    );
  };

  const results: PairedShardResult[] = [];
  let sequential: SequentialOutcome | undefined;

  if (request.untilDecided) {
    // The SAME boundary the CLI uses (`@jonny-boi/sim`), not a second rule: the
    // looks are fixed in advance and each is judged at a tighter threshold, so
    // the run-wide false-positive rate is still the alpha the verdict quotes.
    const plan = planSequentialLooks(request.gamesPerOpponent, LAB_SEQUENTIAL_LOOKS);
    let from = 0;
    let looksTaken = 0;
    for (const checkpoint of plan.checkpoints) {
      results.push(...(await playWindow({ gameStart: from, gameEnd: checkpoint })));
      from = checkpoint;
      looksTaken += 1;
      if (mergePairedEvaluation(results, statsOf(request)).pValue < plan.perLookAlpha) break;
    }
    sequential = {
      gamesPlayed: from,
      looksTaken,
      stoppedEarly: from < request.gamesPerOpponent,
      perLookAlpha: plan.perLookAlpha,
    };
  } else {
    results.push(...(await playWindow()));
  }

  const elapsedSeconds = tally.elapsedSeconds;
  const evaluation = mergePairedEvaluation(results, statsOf(request));
  tally.emit(label, true);
  return {
    kind: 'swap',
    result: evaluation,
    gamesPerSecond:
      elapsedSeconds > 0 ? (evaluation.nGames * GAMES_PER_PAIRED_GAME) / elapsedSeconds : 0,
    pilotId: request.pilotId,
    ...(sequential ? { sequential } : {}),
  };
}

// --- suggestions ---------------------------------------------------------------

/**
 * THE POOLED LADDER, shared by Suggest and the Trim (§3.174).
 *
 * Drive `driveAdaptiveSearch` over `plan` round by round with a barrier — the
 * shared base games for the slots the round adds, then every surviving arm's
 * variant games over those slots — and hand back the search's outcome plus the
 * variant games it cost. Everything it decides is scheduling; who survives is
 * the sim's call. A trim round drives it with a roster of REMOVALS (a swap
 * whose in-card is nothing, built by `applySwap` in the workers), so one loop
 * serves both searches and cannot quietly disagree with itself.
 */
async function drivePooledSearch(
  plan: SuggestionRunPlan,
  context: ShardContext,
  runner: ShardRunner,
  tally: ProgressTally,
): Promise<PooledSearchResult> {
  // Live state the rounds accumulate. Every one of these is either an integer sum
  // or keyed by the candidate's stable key, so none of them can carry arrival
  // order into the result.
  const baseRecords = new Map<number, PairedBaseRecord>();
  let armTables: ReadonlyMap<string, PairedTable> = new Map();
  /**
   * Per-arm slot outcomes, spliced in at each slice's absolute offset (§3.97).
   * The ladder needs these to compare the LEADER with the RUNNER-UP; without
   * them the leader-settled stop (§3.98) never fires here and the Lab would keep
   * playing a third more games than the CLI for the same recommendation.
   */
  const armSlots = new Map<string, boolean[]>();
  const failures = new Map<string, string>();
  let variantGamesPlayed = 0;
  let variantGamesSkipped = 0;

  const driver = driveAdaptiveSearch(plan);
  let step = driver.next();
  let label = `round 1 of ${plan.waves.length} · ${workersLabel(runner.workerCount)}`;
  tally.emit(label, true);

  while (!step.done) {
    const round = step.value;
    const live = round.arms.filter((arm) => !failures.has(arm.candidate.key));
    label =
      `round ${round.wave} of ${plan.waves.length} · ${live.length} ` +
      `${live.length === 1 ? 'candidate' : 'candidates'} · ${round.cumulativeGames} games each · ` +
      workersLabel(runner.workerCount);
    tally.emit(label, true);

    // --- phase A: the shared base arm, for the slots this round adds ---
    const baseJobs = planBaseSlotShards(
      context,
      plan.runSeed,
      round.baseSlotStart,
      round.baseSlotEnd,
      runner.workerCount,
    );
    const baseResults = (await Promise.all(
      baseJobs.map(async (job) => {
        const result = await runner.submit(job, (games) => {
          tally.add(games);
          tally.emit(label);
        });
        tally.emit(label);
        return result as BaseSlotShardResult;
      }),
    )) as BaseSlotShardResult[];
    for (const result of baseResults) {
      result.records.forEach((record, i) => baseRecords.set(result.slotStart + i, record));
    }

    // --- barrier --- phase B may not start until every base record above exists.

    const sliceJobs = planVariantSliceShards(
      context,
      plan.runSeed,
      live.map((arm) => ({
        candidateKey: arm.candidate.key,
        outCardId: arm.candidate.outId,
        inCardId: arm.candidate.inId,
        outName: arm.candidate.outName,
        inName: arm.candidate.inName,
        fromSlot: arm.fromGames,
        toSlot: arm.toGames,
      })),
      runner.workerCount,
      (slot) => baseRecords.get(slot) as PairedBaseRecord,
    );

    const settled = await Promise.all(
      sliceJobs.map(async (job) => {
        try {
          const result = (await runner.submit(job, (games) => {
            tally.add(games);
            tally.emit(label);
          })) as VariantSliceShardResult;
          tally.emit(label);
          return result;
        } catch (err) {
          if (isCancellation(err)) throw err;
          // One bad candidate must not throw away a search that may have been
          // running for twenty minutes. Drop the ARM (not the run) and record
          // why, so the report is honest about its coverage.
          if (!failures.has(job.candidateKey)) {
            failures.set(job.candidateKey, err instanceof Error ? err.message : String(err));
          }
          return null;
        }
      }),
    );

    const usable = settled.filter(
      (result): result is VariantSliceShardResult =>
        result !== null && !failures.has(result.candidateKey),
    );
    for (const slice of usable) {
      variantGamesPlayed += slice.variantGamesPlayed;
      variantGamesSkipped += slice.variantGamesSkipped;
      // Sparse write BY INDEX, so slices arriving in any order compose into the
      // same array a locally-played arm would have built.
      let slots = armSlots.get(slice.candidateKey);
      if (!slots) {
        slots = [];
        armSlots.set(slice.candidateKey, slots);
      }
      for (let i = 0; i < slice.variantWonBySlot.length; i++) {
        slots[slice.slotStart + i] = slice.variantWonBySlot[i] as boolean;
      }
    }
    for (const key of failures.keys()) armSlots.delete(key);
    armTables = mergeVariantSlices(dropFailed(armTables, failures), usable);

    step = driver.next({
      arms: round.arms.map((arm) => {
        const failure = failures.get(arm.candidate.key);
        if (failure !== undefined) {
          return { key: arm.candidate.key, gamesPlayed: 0, paired: EMPTY_TABLE, failure };
        }
        const slots = armSlots.get(arm.candidate.key);
        return {
          key: arm.candidate.key,
          gamesPlayed: arm.toGames,
          paired: armTables.get(arm.candidate.key) ?? EMPTY_TABLE,
          ...(slots ? { variantWonBySlot: slots } : {}),
        };
      }),
    });
    tally.setTotal(estimatePlannedGames(plan, tally.gamesDone, step.done ? undefined : step.value));
  }

  return { outcome: step.value, variantGamesPlayed, variantGamesSkipped };
}

/** What the pooled ladder hands back: the search's outcome and the games it cost. */
interface PooledSearchResult {
  readonly outcome: AdaptiveSearchOutcome;
  readonly variantGamesPlayed: number;
  readonly variantGamesSkipped: number;
}

/**
 * THE POOLED DRIVER OF THE ADAPTIVE SEARCH.
 *
 * Successive halving cannot be flattened into a queue of independent games: which
 * arms survive round N+1 depends on what round N measured. So the pool drives the
 * sim's search generator **round by round, with a barrier**, and each round is two
 * parallel phases:
 *
 *   A. the SHARED base games for the slots this round newly needs (one game per
 *      slot for the whole run — base-arm reuse, preserved across workers), then
 *   B. every surviving arm's variant games over those slots, cut by slot range so
 *      a two-survivor round still fills the machine.
 *
 * Phase B needs phase A's records to keep the identical-game skip, which is what
 * forces the barrier between them. Utilisation is highest in the wide early
 * rounds and drops in the late ones — few arms, and the round can only finish when
 * its slowest shard does. That cost is inherent to a stateful search; the
 * alternative is a faster run that answers a different question.
 *
 * Everything this function decides is scheduling. Who survives, what each verdict
 * is, how the list ranks and what the next run should explore are all decided by
 * `@jonny-boi/sim` — `driveAdaptiveSearch` and `finishSuggestionRun`.
 */
export async function runSuggest(
  request: SuggestRequest,
  runner: ShardRunner,
  sink: ProgressSink,
  progressIntervalSeconds: number,
): Promise<SimResultPayload> {
  const opponentNames = opponentsFor(request);
  const context = contextFor(request, opponentNames);
  const startedAt = nowSeconds();

  // Phase 1 is a SINGLE job, so left alone the pool would spawn one worker now
  // and the other ten during round 1 — putting their card-pool construction
  // inside the first round of games instead of alongside the planning. Warm them
  // all here and the spin-up overlaps work that has to happen anyway.
  runner.warmUp?.();

  // PHASE 1 — enumerate + pre-rank candidates, accept the cross-run record, plan
  // the waves. Pure CPU over the whole card pool, so it runs on a worker; doing it
  // on the main thread would freeze the UI before the first game is played.
  sink({
    type: 'progress',
    done: 0,
    total: 0,
    gamesRun: 0,
    elapsedSeconds: 0,
    label: 'finding candidate swaps…',
  });
  const planned = (await runner.submit(
    {
      kind: 'suggest-plan',
      context,
      maxCandidates: request.maxCandidates,
      gamesPerCandidate: request.gamesPerCandidate,
      ...(request.history ? { history: request.history } : {}),
      // §3.136 — which cards the search may cut. The scope rides the context
      // (the arms need it too); this is the planning half.
      ...(request.cutOnly && request.cutOnly.length > 0 ? { cutOnly: request.cutOnly } : {}),
    },
    () => {},
  )) as SuggestPlanResult;
  const plan = planned.plan;

  const tally = new ProgressTally(estimatePlannedGames(plan), sink, progressIntervalSeconds);

  const { outcome, variantGamesPlayed, variantGamesSkipped } = await drivePooledSearch(
    plan,
    context,
    runner,
    tally,
  );
  const elapsedSeconds = nowSeconds() - startedAt;
  const baseGamesPlayed = outcome.baseSlotsPlayed;
  // Reserve candidates the search never reached — reported, never silent.
  const evaluated = new Set(outcome.arms.map((arm) => arm.candidate.key));
  const capped: SkippedCandidate[] = plan.reserves
    .filter((candidate) => !evaluated.has(candidate.key))
    .map((candidate) => ({
      outName: candidate.outName,
      inName: candidate.inName,
      reason: 'capped' as const,
      details: [],
    }));

  const report = finishSuggestionRun({
    baseDeckName: plan.baseDeckName,
    search: {
      // Each arm's cumulative table becomes the §3.5 verdict through the sim's own
      // `summarizePairedSwap` — the same function `evaluateSwap` ends with, so a
      // pooled verdict is computed by exactly the code the CLI's verdict is.
      outcomes: outcome.arms.map((arm) => ({
        candidate: arm.candidate,
        evaluation: summarizePairedSwap({
          baseDeckName: plan.baseDeckName,
          variantDeckName: arm.candidate.variantDeckName,
          swap: { out: arm.candidate.outId, in: arm.candidate.inId },
          outName: arm.candidate.outName,
          inName: arm.candidate.inName,
          paired: arm.paired,
          scope: DEFAULT_SWAP_SCOPE,
          copiesSwapped: arm.candidate.copiesSwapped,
          stats: statsOf(request),
        }),
        gamesPlayed: arm.gamesPlayed,
        ...(arm.elimination ? { elimination: arm.elimination } : {}),
      })),
      waves: outcome.waves,
      usage: {
        baseGamesPlayed,
        variantGamesPlayed,
        variantGamesSkipped,
        totalGamesPlayed: baseGamesPlayed + variantGamesPlayed,
        identicalGameSkipEnabled: planned.identicalGameSkipEnabled,
        ...(planned.identicalGameSkipDisabledReason
          ? { identicalGameSkipDisabledReason: planned.identicalGameSkipDisabledReason }
          : {}),
      },
      failures: outcome.failures,
      fixedSchemeGames: outcome.fixedSchemeGames,
    },
    skipped: [...plan.skipped, ...outcome.failures, ...capped],
    candidatesGenerated: plan.candidatesGenerated,
    cappedByBudget: capped.length > 0,
    elapsedSeconds,
    history: plan.history,
    ...(plan.historyRejected ? { historyRejected: plan.historyRejected } : {}),
    method: DEFAULT_ADAPTIVE_CONFIG.multipleComparisons,
    exploration: DEFAULT_EXPLORATION_WEIGHTS,
    stats: statsOf(request),
    workersUsed: runner.workerCount,
  });

  // The estimate has served its purpose; end on the number actually played.
  tally.setTotal(tally.gamesDone);
  tally.emit(`${report.candidatesEvaluated} candidates · ${workersLabel(runner.workerCount)}`, true);
  return { kind: 'suggest', result: report, pilotId: request.pilotId };
}

// --- trim (§3.174) -------------------------------------------------------------------

/**
 * ONE ROUND OF THE TRIM, on the pool: plan the removals on a worker, drive the
 * SAME pooled ladder Suggest drives, and let the sim's `finishTrimRound` decide
 * the round — every verdict through the shared Holm correction, the winner and
 * the on-the-edge candidate read off the same ranking the CLI would produce.
 *
 * The shard context carries the trim's ONE-copy scope, so the workers' arm
 * runner builds each candidate's variant (one copy out, nothing in) exactly as
 * the planner validated it.
 */
export async function runTrim(
  request: TrimRequest,
  runner: ShardRunner,
  sink: ProgressSink,
  progressIntervalSeconds: number,
): Promise<SimResultPayload> {
  const opponentNames = opponentsFor(request);
  const context = contextFor({ ...request, swapScope: TRIM_SWAP_SCOPE }, opponentNames);
  const startedAt = nowSeconds();

  runner.warmUp?.();
  sink({
    type: 'progress',
    done: 0,
    total: 0,
    gamesRun: 0,
    elapsedSeconds: 0,
    label: request.roundKind === 'pairs' ? 'finding nonland + land pairs to cut…' : 'finding cards to cut…',
  });
  const planned = (await runner.submit(
    {
      kind: 'trim-plan',
      context,
      gamesPerCandidate: request.gamesPerCandidate,
      round: request.round,
      roundKind: request.roundKind,
      targetSize: request.targetSize,
      ...(request.baseLandRatio ? { baseLandRatio: request.baseLandRatio } : {}),
    },
    () => {},
  )) as TrimPlanResult;
  const round = planned.round;

  const tally = new ProgressTally(estimatePlannedGames(round.plan), sink, progressIntervalSeconds);
  const { outcome, variantGamesPlayed, variantGamesSkipped } = await drivePooledSearch(
    round.plan,
    context,
    runner,
    tally,
  );
  const elapsedSeconds = nowSeconds() - startedAt;
  const baseGamesPlayed = outcome.baseSlotsPlayed;

  const report = finishTrimRound({
    round,
    outcome,
    usage: {
      baseGamesPlayed,
      variantGamesPlayed,
      variantGamesSkipped,
      totalGamesPlayed: baseGamesPlayed + variantGamesPlayed,
      // `finishTrimRound` overwrites this with the trim's own reason (a cut can
      // never be skipped); what is passed here is never read.
      identicalGameSkipEnabled: false,
    },
    elapsedSeconds,
    workersUsed: runner.workerCount,
  });

  tally.setTotal(tally.gamesDone);
  tally.emit(`${report.candidatesEvaluated} removals · ${workersLabel(runner.workerCount)}`, true);
  return { kind: 'trim', result: report, pilotId: request.pilotId };
}

const EMPTY_TABLE: PairedTable = Object.freeze({
  bothWon: 0,
  baseOnly: 0,
  variantOnly: 0,
  neither: 0,
});

/** Forget an arm the search dropped, so its partial games cannot be reported. */
function dropFailed(
  tables: ReadonlyMap<string, PairedTable>,
  failures: ReadonlyMap<string, string>,
): ReadonlyMap<string, PairedTable> {
  if (failures.size === 0) return tables;
  const kept = new Map(tables);
  for (const key of failures.keys()) kept.delete(key);
  return kept;
}

/**
 * Estimate the games a search will play, so the bar and the ETA have a
 * denominator.
 *
 * It is genuinely an estimate and the code says so. Each wave plays one base game
 * per new slot plus one variant game per surviving arm per new slot; the field
 * shrinks to each wave's `survivorTarget`. The identical-game skip then answers
 * some variant games for free, so the real total lands BELOW this — which is the
 * right direction to be wrong in, and the total is revised every round and settled
 * exactly when the run ends.
 */
function estimatePlannedGames(
  plan: SuggestionRunPlan,
  gamesSoFar = 0,
  nextRound?: AdaptiveRound,
): number {
  let arms = nextRound?.arms.length ?? plan.roster.length;
  const fromWave = nextRound?.wave ?? 1;
  let previous = plan.waves[fromWave - 2]?.cumulativeGames ?? 0;
  let games = gamesSoFar;
  for (const spec of plan.waves.slice(fromWave - 1)) {
    const newSlots = Math.max(0, spec.cumulativeGames - previous);
    games += newSlots * (arms + 1); // one variant game per arm, one shared base game
    previous = spec.cumulativeGames;
    arms = Math.min(arms, spec.survivorTarget);
  }
  return games;
}

// --- §3.175 manabase experiments ---------------------------------------------------

/**
 * THE POOLED DRIVER OF A MANABASE SWEEP — `runSuggest`'s round loop, with the
 * three watched job kinds and the readings folded in beside the tallies.
 *
 * The family is planned on a worker (the pool lives there), the sim's ladder
 * decides who survives each round, and each round is the same two-phase,
 * barrier-separated shape a suggestions round is: the shared base games for the
 * new slots (played under the reliability watch, so each record carries its
 * reading), then every surviving variant's games over those slots. What comes
 * back per slot — who won, and what the watch saw — is kept by CANDIDATE KEY and
 * ABSOLUTE SLOT, so arrival order cannot reach the report. At the end
 * `finishManabaseRun` does what it does for the inline driver: Holm over the
 * family, verdicts re-decided, and the paired reliability per variant.
 */
export async function runManabase(
  request: ManabaseRequest,
  runner: ShardRunner,
  sink: ProgressSink,
  progressIntervalSeconds: number,
): Promise<SimResultPayload> {
  const opponentNames = opponentsFor(request);
  const context = contextFor(request, opponentNames);
  const startedAt = nowSeconds();
  runner.warmUp?.();

  sink({ type: 'progress', done: 0, total: 0, gamesRun: 0, elapsedSeconds: 0, label: 'enumerating manabases…' });
  const planned = (await runner.submit(
    {
      kind: 'manabase-plan',
      context,
      gamesPerVariant: request.gamesPerVariant,
      sweeps: request.sweeps,
      radius: request.radius,
      ...(request.families ? { families: request.families } : {}),
    },
    () => {},
  )) as ManabasePlanResult;
  const plan = planned.plan;
  if (plan.roster.length === 0) {
    throw new Error(
      plan.manabase.skipped.length > 0
        ? `no manabase variant can be built for this deck: ${plan.manabase.skipped.map((s) => `${s.label} — ${s.reason}`).join('; ')}`
        : 'no manabase variant to test — turn a sweep on.',
    );
  }

  const tally = new ProgressTally(estimatePlannedGames(plan), sink, progressIntervalSeconds);
  const baseRecords = new Map<number, PairedBaseRecord>();
  let armTables: ReadonlyMap<string, PairedTable> = new Map();
  const armSlots = new Map<string, boolean[]>();
  /** The watch's reading per arm per ABSOLUTE slot — the reliability half of the report. */
  const armObserved = new Map<string, (PairedGameObservation | null)[]>();
  const failures = new Map<string, string>();
  let variantGamesPlayed = 0;
  let variantGamesSkipped = 0;

  const driver = driveAdaptiveSearch(plan);
  let step = driver.next();
  let label = `round 1 of ${plan.waves.length} · ${workersLabel(runner.workerCount)}`;
  tally.emit(label, true);

  while (!step.done) {
    const round = step.value;
    const live = round.arms.filter((arm) => !failures.has(arm.candidate.key));
    label =
      `round ${round.wave} of ${plan.waves.length} · ${live.length} ` +
      `${live.length === 1 ? 'manabase' : 'manabases'} · ${round.cumulativeGames} games each · ` +
      workersLabel(runner.workerCount);
    tally.emit(label, true);

    // --- phase A: the shared, WATCHED base arm for the slots this round adds ---
    const baseJobs = planManabaseBaseSlotShards(context, plan.runSeed, round.baseSlotStart, round.baseSlotEnd, runner.workerCount);
    const baseResults = (await Promise.all(
      baseJobs.map(async (job) => {
        const result = await runner.submit(job, (games) => {
          tally.add(games);
          tally.emit(label);
        });
        tally.emit(label);
        return result as ManabaseBaseSlotShardResult;
      }),
    )) as ManabaseBaseSlotShardResult[];
    for (const result of baseResults) {
      result.records.forEach((record, i) => baseRecords.set(result.slotStart + i, record));
    }

    // --- barrier --- phase B needs every base record (and reading) above.
    const sliceJobs = planManabaseVariantSliceShards(
      context,
      plan.runSeed,
      live.map((arm) => {
        const variant = variantForCandidateKey(arm.candidate.key, plan.manabase.variants);
        if (!variant) throw new Error(`the plan names no variant for candidate "${arm.candidate.key}"`);
        return { candidateKey: arm.candidate.key, variant, fromSlot: arm.fromGames, toSlot: arm.toGames };
      }),
      runner.workerCount,
      (slot) => baseRecords.get(slot) as PairedBaseRecord,
    );

    const settled = await Promise.all(
      sliceJobs.map(async (job) => {
        try {
          const result = (await runner.submit(job, (games) => {
            tally.add(games);
            tally.emit(label);
          })) as ManabaseVariantSliceShardResult;
          tally.emit(label);
          return result;
        } catch (err) {
          if (isCancellation(err)) throw err;
          // One unbuildable variant drops that ARM, never the run.
          if (!failures.has(job.candidateKey)) {
            failures.set(job.candidateKey, err instanceof Error ? err.message : String(err));
          }
          return null;
        }
      }),
    );

    const usable = settled.filter(
      (result): result is ManabaseVariantSliceShardResult => result !== null && !failures.has(result.candidateKey),
    );
    for (const slice of usable) {
      variantGamesPlayed += slice.variantGamesPlayed;
      variantGamesSkipped += slice.variantGamesSkipped;
      let slots = armSlots.get(slice.candidateKey);
      if (!slots) {
        slots = [];
        armSlots.set(slice.candidateKey, slots);
      }
      let observed = armObserved.get(slice.candidateKey);
      if (!observed) {
        observed = [];
        armObserved.set(slice.candidateKey, observed);
      }
      // Sparse writes BY ABSOLUTE INDEX, so slices in any order compose into the
      // arrays a locally-played arm would have built.
      for (let i = 0; i < slice.variantWonBySlot.length; i++) {
        slots[slice.slotStart + i] = slice.variantWonBySlot[i] as boolean;
        observed[slice.slotStart + i] = slice.observedBySlot[i] ?? null;
      }
    }
    for (const key of failures.keys()) {
      armSlots.delete(key);
      armObserved.delete(key);
    }
    armTables = mergeVariantSlices(dropFailed(armTables, failures), usable);

    step = driver.next({
      arms: round.arms.map((arm) => {
        const failure = failures.get(arm.candidate.key);
        if (failure !== undefined) {
          return { key: arm.candidate.key, gamesPlayed: 0, paired: EMPTY_TABLE, failure };
        }
        const slots = armSlots.get(arm.candidate.key);
        return {
          key: arm.candidate.key,
          gamesPlayed: arm.toGames,
          paired: armTables.get(arm.candidate.key) ?? EMPTY_TABLE,
          ...(slots ? { variantWonBySlot: slots } : {}),
        };
      }),
    });
    tally.setTotal(estimatePlannedGames(plan, tally.gamesDone, step.done ? undefined : step.value));
  }

  const outcome = step.value;
  const elapsedSeconds = nowSeconds() - startedAt;
  const baseGamesPlayed = outcome.baseSlotsPlayed;
  const baseObserved: (PairedGameObservation | null)[] = [];
  for (let slot = 0; slot < baseGamesPlayed; slot++) baseObserved.push(baseRecords.get(slot)?.observed ?? null);

  const report = finishManabaseRun({
    plan,
    search: {
      outcomes: outcome.arms.map((arm) => ({
        candidate: arm.candidate,
        evaluation: summarizePairedSwap({
          baseDeckName: plan.baseDeckName,
          variantDeckName: arm.candidate.variantDeckName,
          swap: { out: arm.candidate.outId, in: arm.candidate.inId },
          outName: arm.candidate.outName,
          inName: arm.candidate.inName,
          paired: arm.paired,
          scope: DEFAULT_SWAP_SCOPE,
          copiesSwapped: arm.candidate.copiesSwapped,
          stats: statsOf(request),
        }),
        gamesPlayed: arm.gamesPlayed,
        ...(arm.elimination ? { elimination: arm.elimination } : {}),
      })),
      waves: outcome.waves,
      usage: {
        baseGamesPlayed,
        variantGamesPlayed,
        variantGamesSkipped,
        totalGamesPlayed: baseGamesPlayed + variantGamesPlayed,
        identicalGameSkipEnabled: planned.identicalGameSkipEnabled,
        ...(planned.identicalGameSkipDisabledReason
          ? { identicalGameSkipDisabledReason: planned.identicalGameSkipDisabledReason }
          : {}),
      },
      failures: outcome.failures,
      fixedSchemeGames: outcome.fixedSchemeGames,
    },
    baseObserved,
    variantObserved: armObserved,
    elapsedSeconds,
    workersUsed: runner.workerCount,
    stats: statsOf(request),
  });

  tally.setTotal(tally.gamesDone);
  tally.emit(`${report.results.length} manabases · ${workersLabel(runner.workerCount)}`, true);
  return { kind: 'manabase', result: report, pilotId: request.pilotId };
}

// --- single-game replay --------------------------------------------------------

export async function runMatchRequest(
  request: MatchRequest,
  runner: ShardRunner,
  sink: ProgressSink,
): Promise<SimResultPayload> {
  const context = contextFor(request, [request.opponentName]);
  sink({
    type: 'progress',
    done: 0,
    total: 1,
    gamesRun: 0,
    elapsedSeconds: 0,
    label: `playing ${request.hero.name} vs ${request.opponentName}…`,
  });
  const result = (await runner.submit(
    { kind: 'match', context, opponentName: request.opponentName, maxEvents: request.maxEvents },
    () => {},
  )) as MatchJobResult;
  return { kind: 'match', result: result.trace, pilotId: request.pilotId };
}

// --- dispatch ------------------------------------------------------------------


// --- §3.177 the joint manabase + spell search -----------------------------------------

/**
 * THE POOLED DRIVER OF ONE JOINT PHASE — `runManabase`'s round loop, over a
 * joint phase's family instead of a manabase sweep's.
 *
 * Only the PLAN differs: the family is enumerated by `planJointPhase` on a
 * worker, and from there the work is identical — the shared base games for the
 * new slots under the reliability watch, then every surviving move's games over
 * those slots — so it runs on the SAME two shard kinds (`shard-protocol.ts` says
 * why that reuse is right rather than merely convenient). `finishJointPhase`
 * then does what the inline driver does: Holm over the phase's family, verdicts
 * re-decided, the readings joined, and each land count rolled up to its best
 * partner.
 *
 * A PHASE at a time, never a whole descent: the panel owns the search state, so
 * the budget is spent where a person can see it and the run can be stopped or
 * resumed between any two phases.
 */
export async function runJointPhaseRun(
  request: JointPhaseRequest,
  runner: ShardRunner,
  sink: ProgressSink,
  progressIntervalSeconds: number,
): Promise<SimResultPayload> {
  const opponentNames = opponentsFor(request);
  const context = contextFor(request, opponentNames);
  const startedAt = nowSeconds();
  runner.warmUp?.();

  const phaseLabel = JOINT_PHASES.find((p) => p.id === request.phase)?.label ?? request.phase;
  const lower = phaseLabel.toLowerCase();
  sink({ type: 'progress', done: 0, total: 0, gamesRun: 0, elapsedSeconds: 0, label: `enumerating ${lower} moves…` });
  const planned = (await runner.submit(
    {
      kind: 'joint-plan',
      context,
      phase: request.phase,
      round: request.round,
      gamesPerMove: request.gamesPerMove,
      partnerRule: request.partnerRule,
      countRadius: request.radius,
      partnersPerCountStep: request.partnersPerCountStep,
      ...(request.families ? { families: request.families } : {}),
    },
    () => {},
  )) as JointPlanResult;
  const plan = planned.plan;
  if (plan.roster.length === 0) {
    throw new Error(
      plan.joint.skipped.length > 0
        ? `no ${lower} move can be built for this deck: ${plan.joint.skipped.map((sk) => `${sk.label} — ${sk.reason}`).join('; ')}`
        : `no ${lower} move to try for this deck.`,
    );
  }

  const tally = new ProgressTally(estimatePlannedGames(plan), sink, progressIntervalSeconds);
  const baseRecords = new Map<number, PairedBaseRecord>();
  let armTables: ReadonlyMap<string, PairedTable> = new Map();
  const armSlots = new Map<string, boolean[]>();
  const armObserved = new Map<string, (PairedGameObservation | null)[]>();
  const failures = new Map<string, string>();
  let variantGamesPlayed = 0;
  let variantGamesSkipped = 0;

  const driver = driveAdaptiveSearch(plan);
  let step = driver.next();
  let label = `${phaseLabel} · round 1 of ${plan.waves.length} · ${workersLabel(runner.workerCount)}`;
  tally.emit(label, true);

  while (!step.done) {
    const round = step.value;
    const live = round.arms.filter((arm) => !failures.has(arm.candidate.key));
    label =
      `${phaseLabel} · round ${round.wave} of ${plan.waves.length} · ${live.length} ` +
      `${live.length === 1 ? 'move' : 'moves'} · ${round.cumulativeGames} games each · ` +
      workersLabel(runner.workerCount);
    tally.emit(label, true);

    const baseJobs = planManabaseBaseSlotShards(context, plan.runSeed, round.baseSlotStart, round.baseSlotEnd, runner.workerCount);
    const baseResults = (await Promise.all(
      baseJobs.map(async (job) => {
        const result = await runner.submit(job, (games) => {
          tally.add(games);
          tally.emit(label);
        });
        tally.emit(label);
        return result as ManabaseBaseSlotShardResult;
      }),
    )) as ManabaseBaseSlotShardResult[];
    for (const result of baseResults) {
      result.records.forEach((record, i) => baseRecords.set(result.slotStart + i, record));
    }

    // --- barrier --- every move's slice needs the base records above.
    const sliceJobs = planManabaseVariantSliceShards(
      context,
      plan.runSeed,
      live.map((arm) => {
        const move = moveForCandidateKey(arm.candidate.key, plan.joint.moves);
        if (!move) throw new Error(`the plan names no joint move for candidate "${arm.candidate.key}"`);
        return { candidateKey: arm.candidate.key, variant: move, fromSlot: arm.fromGames, toSlot: arm.toGames };
      }),
      runner.workerCount,
      (slot) => baseRecords.get(slot) as PairedBaseRecord,
    );

    const settled = await Promise.all(
      sliceJobs.map(async (job) => {
        try {
          const result = (await runner.submit(job, (games) => {
            tally.add(games);
            tally.emit(label);
          })) as ManabaseVariantSliceShardResult;
          tally.emit(label);
          return result;
        } catch (err) {
          if (isCancellation(err)) throw err;
          // One unbuildable move drops that ARM, never the phase.
          if (!failures.has(job.candidateKey)) {
            failures.set(job.candidateKey, err instanceof Error ? err.message : String(err));
          }
          return null;
        }
      }),
    );

    const usable = settled.filter(
      (result): result is ManabaseVariantSliceShardResult => result !== null && !failures.has(result.candidateKey),
    );
    for (const slice of usable) {
      variantGamesPlayed += slice.variantGamesPlayed;
      variantGamesSkipped += slice.variantGamesSkipped;
      let slots = armSlots.get(slice.candidateKey);
      if (!slots) {
        slots = [];
        armSlots.set(slice.candidateKey, slots);
      }
      let observed = armObserved.get(slice.candidateKey);
      if (!observed) {
        observed = [];
        armObserved.set(slice.candidateKey, observed);
      }
      // Sparse writes BY ABSOLUTE INDEX, so slices in any order compose into the
      // arrays a locally-played arm would have built.
      for (let i = 0; i < slice.variantWonBySlot.length; i++) {
        slots[slice.slotStart + i] = slice.variantWonBySlot[i] as boolean;
        observed[slice.slotStart + i] = slice.observedBySlot[i] ?? null;
      }
    }
    for (const key of failures.keys()) {
      armSlots.delete(key);
      armObserved.delete(key);
    }
    armTables = mergeVariantSlices(dropFailed(armTables, failures), usable);

    step = driver.next({
      arms: round.arms.map((arm) => {
        const failure = failures.get(arm.candidate.key);
        if (failure !== undefined) {
          return { key: arm.candidate.key, gamesPlayed: 0, paired: EMPTY_TABLE, failure };
        }
        const slots = armSlots.get(arm.candidate.key);
        return {
          key: arm.candidate.key,
          gamesPlayed: arm.toGames,
          paired: armTables.get(arm.candidate.key) ?? EMPTY_TABLE,
          ...(slots ? { variantWonBySlot: slots } : {}),
        };
      }),
    });
    tally.setTotal(estimatePlannedGames(plan, tally.gamesDone, step.done ? undefined : step.value));
  }

  const outcome = step.value;
  const elapsedSeconds = nowSeconds() - startedAt;
  const baseGamesPlayed = outcome.baseSlotsPlayed;
  const baseObserved: (PairedGameObservation | null)[] = [];
  for (let slot = 0; slot < baseGamesPlayed; slot++) baseObserved.push(baseRecords.get(slot)?.observed ?? null);

  const report = finishJointPhase({
    plan,
    search: {
      outcomes: outcome.arms.map((arm) => ({
        candidate: arm.candidate,
        evaluation: summarizePairedSwap({
          baseDeckName: plan.baseDeckName,
          variantDeckName: arm.candidate.variantDeckName,
          swap: { out: arm.candidate.outId, in: arm.candidate.inId },
          outName: arm.candidate.outName,
          inName: arm.candidate.inName,
          paired: arm.paired,
          scope: DEFAULT_SWAP_SCOPE,
          copiesSwapped: arm.candidate.copiesSwapped,
          stats: statsOf(request),
        }),
        gamesPlayed: arm.gamesPlayed,
        ...(arm.elimination ? { elimination: arm.elimination } : {}),
      })),
      waves: outcome.waves,
      usage: {
        baseGamesPlayed,
        variantGamesPlayed,
        variantGamesSkipped,
        totalGamesPlayed: baseGamesPlayed + variantGamesPlayed,
        identicalGameSkipEnabled: planned.identicalGameSkipEnabled,
        ...(planned.identicalGameSkipDisabledReason
          ? { identicalGameSkipDisabledReason: planned.identicalGameSkipDisabledReason }
          : {}),
      },
      failures: outcome.failures,
      fixedSchemeGames: outcome.fixedSchemeGames,
    },
    baseObserved,
    moveObserved: armObserved,
    elapsedSeconds,
    workersUsed: runner.workerCount,
    stats: statsOf(request),
  });

  tally.setTotal(tally.gamesDone);
  tally.emit(`${phaseLabel} · ${report.rows.length} moves · ${workersLabel(runner.workerCount)}`, true);
  return { kind: 'joint-phase', result: report, pilotId: request.pilotId };
}


/** Run any Lab request on a shard runner. The one entry point the hook calls. */
export async function runSimRequest(
  request:
    | GauntletRequest
    | SwapRequest
    | SuggestRequest
    | MatchRequest
    | TrimRequest
    | ManabaseRequest
    | JointPhaseRequest,
  runner: ShardRunner,
  sink: ProgressSink,
  progressIntervalSeconds: number,
): Promise<SimResultPayload> {
  switch (request.kind) {
    case 'gauntlet':
      return runGauntlet(request, runner, sink, progressIntervalSeconds);
    case 'swap':
      return runSwap(request, runner, sink, progressIntervalSeconds);
    case 'suggest':
      return runSuggest(request, runner, sink, progressIntervalSeconds);
    case 'match':
      return runMatchRequest(request, runner, sink);
    case 'trim':
      return runTrim(request, runner, sink, progressIntervalSeconds);
    case 'manabase':
      return runManabase(request, runner, sink, progressIntervalSeconds);
    case 'joint-phase':
      return runJointPhaseRun(request, runner, sink, progressIntervalSeconds);
  }
}

/** Re-exported so tests and the pool share one shard-result type surface. */
export type { ShardResult, ShardJob };
