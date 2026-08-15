/**
 * Named configuration for the **sim worker pool** (the Lab's parallel runner).
 *
 * Every number that decides how many workers we spawn, how finely a run is cut
 * into shards, or how hard we retry a dead worker lives here as a NAMED token
 * (CLAUDE.md rule 1 — no magic numbers). Nothing in `pool.ts` / `plan.ts` may
 * inline a literal for any of it.
 *
 * None of these values can change a run's RESULT — they only change how the work
 * is spread across cores. Determinism is a property of the seed derivation and
 * the canonical re-ordering in `merge.ts`, never of the pool size (see
 * `determinism.test.ts`).
 */

/**
 * Logical cores deliberately NOT given to the pool, so the browser always has a
 * core left for the main thread. The Lab's promise is that the UI never freezes
 * while thousands of games run; handing every core to the sim makes the tab
 * stutter even though the work is off-thread.
 */
export const UI_RESERVED_CORES = 1;

/**
 * Hard ceiling on pooled workers. Each worker builds its own card pool + effect
 * registry (tens of MB across a big pool), and past this point the marginal game
 * throughput is eaten by memory pressure and message traffic. A 64-core machine
 * does not want 63 sim workers.
 */
export const MAX_POOL_WORKERS = 12;

/** A pool always has at least one worker — the sim must never run on the UI thread. */
export const MIN_POOL_WORKERS = 1;

/**
 * Pool size when `navigator.hardwareConcurrency` is missing or nonsense (older
 * Safari, locked-down embedders). We degrade to a single worker rather than
 * guessing a core count: one worker is exactly today's behaviour, so an unknown
 * host is never made *worse* by the pool.
 */
export const FALLBACK_WORKER_COUNT = 1;

/**
 * How many shards we aim to create per worker. Games are wildly uneven — one AI
 * game can take 20x another — so cutting the work into exactly one shard per
 * worker leaves cores idle at the tail while the unluckiest worker finishes.
 * Over-partitioning lets the pool refill idle workers from the queue.
 */
export const SHARDS_PER_WORKER = 3;

/**
 * The smallest batch of games worth shipping to a worker as its own shard.
 * Below this the per-shard overhead (message round-trip, seat construction)
 * starts to matter relative to the games themselves.
 */
export const MIN_GAMES_PER_SHARD = 4;

/**
 * How many times a single shard may be dispatched before the run fails. A worker
 * that dies (OOM, a browser reclaiming background tabs) must not hang the run:
 * we re-dispatch its shard onto a fresh worker once, and if that also fails the
 * run reports an honest error rather than a silent partial result.
 */
export const MAX_SHARD_ATTEMPTS = 2;

/**
 * How often the pool may push an aggregated progress message into React state.
 * Workers tick per game; at twelve workers × hundreds of games/sec that would be
 * a re-render storm, so the pool coalesces ticks to this interval.
 */
export const PROGRESS_INTERVAL_SECONDS = 0.25;

/**
 * Query-string override for the pool size (`?simWorkers=1`), used to benchmark
 * single-threaded against pooled on the same build and to let a user throttle
 * the Lab while they do something else. Out-of-range values are clamped, not
 * obeyed blindly.
 */
export const WORKER_COUNT_QUERY_PARAM = 'simWorkers';

/**
 * Clamp a requested worker count into the pool's legal range.
 */
function clampWorkerCount(count: number): number {
  if (!Number.isFinite(count)) return FALLBACK_WORKER_COUNT;
  return Math.min(MAX_POOL_WORKERS, Math.max(MIN_POOL_WORKERS, Math.floor(count)));
}

/**
 * The pool size for a host with `hardwareConcurrency` logical cores, honouring an
 * explicit `override` when one was given.
 *
 * Pure so it is unit-testable without a browser: the caller supplies the numbers.
 */
export function poolWorkerCount(
  hardwareConcurrency: number | undefined,
  override?: number | undefined,
): number {
  if (override !== undefined) return clampWorkerCount(override);
  if (typeof hardwareConcurrency !== 'number' || !Number.isFinite(hardwareConcurrency)) {
    return FALLBACK_WORKER_COUNT;
  }
  if (hardwareConcurrency < MIN_POOL_WORKERS + UI_RESERVED_CORES) {
    // A single- (or zero-) core host: one worker, and the UI shares that core.
    return FALLBACK_WORKER_COUNT;
  }
  return clampWorkerCount(hardwareConcurrency - UI_RESERVED_CORES);
}

/**
 * Read the `?simWorkers=` override from a query string, or `undefined` when it is
 * absent or not a number. Kept pure (takes the search string) so it is testable.
 */
export function parseWorkerCountOverride(search: string): number | undefined {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return undefined;
  }
  const raw = params.get(WORKER_COUNT_QUERY_PARAM);
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The pool size for the CURRENT browser. Isolated here so every caller gets the
 * same policy and no view invents its own core maths.
 */
export function browserPoolWorkerCount(): number {
  const cores =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : undefined;
  const override =
    typeof location !== 'undefined' ? parseWorkerCountOverride(location.search) : undefined;
  return poolWorkerCount(cores, override);
}
