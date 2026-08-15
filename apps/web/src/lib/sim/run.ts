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
import { resolveOpponentNames } from './opponents.js';
import {
  planGauntletShards,
  planPairedShards,
  planSuggestShards,
  totalGauntletGames,
  totalPairedGames,
} from './plan.js';
import { mergeGauntlet, mergePairedEvaluation, mergeSuggestions } from './merge.js';
import type {
  GauntletShardResult,
  MatchJobResult,
  PairedShardJob,
  PairedShardResult,
  ShardContext,
  ShardJob,
  ShardResult,
  SkippedCandidateInfo,
  SuggestPlanResult,
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
    private readonly total: number,
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

export async function runSuggest(
  request: SuggestRequest,
  runner: ShardRunner,
  sink: ProgressSink,
  progressIntervalSeconds: number,
): Promise<SimResultPayload> {
  const opponentNames = opponentsFor(request);
  const context = contextFor(request.hero, opponentNames, request.seed);
  const startedAt = nowSeconds();

  // PHASE 1 — enumerate + pre-rank candidates. Pure CPU over the whole pool, so
  // it runs on a worker; doing it on the main thread would freeze the UI before
  // the first game is played.
  sink({
    type: 'progress',
    done: 0,
    total: 0,
    gamesRun: 0,
    elapsedSeconds: 0,
    label: 'finding candidate swaps…',
  });
  const plan = (await runner.submit({ kind: 'suggest-plan', context, maxCandidates: request.maxCandidates }, () => {})) as SuggestPlanResult;

  const skipped: SkippedCandidateInfo[] = [...plan.skipped];
  if (plan.candidates.length === 0) {
    return {
      kind: 'suggest',
      result: mergeSuggestions({
        baseDeckName: plan.baseDeckName,
        candidates: [],
        shards: [],
        skipped,
        candidatesGenerated: plan.candidatesGenerated,
        cappedByBudget: plan.cappedByBudget,
        elapsedSeconds: nowSeconds() - startedAt,
      }),
    };
  }

  // PHASE 2 — every candidate's paired gauntlet, all shards in ONE queue so the
  // pool stays saturated even when there are fewer candidates than cores.
  const jobs = planSuggestShards(
    context,
    plan.candidates,
    request.gamesPerCandidate,
    runner.workerCount,
  );
  const total = totalPairedGames(jobs);
  const tally = new ProgressTally(total, sink, progressIntervalSeconds);

  // Candidate completion is what the user actually wants to read, so we count
  // shards per candidate and only call one finished when its last shard lands.
  const shardsPerCandidate = new Map<number, number>();
  for (const job of jobs) {
    const index = job.candidateIndex ?? 0;
    shardsPerCandidate.set(index, (shardsPerCandidate.get(index) ?? 0) + 1);
  }
  const doneShardsPerCandidate = new Map<number, number>();
  let candidatesDone = 0;
  /** Candidates dropped mid-run; their partial shards are discarded wholesale. */
  const failedCandidates = new Set<number>();

  const label = (): string =>
    `${candidatesDone}/${plan.candidates.length} candidates · ${workersLabel(runner.workerCount)}`;
  tally.emit(label(), true);

  const settled = await Promise.all(
    jobs.map(async (job: PairedShardJob) => {
      const index = job.candidateIndex ?? 0;
      try {
        const result = (await runner.submit(job, (games) => {
          tally.add(games);
          tally.emit(label());
        })) as PairedShardResult;
        const done = (doneShardsPerCandidate.get(index) ?? 0) + 1;
        doneShardsPerCandidate.set(index, done);
        if (done === shardsPerCandidate.get(index)) candidatesDone++;
        tally.emit(label());
        return result;
      } catch (err) {
        if (isCancellation(err)) throw err;
        // One bad candidate must not throw away a run that may have taken
        // twenty minutes. Drop it and record WHY, so the report is honest about
        // its coverage rather than quietly one candidate short.
        if (!failedCandidates.has(index)) {
          failedCandidates.add(index);
          const candidate = plan.candidates[index];
          skipped.push({
            outName: candidate?.outName ?? 'unknown',
            inName: candidate?.inName ?? 'unknown',
            reason: 'illegal',
            details: [err instanceof Error ? err.message : String(err)],
          });
        }
        return null;
      }
    }),
  );

  const shards = settled.filter(
    (r): r is PairedShardResult => r !== null && !failedCandidates.has(r.candidateIndex ?? -1),
  );

  const report = mergeSuggestions({
    baseDeckName: plan.baseDeckName,
    candidates: plan.candidates,
    shards,
    skipped,
    candidatesGenerated: plan.candidatesGenerated,
    cappedByBudget: plan.cappedByBudget,
    elapsedSeconds: nowSeconds() - startedAt,
  });
  tally.emit(label(), true);
  return { kind: 'suggest', result: report };
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
