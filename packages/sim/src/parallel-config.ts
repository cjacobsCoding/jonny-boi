/**
 * Named knobs for the CLI's parallel worker host (DESIGN §3.53).
 *
 * Everything here is a POLICY number, kept out of the host/planner so the
 * behaviour is tunable in one place and no magic number hides in a loop bound
 * (CLAUDE.md rule 1). The *shapes* (how a run is cut into slices, how slices
 * merge back byte-identically) live in `parallel-slices.ts`; this file only
 * decides how many hands are hired and when hiring is worth it.
 *
 * Deliberately PURE — the machine's core count is a parameter, not an
 * `node:os` import — so the sizing policy is unit-testable and the module is
 * loadable anywhere the pure slice layer is. Only `parallel-host.ts` (the one
 * Node-only module) asks the OS for the real number.
 */


/**
 * Target slices per worker when cutting a run. Over-partitioning on purpose:
 * AI game lengths vary hugely (a stalled board can run 10x a race), so an even
 * one-slice-per-worker split strands every core at the tail while the
 * unluckiest worker finishes. Same rationale — and the same value — as the web
 * pool's `SHARDS_PER_WORKER` (`apps/web/src/lib/sim/pool-config.ts`).
 */
export const SLICES_PER_WORKER = 3;

/**
 * Never cut a matchup into slices smaller than this many games: below it the
 * per-slice overhead (one message round-trip, seat lookup) rivals the games
 * themselves. Mirrors the web pool's `MIN_GAMES_PER_SHARD`.
 */
export const MIN_GAMES_PER_SLICE = 4;

/**
 * How many games one worker must have waiting before AUTO mode hires it.
 *
 * A worker costs real wall time before its first game: a fresh Node thread
 * loads the card pool and links the engine. MEASURED on the reference box,
 * 2026-09-01: **~0.35s** of startup (292ms of it importing `@jonny-boi/cards`),
 * against **~180 games/sec** single-threaded — so one worker needs roughly 60
 * games just to break even, and comfortably more than that to be worth hiring.
 *
 * ⚠️ THE OLD VALUE WAS CALIBRATED AGAINST A SIM AN ORDER OF MAGNITUDE SLOWER.
 * Its comment said "double-digit games/sec" and "~1–2s" of startup, both true
 * when it was written and neither true now; 150 games is only ~0.8s of work at
 * today's speed, so auto mode hired workers that could not pay for themselves.
 * A constant whose comment describes a machine that no longer exists is a
 * constant nobody re-derived.
 */
export const AUTO_GAMES_PER_WORKER = 400;

/**
 * Hardware threads per physical core, for turning `availableParallelism()` into
 * a worker count worth hiring.
 *
 * ⚠️ SMT SIBLINGS DO NOT ADD THROUGHPUT HERE, THEY SUBTRACT IT. This workload is
 * compute- and allocation-bound — every worker holds its own copy of a
 * 5,000-card pool and churns game states — so two threads on one core contend
 * for the same execution ports and cache rather than overlapping stalls.
 *
 * MEASURED on the reference box (12 hardware threads, 6 physical cores),
 * 6,000-game match, heuristic pilot:
 *
 *     workers   2     3     4     5     6     8     11
 *     games/s  343   463   551   575  *593*  559   516
 *
 * The peak is exactly the PHYSICAL core count, and `availableParallelism()`
 * reports 12 — so auto mode was hiring 11 workers for 516 games/sec where 6
 * gives 593. At 3,000 games the gap is far worse (327 vs 451), because every
 * hired worker also pays its startup.
 *
 * ⚠️ CALIBRATED ON ONE MACHINE, and stated as such. It is the conservative
 * direction: a box with no SMT gets half its cores rather than all of them,
 * which costs some throughput but never oversubscribes. `--workers N` overrides
 * it outright, and `packages/sim/bench/pilot-bench.mjs` is how the curve above
 * gets re-measured on a different box.
 */
export const HARDWARE_THREADS_PER_CORE = 2;

/**
 * The pool size AUTO mode picks for a run of `totalGames` cut into (at most)
 * `shardableUnits` independent slices on a machine reporting `cores` hardware
 * threads: one worker per PHYSICAL core, never more than there are units of
 * work, and never more workers than the run has `AUTO_GAMES_PER_WORKER`-sized
 * helpings of games to feed them.
 *
 * Returns 1 when parallelism cannot pay (small run, one unit, one core) — the
 * caller then runs the plain sequential path, bit-for-bit as before.
 */
export function autoWorkerCount(totalGames: number, shardableUnits: number, cores: number): number {
  // `cores` is what `availableParallelism()` reports: HARDWARE THREADS. Folded
  // down to physical cores, because SMT siblings cost throughput on this
  // workload rather than adding it — see `HARDWARE_THREADS_PER_CORE`.
  //
  // ⚠️ NO SEPARATE RESERVATION FOR THE HOST. Folding by SMT already discarded
  // one sibling per core, so the dispatching host runs on a thread no worker was
  // going to get. A `HOST_RESERVED_CORES = 1` used to come off the total as
  // well, and taking a whole core off measured strictly worse — 5 workers 575
  // games/sec against 6 workers 593 at 6,000 games, and 723 against 765 at
  // 20,000 — because the host spends the run waiting on messages, not working.
  const usableCores = Math.max(1, Math.floor(Math.floor(cores) / HARDWARE_THREADS_PER_CORE));
  const fedByGames = Math.floor(totalGames / AUTO_GAMES_PER_WORKER);
  return Math.max(1, Math.min(usableCores, Math.max(1, shardableUnits), fedByGames));
}

/**
 * The pool size for an EXPLICIT `--workers N`: the user's number, still capped
 * by the number of independent units (an 8-opponent gauntlet cut for 32
 * workers would just idle 24 of them at startup cost).
 */
export function explicitWorkerCount(requested: number, shardableUnits: number): number {
  return Math.max(1, Math.min(Math.floor(requested), Math.max(1, shardableUnits)));
}

/**
 * How often a worker reports progress, in games. Batched so a fast slice does
 * not post a message per game (thousands/sec across a big pool), while a soak
 * progress line — printed every `mixedGames / 20` games — still advances
 * between slice completions.
 */
export const PROGRESS_TICK_GAMES = 16;
