/**
 * THE POOLED ARM TRANSPORT (DESIGN §3.77) — `suggestSwapsWith` over worker threads.
 *
 * The suggestion search is the one command where parallelism actually had to be
 * designed rather than dropped in, because its work is not one flat run: the
 * adaptive ladder advances a shrinking field of arms to growing depths, and every
 * arm is paired against the SAME base games. That gives two constraints, and this
 * module exists to satisfy both:
 *
 *   1. A ROUND IS THE BARRIER, and nothing smaller. The ladder cannot schedule
 *      wave N+1 until it has seen wave N's tallies, so each round's arms are
 *      shipped as ONE batch across the whole pool — the arms within a round are
 *      independent, and that is where all the parallelism is.
 *   2. THE BASE ARM IS PLAYED ONCE. Each round first plays whatever base slots
 *      it newly needs, then hands those records to every variant slice. Skipping
 *      this would let each of C candidates replay the base games itself: a pooled
 *      run would do ~1.8x the total WORK of the sequential one, burning most of
 *      the speedup it just bought. COORDINATION.md has the measurement that says
 *      the base arm is 22% of a search — too small to parallelise for its own
 *      sake, too large to duplicate C times.
 *
 * Correctness is by construction, not by hope: a paired slot is indivisible and
 * every slot lands in exactly one slice, so the merged 2x2 tables are integer
 * sums of the same per-slot outcomes the sequential run computes. The identity
 * test asserts a pooled report equals the sequential one field for field.
 */

import type { Deck } from './deck.js';
import type { ArmAdvanceOutcome, ArmAdvanceRequest, ArmTransport } from './suggest.js';
import type { PairedArmsUsage, PairedBaseRecord, SwapArm } from './paired-arms.js';
import type { PairedTable } from './stats.js';
import type { SuggestArmSliceResult, SuggestBaseSliceResult, SuggestSliceSettings } from './parallel-slices.js';
import { planSuggestSlices } from './parallel-slices.js';
import type { ParallelJob, ParallelResult } from './parallel-slices.js';
import type { WorkerInitSpec } from './parallel-slices.js';
import { createWorkerPool, type WorkerPool } from './parallel-host.js';

/**
 * HOW A BATCH OF SLICES GETS PLAYED — a worker pool in production, and the pure
 * `executeParallelJob` in the identity test. Injectable because the sharding and
 * merging below are the part that has to be RIGHT, and proving them equal to the
 * sequential search should not require spawning threads.
 */
export type JobBatchRunner = (
  jobs: readonly ParallelJob[],
  onProgress?: (gamesPlayed: number) => void,
) => Promise<readonly ParallelResult[]>;

/** What the sharded transport needs beyond the search's own options. */
export interface ShardedArmTransportOptions {
  readonly runJobs: JobBatchRunner;
  /** How many ways to cut a slot range — the pool's real width. */
  readonly shards: number;
  /** Everything but the seed, which only the search knows. See `begin`. */
  readonly settings: Omit<SuggestSliceSettings, 'runSeed'>;
  /** Forwarded per game played anywhere in the pool, as a DELTA. */
  readonly onGame?: (games: number) => void;
}

/** What the worker-backed transport needs on top. */
export interface WorkerArmTransportOptions {
  readonly init: WorkerInitSpec;
  readonly workers: number;
  readonly settings: Omit<SuggestSliceSettings, 'runSeed'>;
  readonly onGame?: (games: number) => void;
}

/** The transport plus the pool's lifecycle — the caller must close it. */
export interface WorkerArmTransport extends ArmTransport {
  readonly close: () => Promise<void>;
  /** Workers actually hired. Reported, because it is what the timing means. */
  readonly size: number;
}

const EMPTY_TABLE: PairedTable = { bothWon: 0, baseOnly: 0, variantOnly: 0, neither: 0 };

function addTables(a: PairedTable, b: PairedTable): PairedTable {
  return {
    bothWon: a.bothWon + b.bothWon,
    baseOnly: a.baseOnly + b.baseOnly,
    variantOnly: a.variantOnly + b.variantOnly,
    neither: a.neither + b.neither,
  };
}

/** One arm's running total across every round and every worker that touched it. */
interface AccumulatedArm {
  readonly swap: { readonly out: string; readonly in: string };
  readonly outName: string;
  readonly inName: string;
  readonly variantDeck: Deck;
  gamesPlayed: number;
  variantGamesSkipped: number;
  paired: PairedTable;
  /**
   * Per-slot outcomes, spliced in at each slice's absolute slot offset. Slices
   * arrive in job order but a sparse write by INDEX is order-independent anyway,
   * which is what keeps a pooled arm identical to a locally-played one.
   */
  variantWonBySlot: boolean[];
}

export function createShardedArmTransport(options: ShardedArmTransportOptions): ArmTransport {
  const shards = Math.max(1, options.shards);
  /** Set by `begin` before the first advance — see the interface for why. */
  let settings: SuggestSliceSettings | undefined;
  const requireSettings = (): SuggestSliceSettings => {
    if (!settings) throw new Error('the arm transport was asked to play before the search supplied its run seed');
    return settings;
  };

  /** Base records by ABSOLUTE slot — the run's shared, play-once half. */
  const baseRecords: PairedBaseRecord[] = [];
  const arms = new Map<string, AccumulatedArm>();
  /**
   * Per-phase wall clock, printed when JB_SUGGEST_TRACE is set. The pool scales
   * to only ~43% efficiency on six cores while the HOST sits 98.6% idle, so the
   * lost time is workers waiting at a barrier — and there is no telling WHICH
   * barrier without measuring the phases apart.
   */
  const trace = process.env.JB_SUGGEST_TRACE ? ([] as string[]) : undefined;
  let baseGamesPlayed = 0;
  let variantGamesPlayed = 0;
  let variantGamesSkipped = 0;

  /** Deltas out of a pool batch, which reports cumulative games. */
  function batchProgress(): ((games: number) => void) | undefined {
    const sink = options.onGame;
    if (!sink) return undefined;
    let last = 0;
    return (cumulative) => {
      if (cumulative > last) {
        sink(cumulative - last);
        last = cumulative;
      }
    };
  }

  /**
   * Play every base slot below `throughSlot` that the run has not played yet.
   *
   * Idempotent and monotone: `baseRecords.length` IS the high-water mark, so a
   * later round only ever plays the slots the ladder newly reached.
   */
  async function ensureBaseThrough(throughSlot: number): Promise<void> {
    const from = baseRecords.length;
    if (throughSlot <= from) return;
    const jobs: ParallelJob[] = planSuggestSlices(from, throughSlot, shards).map((range, jobId) => ({
      kind: 'suggest-base-slice',
      jobId,
      slotStart: range.gameStart,
      slotEnd: range.gameEnd,
      settings: requireSettings(),
    }));
    const startedAt = Date.now();
    const results = (await options.runJobs(jobs, batchProgress())) as readonly SuggestBaseSliceResult[];
    trace?.push(`base  ${jobs.length} jobs, slots ${from}..${throughSlot}, ${Date.now() - startedAt}ms`);
    // Job order is slot order (the plan is contiguous and ascending), and the pool
    // returns results in job order, so appending is the merge.
    for (const result of results) {
      if (result.slotStart !== baseRecords.length) {
        throw new Error(
          `base slice arrived for slot ${result.slotStart} with ${baseRecords.length} slots known — the base phase is out of order`,
        );
      }
      baseRecords.push(...result.records);
    }
    baseGamesPlayed += throughSlot - from;
  }

  async function advance(requests: readonly ArmAdvanceRequest[]): Promise<readonly ArmAdvanceOutcome[]> {
    if (requests.length === 0) return [];

    // 1. The shared half first — every variant slice below is handed its answers.
    await ensureBaseThrough(Math.max(...requests.map((request) => request.toGames)));

    // 2. Every arm's new slots, as ONE batch: the round is the barrier, so all of
    //    this round's work must be in flight at once for the pool to stay fed.
    const jobs: ParallelJob[] = [];
    for (const request of requests) {
      for (const range of planSuggestSlices(request.fromGames, request.toGames, shards)) {
        jobs.push({
          kind: 'suggest-arm-slice',
          jobId: jobs.length,
          key: request.key,
          out: request.swap.out,
          in: request.swap.in,
          outName: request.outName,
          inName: request.inName,
          slotStart: range.gameStart,
          slotEnd: range.gameEnd,
          baseRecords: baseRecords.slice(range.gameStart, range.gameEnd),
          settings: requireSettings(),
        });
      }
      if (!arms.has(request.key)) {
        arms.set(request.key, {
          swap: request.swap,
          outName: request.outName,
          inName: request.inName,
          variantDeck: request.variantDeck,
          gamesPlayed: 0,
          variantGamesSkipped: 0,
          paired: EMPTY_TABLE,
          variantWonBySlot: [],
        });
      }
    }
    const startedAt = Date.now();
    const results = (await options.runJobs(jobs, batchProgress())) as readonly SuggestArmSliceResult[];
    trace?.push(`arms  ${jobs.length} jobs over ${requests.length} arms, ${Date.now() - startedAt}ms`);

    for (const result of results) {
      const arm = arms.get(result.key);
      if (!arm) throw new Error(`arm slice returned for unknown candidate ${result.key}`);
      // The base phase is supposed to have supplied every record this slice needed.
      // A worker that had to play one itself means the schedule under-supplied and
      // the run just did duplicate work — loud, because the numbers still look fine.
      if (result.slice.baseGamesPlayed !== 0) {
        throw new Error(
          `arm slice for ${result.key} played ${result.slice.baseGamesPlayed} base games itself — the base phase under-supplied slots [${result.slotStart}, ${result.slotEnd})`,
        );
      }
      arm.paired = addTables(arm.paired, result.slice.paired);
      for (let i = 0; i < result.slice.variantWonBySlot.length; i++) {
        arm.variantWonBySlot[result.slotStart + i] = result.slice.variantWonBySlot[i] as boolean;
      }
      arm.gamesPlayed += result.slice.gamesPlayed;
      arm.variantGamesSkipped += result.slice.variantGamesSkipped;
      variantGamesPlayed += result.slice.variantGamesPlayed;
      variantGamesSkipped += result.slice.variantGamesSkipped;
    }

    return requests.map((request) => {
      const arm = arms.get(request.key) as AccumulatedArm;
      const outcome: SwapArm = {
        swap: arm.swap,
        outName: arm.outName,
        inName: arm.inName,
        variantDeck: arm.variantDeck,
        gamesPlayed: arm.gamesPlayed,
        variantGamesSkipped: arm.variantGamesSkipped,
        paired: arm.paired,
        variantWonBySlot: arm.variantWonBySlot,
      };
      return { key: request.key, arm: outcome };
    });
  }

  return {
    begin: (runSeed) => {
      settings = { ...options.settings, runSeed };
    },
    advance,
    // Counted from what the WORKERS reported, not from the host's runner — the
    // host plays nothing here, and a usage report sourced from it would say the
    // run played zero games. See COORDINATION.md on why that matters.
    usage: (identicalGameSkip) => {
      if (trace) for (const line of trace) console.log(`[suggest-trace] ${line}`);
      const usage: PairedArmsUsage = {
        baseGamesPlayed,
        variantGamesPlayed,
        variantGamesSkipped,
        totalGamesPlayed: baseGamesPlayed + variantGamesPlayed,
        identicalGameSkipEnabled: identicalGameSkip.enabled,
        ...(identicalGameSkip.reason ? { identicalGameSkipDisabledReason: identicalGameSkip.reason } : {}),
      };
      return usage;
    },
  };
}

/** The production transport: the same sharding, over a real thread pool. */
export function createWorkerArmTransport(options: WorkerArmTransportOptions): WorkerArmTransport {
  const pool: WorkerPool = createWorkerPool(options.init, Math.max(1, options.workers));
  const inner = createShardedArmTransport({
    runJobs: (jobs, onProgress) => pool.run(jobs, onProgress),
    shards: pool.size,
    settings: options.settings,
    ...(options.onGame ? { onGame: options.onGame } : {}),
  });
  return { ...inner, close: () => pool.close(), size: pool.size };
}
