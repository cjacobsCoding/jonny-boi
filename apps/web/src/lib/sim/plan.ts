/**
 * **Shard planning** — cutting a Lab run into independent pieces (pure).
 *
 * The plan decides only *how the work is divided*, never *what the work is*: a
 * shard always covers a contiguous, deterministic range of game indices for one
 * opponent, and the seeds inside it come from those indices. So changing the
 * plan (i.e. changing the worker count) reshuffles which core plays which game
 * and nothing else — proved by `determinism.test.ts`.
 *
 * The natural independent unit differs per run:
 *   - **Gauntlet** — one opponent's games. When there are fewer opponents than
 *     workers (the common "just check it against Mono-Red" case) that alone would
 *     leave eleven cores idle, so each matchup is further cut into game batches.
 *   - **A/B swap** — batches of PAIRED game indices; base and variant for a given
 *     index always land in the same shard, so common random numbers survive.
 *   - **Suggestions** — every candidate's whole paired gauntlet, all candidates'
 *     shards flattened into one queue so a 3-candidate search still uses 12 cores.
 *
 * No literals: every bound comes from `pool-config.ts`.
 */
import type { SwapScope } from '@jonny-boi/sim';
import { MIN_GAMES_PER_SHARD, SHARDS_PER_WORKER } from './pool-config.js';
import type {
  GameRange,
  GauntletShardJob,
  PairedShardJob,
  PlannedCandidate,
  ShardContext,
} from './shard-protocol.js';

/**
 * Cut `total` game indices into `parts` contiguous, near-equal ranges.
 *
 * Deterministic and exhaustive: the ranges tile `[0, total)` with no gap and no
 * overlap, and the remainder is spread over the leading chunks so no shard is
 * more than one game larger than any other. Empty ranges are never emitted.
 */
export function splitGameRange(total: number, parts: number): readonly GameRange[] {
  if (total <= 0) return [];
  const chunks = Math.min(Math.max(1, Math.floor(parts)), total);
  const base = Math.floor(total / chunks);
  const remainder = total % chunks;
  const ranges: GameRange[] = [];
  let cursor = 0;
  for (let i = 0; i < chunks; i++) {
    const size = base + (i < remainder ? 1 : 0);
    ranges.push({ gameStart: cursor, gameEnd: cursor + size });
    cursor += size;
  }
  return ranges;
}

/**
 * How many pieces one matchup's `gamesPerOpponent` games should be cut into so
 * that `opponentCount` matchups keep `workerCount` workers fed.
 *
 * We aim for `SHARDS_PER_WORKER` shards per worker (over-partitioning, because AI
 * game lengths vary hugely and an even split would strand cores at the tail), but
 * never cut below `MIN_GAMES_PER_SHARD` games — past that the message round-trip
 * costs more than the games.
 */
export function shardsPerMatchup(
  opponentCount: number,
  gamesPerOpponent: number,
  workerCount: number,
): number {
  if (opponentCount <= 0 || gamesPerOpponent <= 0) return 1;
  const targetShards = Math.max(1, workerCount * SHARDS_PER_WORKER);
  const wanted = Math.ceil(targetShards / opponentCount);
  const affordable = Math.max(1, Math.floor(gamesPerOpponent / MIN_GAMES_PER_SHARD));
  return Math.max(1, Math.min(wanted, affordable));
}

/**
 * The gauntlet plan: opponent-major, then game range. This IS the canonical
 * order — `merge.ts` sorts results back into it before aggregating.
 */
export function planGauntletShards(
  context: ShardContext,
  gamesPerOpponent: number,
  workerCount: number,
): readonly GauntletShardJob[] {
  const parts = shardsPerMatchup(context.opponentNames.length, gamesPerOpponent, workerCount);
  const jobs: GauntletShardJob[] = [];
  for (let opponentIndex = 0; opponentIndex < context.opponentNames.length; opponentIndex++) {
    for (const range of splitGameRange(gamesPerOpponent, parts)) {
      jobs.push({ kind: 'gauntlet-shard', context, opponentIndex, ...range });
    }
  }
  return jobs;
}

/**
 * The plan for ONE paired A/B evaluation (a standalone swap test, or a single
 * suggestion candidate). `swapSeed` is the base seed for this swap's whole paired
 * gauntlet; `candidateIndex` tags which candidate the shard belongs to during a
 * suggestions run and is `null` for a standalone test.
 */
export function planPairedShards(
  context: ShardContext,
  swap: {
    readonly outCardId: string;
    readonly inCardId: string;
    /** One copy or the whole playset; undefined means the sim's default. */
    readonly swapScope?: SwapScope;
  },
  gamesPerOpponent: number,
  workerCount: number,
  swapSeed: number,
  candidateIndex: number | null,
): readonly PairedShardJob[] {
  const parts = shardsPerMatchup(context.opponentNames.length, gamesPerOpponent, workerCount);
  const jobs: PairedShardJob[] = [];
  for (let opponentIndex = 0; opponentIndex < context.opponentNames.length; opponentIndex++) {
    for (const range of splitGameRange(gamesPerOpponent, parts)) {
      jobs.push({
        kind: 'paired-shard',
        context,
        opponentIndex,
        outCardId: swap.outCardId,
        inCardId: swap.inCardId,
        // Stamped on EVERY shard from the one plan-level value: the scope picks
        // which variant deck gets built, so shards that disagreed would average
        // two different experiments into one verdict.
        swapScope: swap.swapScope,
        swapSeed,
        candidateIndex,
        ...range,
      });
    }
  }
  return jobs;
}

/**
 * The suggestions plan: every candidate's paired shards, flattened into ONE
 * queue.
 *
 * Flattening is what makes a small search still use the whole machine. Handing
 * each worker a whole candidate is the obvious split, but a 3-candidate search on
 * a 12-core box would then run at 3 cores — and the tail of ANY search is a
 * handful of stragglers holding the run open. With every shard in one queue the
 * pool simply keeps all workers fed until the last game is played.
 *
 * The candidates are interleaved deliberately: shards are emitted candidate-major
 * so early candidates finish first, which keeps the progress label honest about
 * what is being evaluated.
 */
export function planSuggestShards(
  context: ShardContext,
  candidates: readonly PlannedCandidate[],
  gamesPerCandidate: number,
  workerCount: number,
): readonly PairedShardJob[] {
  const jobs: PairedShardJob[] = [];
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    const candidate = candidates[candidateIndex] as PlannedCandidate;
    jobs.push(
      ...planPairedShards(
        context,
        // No `swapScope`: the suggestion engine does not expose one, so its
        // candidates are evaluated at the sim's `DEFAULT_SWAP_SCOPE` — the same
        // default `suggestSwaps` gets, which is what keeps the parallel search's
        // ranking equal to the headless one.
        { outCardId: candidate.outId, inCardId: candidate.inId },
        gamesPerCandidate,
        workerCount,
        candidate.swapSeed,
        candidateIndex,
      ),
    );
  }
  return jobs;
}

/**
 * A stable, non-negative seed salt for a suggestion candidate.
 *
 * Mirrors the sim's own private `candidateSeedSalt` (an FNV-1a hash of
 * `out>in`), so a candidate evaluated here lands on exactly the same seed the
 * headless `suggestSwaps` would give it — the parity assertion in
 * `determinism.test.ts` pins that, so a change in the sim breaks a test rather
 * than silently producing different rankings on web and CLI.
 */
export function candidateSeedSalt(outId: string, inId: string): number {
  const FNV_OFFSET_BASIS = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;
  let hash = FNV_OFFSET_BASIS;
  const key = `${outId}>${inId}`;
  for (let i = 0; i < key.length; i++) {
    hash = Math.imul(hash ^ key.charCodeAt(i), FNV_PRIME) >>> 0;
  }
  return hash;
}

/** Total games a set of gauntlet shards will play (for the progress denominator). */
export function totalGauntletGames(jobs: readonly GauntletShardJob[]): number {
  return jobs.reduce((sum, job) => sum + (job.gameEnd - job.gameStart), 0);
}

/**
 * Total games a set of paired shards will play. Each paired game index plays the
 * base deck AND the variant deck, so the honest game count is twice the pairs —
 * the progress bar must not claim a run is half done when it has played half the
 * pairs but only a quarter of the games.
 */
export function totalPairedGames(jobs: readonly PairedShardJob[]): number {
  const GAMES_PER_PAIR = 2;
  return jobs.reduce((sum, job) => sum + (job.gameEnd - job.gameStart) * GAMES_PER_PAIR, 0);
}
