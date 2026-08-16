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
import type {
  PairedBaseRecord,
  PairedTable,
  SuggestionHistory,
  SuggestionRunPlan,
  SwapScope,
} from '@jonny-boi/sim';
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
  /**
   * The pilot BOTH seats are played by, resolved from `@jonny-boi/ai`'s registry
   * in the worker.
   *
   * It belongs in the context — the part of a job that is identical across every
   * shard of a run — for the same reason the seed does: two shards playing the
   * same run with different pilots would merge two different experiments into one
   * win rate, and nothing downstream could tell.
   */
  readonly pilotId: string;
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
   * Replace one copy or the whole playset. Every shard of a swap carries the
   * SAME scope, because it decides which variant deck is built — two shards
   * disagreeing would silently average two different experiments. Omitted means
   * the sim's `DEFAULT_SWAP_SCOPE`, which is what the suggestion engine uses.
   */
  readonly swapScope?: SwapScope;
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
  /** The scope this slice actually played, so the merged verdict is self-describing. */
  readonly scope: SwapScope;
  /** How many copies actually moved — 1, or the out card's full count. */
  readonly copiesSwapped: number;
  /** Paired games played in this slice. */
  readonly n: number;
  readonly baseWins: number;
  readonly variantWins: number;
  readonly bothWon: number;
  readonly baseOnly: number;
  readonly variantOnly: number;
  readonly neither: number;
}

/**
 * PHASE 1 of a suggestions run: enumerate + pre-rank candidates, accept (or
 * reject) the caller's cross-run record, and plan the wave ladder.
 *
 * This is pure CPU over the whole card pool (no games), so it runs on a worker —
 * doing it on the main thread would freeze the UI before the first game is even
 * played, and the main thread does not build a card pool at all. What comes back
 * is the sim's own `SuggestionRunPlan`, which is deliberately plain JSON so the
 * main thread can schedule from it without the pool.
 */
export interface SuggestPlanJob {
  readonly kind: 'suggest-plan';
  readonly context: ShardContext;
  readonly maxCandidates: number;
  /** Depth a FINALIST reaches (not what every candidate gets — it is adaptive). */
  readonly gamesPerCandidate: number;
  /** The record a previous run on this deck returned, if the UI kept one. */
  readonly history?: SuggestionHistory;
}

/** The plan a suggestions run will execute, straight from the sim. */
export interface SuggestPlanResult {
  readonly kind: 'suggest-plan';
  readonly plan: SuggestionRunPlan;
  /**
   * Whether the identical-game skip is live for this run, decided ONCE here
   * rather than per shard, so the report's honesty note cannot depend on which
   * worker happened to answer first.
   */
  readonly identicalGameSkipEnabled: boolean;
  readonly identicalGameSkipDisabledReason?: string;
}

/**
 * PHASE 2a of a suggestions run: play the SHARED base games for a slice of slots.
 *
 * The adaptive search compares every candidate against the same base deck on the
 * same games, so the base arm is played ONCE for the whole run — not once per
 * candidate. Splitting that work by slot range is embarrassingly parallel, and
 * its results are what every variant slice in the same round needs before it can
 * start (hence the barrier in `run.ts`).
 */
export interface BaseSlotShardJob {
  readonly kind: 'base-slot-shard';
  readonly context: ShardContext;
  /** The run's seed — offset from `context.seed` when a history carried over. */
  readonly runSeed: number;
  /** Half-open slot range `[slotStart, slotEnd)`; slot k is (k % opps, k / opps). */
  readonly slotStart: number;
  readonly slotEnd: number;
}

export interface BaseSlotShardResult {
  readonly kind: 'base-slot-shard';
  readonly slotStart: number;
  readonly slotEnd: number;
  /** One record per slot, in slot order — the wire form of the base arm. */
  readonly records: readonly PairedBaseRecord[];
}

/**
 * PHASE 2b of a suggestions run: play ONE candidate's variant games over a slice
 * of slots, given the base records for those slots.
 *
 * Handing the base records in is what preserves the identical-game skip across
 * workers: a variant game whose swapped slots never left the library is provably
 * the base game, and this shard can only know that if it can see what the base
 * game did. The saving is real (often a third of all variant games), so dropping
 * it to simplify the protocol would cost more than the parallelism gained.
 */
export interface VariantSliceShardJob {
  readonly kind: 'variant-slice-shard';
  readonly context: ShardContext;
  readonly runSeed: number;
  /** The candidate's stable `outId>inId` key — how results are folded back. */
  readonly candidateKey: string;
  readonly outCardId: string;
  readonly inCardId: string;
  readonly outName: string;
  readonly inName: string;
  readonly slotStart: number;
  readonly slotEnd: number;
  /** Base records for exactly `[slotStart, slotEnd)`, in slot order. */
  readonly baseRecords: readonly PairedBaseRecord[];
}

export interface VariantSliceShardResult {
  readonly kind: 'variant-slice-shard';
  readonly candidateKey: string;
  readonly slotStart: number;
  readonly slotEnd: number;
  /** THIS slice's 2×2 table; the main thread sums slices into the arm's total. */
  readonly paired: PairedTable;
  readonly variantGamesPlayed: number;
  readonly variantGamesSkipped: number;
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
export type ShardJob =
  | GauntletShardJob
  | PairedShardJob
  | SuggestPlanJob
  | BaseSlotShardJob
  | VariantSliceShardJob
  | MatchJob;

/** Anything a worker can hand back on success. */
export type ShardResult =
  | GauntletShardResult
  | PairedShardResult
  | SuggestPlanResult
  | BaseSlotShardResult
  | VariantSliceShardResult
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
