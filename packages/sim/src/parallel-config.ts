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
 * Cores left to the host thread (it merges results, prints progress, and the
 * OS wants one too). Subtracted from the machine's parallelism when sizing the
 * default pool, so a 12-thread box runs 11 workers, not 12 fighting the host.
 */
export const HOST_RESERVED_CORES = 1;

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
 * loads the card pool and compiles the engine (~1–2s on this project's
 * reference box). At the gauntlet's measured double-digit games/sec under the
 * default pilot, this many games is comfortably more than that startup, so
 * auto-parallelism can only ever pay for itself. Runs with fewer than 2× this
 * stay sequential unless the user forces `--workers`.
 */
export const AUTO_GAMES_PER_WORKER = 150;

/**
 * The pool size AUTO mode picks for a run of `totalGames` cut into (at most)
 * `shardableUnits` independent slices on a machine reporting `cores` hardware
 * threads: every core but the host's share, never more than there are units of
 * work, and never more workers than the run has `AUTO_GAMES_PER_WORKER`-sized
 * helpings of games to feed them.
 *
 * Returns 1 when parallelism cannot pay (small run, one unit, one core) — the
 * caller then runs the plain sequential path, bit-for-bit as before.
 */
export function autoWorkerCount(totalGames: number, shardableUnits: number, cores: number): number {
  const usableCores = Math.max(1, Math.floor(cores) - HOST_RESERVED_CORES);
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
