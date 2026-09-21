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
 *   - **Suggestions** — a ROUND at a time, because the adaptive search is stateful
 *     across candidates: which arms survive round N+1 depends on what round N
 *     measured, so there is no flat queue to build. Within a round there are two
 *     parallel phases with a barrier between them — the shared base games for the
 *     new slots, then every surviving arm's variant games over those slots. Both
 *     phases are cut by SLOT range, so a late round with two survivors still fills
 *     twelve cores as long as it has slots to hand out.
 *
 * No literals: every bound comes from `pool-config.ts`.
 */
import {
  DEFAULT_ADAPTIVE_CONFIG,
  GAMES_PER_PAIRED_GAME,
  planWaves,
  type PairedBaseRecord,
  type SwapScope,
} from '@jonny-boi/sim';

import { MIN_GAMES_PER_SHARD, SHARDS_PER_WORKER } from './pool-config.js';
import type {
  BaseSlotShardJob,
  GameRange,
  GauntletShardJob,
  ManabaseBaseSlotShardJob,
  ManabaseVariantSliceShardJob,
  VariantSliceSpec,
  PairedShardJob,
  ShardContext,
  VariantSliceShardJob,
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
 * How many pieces each of `groupCount` groups of `gamesPerGroup` games should be
 * cut into so that the groups together keep `workerCount` workers fed.
 *
 * We aim for `SHARDS_PER_WORKER` shards per worker (over-partitioning, because AI
 * game lengths vary hugely and an even split would strand cores at the tail), but
 * never cut below `MIN_GAMES_PER_SHARD` games — past that the message round-trip
 * costs more than the games.
 *
 * A "group" is a matchup for a gauntlet, and a surviving ARM for a round of the
 * adaptive search. The arithmetic is the same either way, which is why it is one
 * function: the late rounds of a search look exactly like a one-opponent gauntlet,
 * and both need the same answer to "how do I keep twelve cores busy from two
 * groups?".
 */
export function shardsPerGroup(
  groupCount: number,
  gamesPerGroup: number,
  workerCount: number,
): number {
  if (groupCount <= 0 || gamesPerGroup <= 0) return 1;
  const targetShards = Math.max(1, workerCount * SHARDS_PER_WORKER);
  const wanted = Math.ceil(targetShards / groupCount);
  const affordable = Math.max(1, Math.floor(gamesPerGroup / MIN_GAMES_PER_SHARD));
  return Math.max(1, Math.min(wanted, affordable));
}

/** How many pieces one matchup's games are cut into. See {@link shardsPerGroup}. */
export const shardsPerMatchup = shardsPerGroup;

/**
 * The gauntlet plan: opponent-major, then game range. This IS the canonical
 * order — `merge.ts` sorts results back into it before aggregating.
 */
export function planGauntletShards(
  context: ShardContext,
  gamesPerOpponent: number,
  workerCount: number,
  /**
   * Plan only games `[gameStart, gameEnd)` — the same prefix property the paired
   * planners document, so a pilot stage and the stage after it compose into
   * exactly the run they were cut from (§3.94).
   */
  window?: { readonly gameStart: number; readonly gameEnd: number },
): readonly GauntletShardJob[] {
  const from = window?.gameStart ?? 0;
  const to = window?.gameEnd ?? gamesPerOpponent;
  const span = Math.max(0, to - from);
  const parts = shardsPerGroup(context.opponentNames.length, span, workerCount);
  const jobs: GauntletShardJob[] = [];
  for (let opponentIndex = 0; opponentIndex < context.opponentNames.length; opponentIndex++) {
    for (const piece of splitGameRange(span, parts)) {
      const range = { gameStart: from + piece.gameStart, gameEnd: from + piece.gameEnd };
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
  /**
   * Plan only games `[gameStart, gameEnd)` of the run. `gamesPerOpponent` stays the
   * FULL total because every game seeds off its ABSOLUTE index, so windows compose
   * into exactly the run they were cut from — which is what lets the Lab stop a
   * decided A/B early without changing a game it already played (§3.92).
   */
  window?: { readonly gameStart: number; readonly gameEnd: number },
): readonly PairedShardJob[] {
  const from = window?.gameStart ?? 0;
  const to = window?.gameEnd ?? gamesPerOpponent;
  const span = Math.max(0, to - from);
  const parts = shardsPerGroup(context.opponentNames.length, span, workerCount);
  const jobs: PairedShardJob[] = [];
  for (let opponentIndex = 0; opponentIndex < context.opponentNames.length; opponentIndex++) {
    for (const piece of splitGameRange(span, parts)) {
      const range = { gameStart: from + piece.gameStart, gameEnd: from + piece.gameEnd };
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

// --- suggestions: one ROUND of the adaptive search ------------------------------

/**
 * Cut a half-open SLOT range into contiguous shards. A "slot" is one paired game
 * of the search: slot k is opponent `k % opponents`, game `floor(k / opponents)`,
 * so any prefix of the slot sequence is spread evenly over the whole gauntlet.
 */
export function splitSlotRange(
  slotStart: number,
  slotEnd: number,
  parts: number,
): readonly { readonly slotStart: number; readonly slotEnd: number }[] {
  return splitGameRange(Math.max(0, slotEnd - slotStart), parts).map((range) => ({
    slotStart: slotStart + range.gameStart,
    slotEnd: slotStart + range.gameEnd,
  }));
}

/**
 * PHASE A of a round: the shared base games the round needs and no earlier round
 * played, cut across the workers.
 *
 * Embarrassingly parallel — every slot is independent — and it must ALL complete
 * before phase B starts, because a variant slice cannot decide whether its game
 * is provably identical to the base game without the base game's record.
 */
export function planBaseSlotShards(
  context: ShardContext,
  runSeed: number,
  slotStart: number,
  slotEnd: number,
  workerCount: number,
): readonly BaseSlotShardJob[] {
  const total = Math.max(0, slotEnd - slotStart);
  if (total === 0) return [];
  const parts = shardsPerGroup(1, total, workerCount);
  return splitSlotRange(slotStart, slotEnd, parts).map((range) => ({
    kind: 'base-slot-shard' as const,
    context,
    runSeed,
    ...range,
  }));
}

/** One arm's outstanding work in a round, as the search asked for it. */
export interface ArmSlice {
  readonly candidateKey: string;
  readonly outCardId: string;
  readonly inCardId: string;
  readonly outName: string;
  readonly inName: string;
  /** Slots already played; the round starts here. */
  readonly fromSlot: number;
  /** Slots the arm must reach by the end of the round. */
  readonly toSlot: number;
}

/**
 * PHASE B of a round: every surviving arm's variant games, cut by slot range and
 * flattened into ONE queue.
 *
 * Cutting WITHIN an arm is what keeps the late rounds from collapsing to two busy
 * cores. Successive halving ends with a handful of survivors, but it ends with a
 * handful of survivors playing the DEEPEST batch — so there are plenty of slots to
 * hand out even when there are only two arms left. Utilisation still dips at the
 * very end (a two-arm round cannot be split past `MIN_GAMES_PER_SHARD`, and the
 * barrier means the round is only as fast as its slowest shard), and that dip is
 * inherent to a stateful search rather than a bug in the split.
 *
 * Every shard carries the base records for exactly its own slots, so it is
 * self-contained: the pool may retry it on a fresh worker without the round having
 * to be replayed.
 */
export function planVariantSliceShards(
  context: ShardContext,
  runSeed: number,
  arms: readonly ArmSlice[],
  workerCount: number,
  baseRecordAt: (slot: number) => PairedBaseRecord,
): readonly VariantSliceShardJob[] {
  const jobs: VariantSliceShardJob[] = [];
  for (const arm of arms) {
    const outstanding = Math.max(0, arm.toSlot - arm.fromSlot);
    if (outstanding === 0) continue;
    const parts = shardsPerGroup(arms.length, outstanding, workerCount);
    for (const range of splitSlotRange(arm.fromSlot, arm.toSlot, parts)) {
      const baseRecords: PairedBaseRecord[] = [];
      for (let slot = range.slotStart; slot < range.slotEnd; slot++) {
        baseRecords.push(baseRecordAt(slot));
      }
      jobs.push({
        kind: 'variant-slice-shard',
        context,
        runSeed,
        candidateKey: arm.candidateKey,
        outCardId: arm.outCardId,
        inCardId: arm.inCardId,
        outName: arm.outName,
        inName: arm.inName,
        ...range,
        baseRecords,
      });
    }
  }
  return jobs;
}

/**
 * Roughly how many games a suggestions search will play, WITHOUT building a plan.
 *
 * The real total is only known once a worker has enumerated the candidate pool, and
 * `run.ts` refines it every round from the actual plan. This is the version the UI
 * can compute on the main thread, before anything is dispatched, so a user can see
 * what a run costs *while choosing* rather than after committing to it.
 *
 * It walks the same ladder the search will: each wave plays one shared base game
 * per new slot plus one variant game per surviving arm per new slot, and the field
 * shrinks to each wave's `survivorTarget`. It over-states in two known ways — the
 * roster is capped at the requested maximum (the pool may generate fewer) and the
 * identical-game skip answers some variant games for free — and over-stating is the
 * right direction for a "how long will this take?" number.
 */
export function estimateSuggestionGames(maxCandidates: number, gamesPerCandidate: number): number {
  const roster = Math.max(1, Math.floor(maxCandidates));
  const waves = planWaves(roster, gamesPerCandidate, DEFAULT_ADAPTIVE_CONFIG);
  let arms = roster;
  let previous = 0;
  let games = 0;
  for (const spec of waves) {
    const newSlots = Math.max(0, spec.cumulativeGames - previous);
    games += newSlots * (arms + 1); // one variant game per arm, one shared base game
    previous = spec.cumulativeGames;
    arms = Math.min(arms, spec.survivorTarget);
  }
  return games;
}

// --- §3.175 manabase experiments: one ROUND, cut exactly as a suggestions round ------

/**
 * PHASE A of a manabase round — `planBaseSlotShards` with the watched kind. The
 * cut is the same function (slot ranges over the workers); only the job kind
 * differs, because the worker must build its runner WITH the reliability watch.
 */
export function planManabaseBaseSlotShards(
  context: ShardContext,
  runSeed: number,
  slotStart: number,
  slotEnd: number,
  workerCount: number,
): readonly ManabaseBaseSlotShardJob[] {
  return planBaseSlotShards(context, runSeed, slotStart, slotEnd, workerCount).map((job) => ({
    kind: 'manabase-base-slot-shard' as const,
    context: job.context,
    runSeed: job.runSeed,
    slotStart: job.slotStart,
    slotEnd: job.slotEnd,
  }));
}

/** One manabase arm's outstanding work in a round. */
export interface ManabaseArmSlice {
  readonly candidateKey: string;
  /** A §3.175 variant or a §3.177 joint move — both are a list of steps. */
  readonly variant: VariantSliceSpec;
  readonly fromSlot: number;
  readonly toSlot: number;
}

/**
 * PHASE B of a manabase round — every surviving variant's games, cut by slot
 * range exactly as `planVariantSliceShards` cuts a suggestions round, each shard
 * self-contained with the (watched) base records for its own slots.
 */
export function planManabaseVariantSliceShards(
  context: ShardContext,
  runSeed: number,
  arms: readonly ManabaseArmSlice[],
  workerCount: number,
  baseRecordAt: (slot: number) => PairedBaseRecord,
): readonly ManabaseVariantSliceShardJob[] {
  const jobs: ManabaseVariantSliceShardJob[] = [];
  for (const arm of arms) {
    const outstanding = Math.max(0, arm.toSlot - arm.fromSlot);
    if (outstanding === 0) continue;
    const parts = shardsPerGroup(arms.length, outstanding, workerCount);
    for (const range of splitSlotRange(arm.fromSlot, arm.toSlot, parts)) {
      const baseRecords: PairedBaseRecord[] = [];
      for (let slot = range.slotStart; slot < range.slotEnd; slot++) baseRecords.push(baseRecordAt(slot));
      jobs.push({
        kind: 'manabase-variant-slice-shard',
        context,
        runSeed,
        candidateKey: arm.candidateKey,
        variant: arm.variant,
        ...range,
        baseRecords,
      });
    }
  }
  return jobs;
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
  return jobs.reduce(
    (sum, job) => sum + (job.gameEnd - job.gameStart) * GAMES_PER_PAIRED_GAME,
    0,
  );
}
