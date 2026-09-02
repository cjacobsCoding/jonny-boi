/**
 * BYTE-IDENTITY of the POOLED suggestion search (DESIGN §3.77).
 *
 * `suggest` is the one command whose parallel form had to be designed rather
 * than dropped in: the adaptive ladder advances a shrinking field of arms to
 * growing depths, and every arm is paired against the same base games. So there
 * are two ways for a pooled run to be wrong that the other commands cannot be —
 * a slot played by the wrong shard, or a base game replayed per candidate — and
 * both of them produce a report that still LOOKS fine.
 *
 * These tests take the direct route: run the search sequentially, run it again
 * over the sharded transport with the slices executed in deliberately scrambled
 * order, and require the two reports to be equal field for field, including
 * `JSON.stringify` equality so key order and float bit-patterns match too.
 *
 * The executor here is the SAME `executeParallelJob` the worker thread entry
 * calls; the actual `node:worker_threads` spawn is `parallel-host.test.ts`'s job.
 */

import { describe, expect, it } from 'vitest';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { loadDeck } from './deck.js';
import type { MatchupPilots } from './matchup.js';
import { MONO_GREEN_STOMPY, MONO_RED_AGGRO, UW_CONTROL } from '../data/decks/index.js';
import { DEFAULT_DECK_RULES } from './config.js';
import { DEFAULT_SUGGEST_CONFIG } from './suggest-config.js';
import { suggestSwaps, suggestSwapsWith, type SuggestOptions } from './suggest.js';
import { createShardedArmTransport } from './suggest-workers.js';
import {
  createParallelContext,
  executeParallelJob,
  type ParallelJob,
  type ParallelResult,
} from './parallel-slices.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function pilots(): MatchupPilots {
  const ai = createDefaultAiRegistry();
  return {
    pilotA: ai.getPilot(HEURISTIC_PILOT_ID) as Pilot,
    pilotB: ai.getPilot(HEURISTIC_PILOT_ID) as Pilot,
  };
}

const RUN_SEED = 4242;

function optionsFor(): SuggestOptions {
  return {
    gauntletDecks: [loadDeck(MONO_GREEN_STOMPY, pool), loadDeck(UW_CONTROL, pool)],
    pilots: pilots(),
    pool,
    registry,
    baseSeed: RUN_SEED,
    gamesPerCandidate: 4,
    suggestConfig: { ...DEFAULT_SUGGEST_CONFIG, maxCandidates: 6 },
  };
}

/**
 * A transport whose "pool" runs the jobs IN REVERSE and then restores job order —
 * exactly the contract a real `WorkerPool` offers ("results in job order, never
 * arrival order"), with the completion order deliberately wrong underneath it.
 * One context for the whole run, as a worker has: that is also what exercises
 * the per-run runner cache and its supplied-base-record store.
 */
function scrambledTransport(shards: number, sink?: (games: number) => void) {
  const context = createParallelContext({
    heroName: MONO_RED_AGGRO.name,
    opponentNames: [MONO_GREEN_STOMPY.name, UW_CONTROL.name],
    pilotId: HEURISTIC_PILOT_ID,
  });
  let batches = 0;
  const runJobs = async (
    jobs: readonly ParallelJob[],
    onProgress?: (gamesPlayed: number) => void,
  ): Promise<readonly ParallelResult[]> => {
    batches++;
    // Cumulative across the batch, as a real pool reports it.
    let batchGames = 0;
    const done = [...jobs].reverse().map((job) => {
      let jobGames = 0;
      const result = executeParallelJob(context, job, (games) => {
        batchGames += games - jobGames;
        jobGames = games;
        onProgress?.(batchGames);
      });
      return { job, result };
    });
    return done.sort((a, b) => a.job.jobId - b.job.jobId).map((entry) => entry.result);
  };
  const transport = createShardedArmTransport({
    runJobs,
    shards,
    settings: { runSeed: RUN_SEED, deckRules: DEFAULT_DECK_RULES },
    ...(sink ? { onGame: sink } : {}),
  });
  return { transport, batches: () => batches };
}

describe('the pooled suggestion search reproduces the sequential one', () => {
  it('is the same report at every shard width, with slices executed out of order', async () => {
    const sequential = suggestSwaps(MONO_RED_AGGRO, optionsFor());

    for (const shards of [1, 2, 5]) {
      const { transport } = scrambledTransport(shards);
      const pooled = await suggestSwapsWith(MONO_RED_AGGRO, optionsFor(), transport);

      // Wall clock cannot match and must not be asked to; everything that is an
      // ANSWER must. So the two timing fields are normalised and NOTHING else is
      // — the comparison below is the whole report, not a chosen subset of it.
      const normalise = (report: typeof sequential) => ({
        ...report,
        notes: { ...report.notes, elapsedSeconds: 0, gamesPerSecond: 0 },
      });
      expect(normalise(pooled)).toEqual(normalise(sequential));
      // Byte identity, not just deep equality: same key order, same float bits.
      expect(JSON.stringify(normalise(pooled))).toBe(JSON.stringify(normalise(sequential)));
    }
  });

  it('is still identical on a CONTINUED run, where the seed is not the base seed', async () => {
    // ⚠️ THE TRAP THIS PINS: `runSeed` equals `baseSeed` only on a deck's FIRST
    // run. A run that continues a history plays on `gameSeedFor(baseSeed, runs)`
    // so it draws different games. A transport that derived the seed from the
    // caller's `baseSeed` would therefore agree with the host exactly once and
    // silently play a DIFFERENT set of games on every run after — producing a
    // report that looked perfectly well-formed. Hence `ArmTransport.begin`: the
    // search tells the transport its seed, and no one recomputes it.
    const first = suggestSwaps(MONO_RED_AGGRO, optionsFor());
    const continued: SuggestOptions = { ...optionsFor(), history: first.history };

    const sequential = suggestSwaps(MONO_RED_AGGRO, continued);
    const { transport } = scrambledTransport(4);
    const pooled = await suggestSwapsWith(MONO_RED_AGGRO, { ...continued }, transport);

    const normalise = (report: typeof sequential) => ({
      ...report,
      notes: { ...report.notes, elapsedSeconds: 0, gamesPerSecond: 0 },
    });
    expect(JSON.stringify(normalise(pooled))).toBe(JSON.stringify(normalise(sequential)));
    // The premise of the test: this run really is on a different seed.
    expect(first.history.runsCompleted).toBeGreaterThan(0);
  });

  it('plays the base arm ONCE for the whole run, not once per candidate', async () => {
    const sequential = suggestSwaps(MONO_RED_AGGRO, optionsFor());
    const { transport } = scrambledTransport(4);
    const pooled = await suggestSwapsWith(MONO_RED_AGGRO, optionsFor(), transport);

    // The base phase is the whole reason the pooled search is not simply "run
    // each candidate's A/B on its own worker": that would replay the shared base
    // games once per candidate. The accounting has to show it did not.
    expect(pooled.notes.baseGamesPlayed).toBe(sequential.notes.baseGamesPlayed);
    expect(pooled.notes.totalGamesRun).toBe(sequential.notes.totalGamesRun);
    expect(pooled.notes.gamesAvoided).toBe(sequential.notes.gamesAvoided);
  });

  it('counts every game it played — the host plays none of them', async () => {
    let ticked = 0;
    const { transport } = scrambledTransport(3, (games) => {
      ticked += games;
    });
    const pooled = await suggestSwapsWith(MONO_RED_AGGRO, optionsFor(), transport);
    // A pooled run's usage cannot come from the host's runner, which sees no
    // games at all. If the two ever disagree, the report is lying about the run.
    expect(ticked).toBe(pooled.notes.totalGamesRun);
  });

  it('ships one batch of base slices and one of arm slices per wave', async () => {
    const { transport, batches } = scrambledTransport(4);
    await suggestSwapsWith(MONO_RED_AGGRO, optionsFor(), transport);
    // The round is the barrier and nothing smaller: the ladder cannot schedule
    // the next wave until it has seen this one. Two batches per wave is the
    // floor, and a regression that ships arms one at a time would blow past it.
    expect(batches()).toBeGreaterThan(0);
    expect(batches()).toBeLessThanOrEqual(2 * DEFAULT_SUGGEST_CONFIG.defaultGamesPerCandidate);
  });
});
