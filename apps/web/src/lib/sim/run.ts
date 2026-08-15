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
import type {
  GauntletRequest,
  MatchRequest,
  SimProgress,
  SimResultPayload,
  SuggestRequest,
  SwapRequest,
} from '../sim-protocol.js';
import {
  DEFAULT_ADAPTIVE_CONFIG,
  DEFAULT_EXPLORATION_WEIGHTS,
  DEFAULT_STATS_CONFIG,
  DEFAULT_SWAP_SCOPE,
  driveAdaptiveSearch,
  finishSuggestionRun,
  summarizePairedSwap,
  type AdaptiveRound,
  type PairedBaseRecord,
  type PairedTable,
  type SkippedCandidate,
  type SuggestionRunPlan,
} from '@jonny-boi/sim';
import { resolveOpponentNames } from './opponents.js';
import {
  planBaseSlotShards,
  planGauntletShards,
  planPairedShards,
  planVariantSliceShards,
  totalGauntletGames,
  totalPairedGames,
} from './plan.js';
import { mergeGauntlet, mergePairedEvaluation, mergeVariantSlices } from './merge.js';
import type {
  BaseSlotShardResult,
  GauntletShardResult,
  MatchJobResult,
  PairedShardResult,
  ShardContext,
  ShardJob,
  ShardResult,
  SuggestPlanResult,
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

/** Build the shard context shared by every job in a run. */
function contextFor(
  hero: GauntletRequest['hero'],
  opponentNames: readonly string[],
  seed: number,
): ShardContext {
  return { hero, opponentNames, seed };
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
  const context = contextFor(request.hero, opponentNames, request.seed);
  const jobs = planGauntletShards(context, request.gamesPerOpponent, runner.workerCount);
  const total = totalGauntletGames(jobs);

  const tally = new ProgressTally(total, sink, progressIntervalSeconds);
  const label = `${opponentNames.length === 1 ? `vs ${opponentNames[0]}` : `${opponentNames.length} opponents`} · ${workersLabel(runner.workerCount)}`;
  // Say we are alive BEFORE the first (potentially multi-second) game.
  tally.emit(label, true);

  const results = await Promise.all(
    jobs.map(async (job) => {
      const result = (await runner.submit(job, (games) => {
        tally.add(games);
        tally.emit(label);
      })) as GauntletShardResult;
      tally.emit(label);
      return result;
    }),
  );

  const elapsedSeconds = tally.elapsedSeconds;
  const merged = mergeGauntlet(results);
  tally.emit(label, true);
  return {
    kind: 'gauntlet',
    result: merged,
    gamesPerSecond: elapsedSeconds > 0 ? merged.totalGames / elapsedSeconds : 0,
  };
}

// --- A/B swap ------------------------------------------------------------------

export async function runSwap(
  request: SwapRequest,
  runner: ShardRunner,
  sink: ProgressSink,
  progressIntervalSeconds: number,
): Promise<SimResultPayload> {
  const opponentNames = opponentsFor(request);
  const context = contextFor(request.hero, opponentNames, request.seed);
  const jobs = planPairedShards(
    context,
    {
      outCardId: request.outCardId,
      inCardId: request.inCardId,
      // Carried from the user's choice in the A/B panel. Dropping it here would
      // not fail — it would quietly answer the OTHER question.
      swapScope: request.swapScope,
    },
    request.gamesPerOpponent,
    runner.workerCount,
    request.seed,
    null,
  );
  const total = totalPairedGames(jobs);

  const tally = new ProgressTally(total, sink, progressIntervalSeconds);
  const label = `paired A/B games · ${workersLabel(runner.workerCount)}`;
  tally.emit(label, true);

  const results = await Promise.all(
    jobs.map(async (job) => {
      const result = (await runner.submit(job, (games) => {
        tally.add(games);
        tally.emit(label);
      })) as PairedShardResult;
      tally.emit(label);
      return result;
    }),
  );

  const elapsedSeconds = tally.elapsedSeconds;
  const evaluation = mergePairedEvaluation(results);
  tally.emit(label, true);
  const GAMES_PER_PAIR = 2;
  return {
    kind: 'swap',
    result: evaluation,
    gamesPerSecond:
      elapsedSeconds > 0 ? (evaluation.nGames * GAMES_PER_PAIR) / elapsedSeconds : 0,
  };
}

// --- suggestions ---------------------------------------------------------------

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
  const context = contextFor(request.hero, opponentNames, request.seed);
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
    },
    () => {},
  )) as SuggestPlanResult;
  const plan = planned.plan;

  const tally = new ProgressTally(estimatePlannedGames(plan), sink, progressIntervalSeconds);

  // Live state the rounds accumulate. Every one of these is either an integer sum
  // or keyed by the candidate's stable key, so none of them can carry arrival
  // order into the result.
  const baseRecords = new Map<number, PairedBaseRecord>();
  let armTables: ReadonlyMap<string, PairedTable> = new Map();
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
    }
    armTables = mergeVariantSlices(dropFailed(armTables, failures), usable);

    step = driver.next({
      arms: round.arms.map((arm) => {
        const failure = failures.get(arm.candidate.key);
        if (failure !== undefined) {
          return { key: arm.candidate.key, gamesPlayed: 0, paired: EMPTY_TABLE, failure };
        }
        return {
          key: arm.candidate.key,
          gamesPlayed: arm.toGames,
          paired: armTables.get(arm.candidate.key) ?? EMPTY_TABLE,
        };
      }),
    });
    tally.setTotal(estimatePlannedGames(plan, tally.gamesDone, step.done ? undefined : step.value));
  }

  const outcome = step.value;
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
    stats: DEFAULT_STATS_CONFIG,
    workersUsed: runner.workerCount,
  });

  // The estimate has served its purpose; end on the number actually played.
  tally.setTotal(tally.gamesDone);
  tally.emit(`${report.candidatesEvaluated} candidates · ${workersLabel(runner.workerCount)}`, true);
  return { kind: 'suggest', result: report };
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

// --- single-game replay --------------------------------------------------------

export async function runMatchRequest(
  request: MatchRequest,
  runner: ShardRunner,
  sink: ProgressSink,
): Promise<SimResultPayload> {
  const context = contextFor(request.hero, [request.opponentName], request.seed);
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
  return { kind: 'match', result: result.trace };
}

// --- dispatch ------------------------------------------------------------------

/** Run any Lab request on a shard runner. The one entry point the hook calls. */
export async function runSimRequest(
  request: GauntletRequest | SwapRequest | SuggestRequest | MatchRequest,
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
  }
}

/** Re-exported so tests and the pool share one shard-result type surface. */
export type { ShardResult, ShardJob };
