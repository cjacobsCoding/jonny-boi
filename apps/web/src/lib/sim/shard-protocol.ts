/**
 * The **shard protocol** — the unit of work the Lab hands to one sim worker.
 *
 * `sim-protocol.ts` describes what the USER asked for (a gauntlet, a swap, a
 * suggestions search). This module describes how that request is cut into
 * independent pieces so N workers can run it at once, and what each piece sends
 * back. Both sides (the pool on the main thread, `sim.worker.ts` in the worker)
 * import these shapes, so the contract has exactly one definition.
 *
 * Two invariants make the whole thing safe:
 *
 * 1. **A shard is identified by its POSITION in the run, never by which worker
 *    ran it.** Every shard carries the deterministic indices (`opponentIndex`,
 *    `gameStart`, `candidateIndex`) it covers, and every seed inside it is
 *    derived from the run's base seed plus those indices — exactly as the
 *    single-threaded loop derives them. Nothing is seeded from arrival order,
 *    a worker id, or a counter.
 * 2. **Every result carries its own canonical position back.** The merge step
 *    re-sorts results into run order before aggregating, so a run's output is
 *    the same whether shards finish in order, backwards, or interleaved.
 *
 * All shapes are plain data (structured-clone safe): no class instances, no
 * functions, no `Map`/`Set`.
 */
import type { CardDefinition } from '@jonny-boi/core';
import type { SimDeckPayload } from '../sim-protocol.js';
import type { MatchTrace } from '../replay-types.js';

/**
 * Everything a shard needs to rebuild the exact sim context the run uses: the
 * hero deck, the resolved gauntlet opponents **in canonical order** (the index a
 * shard quotes is an index into THIS array), and the run's base seed.
 *
 * The opponent list is resolved on the main thread (`opponents.ts`) so the plan
 * and every worker agree on the ordering — an index means nothing otherwise.
 */
export interface ShardContext {
  readonly hero: SimDeckPayload;
  readonly opponentNames: readonly string[];
  readonly seed: number;
}

/** A half-open range of game indices `[gameStart, gameEnd)` within one matchup. */
export interface GameRange {
  readonly gameStart: number;
  readonly gameEnd: number;
}

/** Play a slice of the hero-vs-opponent[i] matchup. */
export interface GauntletShardJob extends GameRange {
  readonly kind: 'gauntlet-shard';
  readonly context: ShardContext;
  readonly opponentIndex: number;
}

/** The aggregate of one gauntlet shard, tagged with where it sits in the run. */
export interface GauntletShardResult extends GameRange {
  readonly kind: 'gauntlet-shard';
  readonly opponentIndex: number;
  readonly heroName: string;
  readonly opponentName: string;
  readonly games: number;
  readonly winsA: number;
  readonly winsB: number;
  readonly draws: number;
  /** The per-game seeds actually used, in game order (for paired replay/inspection). */
  readonly gameSeeds: readonly number[];
}

/**
 * Play a slice of the PAIRED base-vs-variant games against opponent[i].
 *
 * This is the unit behind both the A/B swap test and one suggestion candidate:
 * each game index plays the base deck and the variant deck under the identical
 * seed and on-the-play assignment (common random numbers), which is what makes
 * the McNemar verdict trustworthy. `candidateIndex` is `null` for a standalone
 * A/B run and the candidate's canonical position during a suggestions run.
 */
export interface PairedShardJob extends GameRange {
  readonly kind: 'paired-shard';
  readonly context: ShardContext;
  readonly opponentIndex: number;
  readonly outCardId: string;
  readonly inCardId: string;
  /**
   * The base seed for THIS swap's paired run. For a standalone A/B test it is
   * the run seed; for a suggestion candidate it is the candidate's derived seed,
   * computed from the run seed and the candidate's stable key.
   */
  readonly swapSeed: number;
  readonly candidateIndex: number | null;
}

/** The paired 2x2 tallies plus win counts for one slice of a paired run. */
export interface PairedShardResult extends GameRange {
  readonly kind: 'paired-shard';
  readonly opponentIndex: number;
  readonly candidateIndex: number | null;
  readonly baseDeckName: string;
  readonly variantDeckName: string;
  readonly outName: string;
  readonly inName: string;
  readonly outCardId: string;
  readonly inCardId: string;
  /** Paired games played in this slice. */
  readonly n: number;
  readonly baseWins: number;
  readonly variantWins: number;
  readonly bothWon: number;
  readonly baseOnly: number;
  readonly variantOnly: number;
  readonly neither: number;
}

/** A suggestion candidate as the plan phase resolved it (canonical order). */
export interface PlannedCandidate {
  readonly outId: string;
  readonly inId: string;
  readonly outName: string;
  readonly inName: string;
  /** Seed for this candidate's whole paired gauntlet (base seed + stable key). */
  readonly swapSeed: number;
}

/** A candidate generated but never simulated, with the honest reason. */
export interface SkippedCandidateInfo {
  readonly outName: string;
  readonly inName: string;
  readonly reason: 'illegal' | 'capped';
  readonly details: readonly string[];
}

/**
 * PHASE 1 of a suggestions run: enumerate + pre-rank candidates. This is pure
 * CPU over the whole card pool (no games), so it runs on a worker too — doing it
 * on the main thread would freeze the UI before the first game is even played.
 */
export interface SuggestPlanJob {
  readonly kind: 'suggest-plan';
  readonly context: ShardContext;
  readonly maxCandidates: number;
}

/** The candidate set a suggestions run will evaluate, plus honest coverage notes. */
export interface SuggestPlanResult {
  readonly kind: 'suggest-plan';
  readonly baseDeckName: string;
  /** Candidates to evaluate, in the canonical order ranks are resolved against. */
  readonly candidates: readonly PlannedCandidate[];
  readonly skipped: readonly SkippedCandidateInfo[];
  readonly candidatesGenerated: number;
  readonly cappedByBudget: boolean;
}

/** Play ONE game and record its full trace (the match-replay viewer). */
export interface MatchJob {
  readonly kind: 'match';
  readonly context: ShardContext;
  readonly opponentName: string;
  readonly maxEvents: number;
}

export interface MatchJobResult {
  readonly kind: 'match';
  readonly trace: MatchTrace;
}

/** Anything the pool can hand to a worker. */
export type ShardJob = GauntletShardJob | PairedShardJob | SuggestPlanJob | MatchJob;

/** Anything a worker can hand back on success. */
export type ShardResult =
  | GauntletShardResult
  | PairedShardResult
  | SuggestPlanResult
  | MatchJobResult;

/**
 * Main thread → worker, once per worker, before any job.
 *
 * The imported-card definitions travel here rather than on every job because a
 * single run dispatches hundreds of shards and these payloads are the compiled
 * definitions of a user's whole imported collection — structured-cloning them per
 * shard would cost more than the games. A worker builds its sim context from
 * these once and reuses it for every shard it is ever handed.
 */
export interface WorkerInitMessage {
  readonly type: 'init';
  /** Compiled definitions for cards outside the curated pool (deck import). */
  readonly importedCards: readonly CardDefinition[];
}

/** Main thread → worker. `id` correlates the reply. */
export interface WorkerJobMessage {
  readonly type: 'job';
  readonly id: number;
  readonly job: ShardJob;
}

/** Anything the pool sends a worker. */
export type MainToWorkerMessage = WorkerInitMessage | WorkerJobMessage;

/** Worker → main thread: games finished since the last tick (progress only). */
export interface WorkerProgressMessage {
  readonly type: 'shard-progress';
  readonly id: number;
  /** Games completed since this worker's previous tick for this job. */
  readonly gamesDelta: number;
}

export interface WorkerDoneMessage {
  readonly type: 'shard-done';
  readonly id: number;
  readonly result: ShardResult;
}

export interface WorkerErrorMessage {
  readonly type: 'shard-error';
  readonly id: number;
  readonly message: string;
  /**
   * True when the failure is inherent to the job (an illegal swap, an unknown
   * deck) rather than to the worker. Re-dispatching such a shard onto a fresh
   * worker would just fail again, so the pool doesn't retry it.
   */
  readonly permanent: boolean;
}

export type WorkerMessage = WorkerProgressMessage | WorkerDoneMessage | WorkerErrorMessage;
