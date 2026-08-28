/**
 * The REAL worker_threads proof (DESIGN §3.53).
 *
 * `parallel.test.ts` proves the slice layer merges byte-identically when run
 * in-process. What it cannot prove is the part the CLI actually ships: that
 * the engine + pilots + pool load and play INSIDE `node:worker_threads` (the
 * engine has only ever been proven in browser Web Workers), that `workerData`
 * and `postMessage` marshal the init/jobs/results losslessly, and that the
 * host's queue/merge produces the same numbers when real threads race. This
 * file spawns the pool for real — two workers, tiny grids — and compares
 * against the sequential functions.
 *
 * ⚠️ Requires the workspace to be BUILT (`npm run build`): a spawned worker is
 * a fresh Node process-thread with no Vitest aliases, so its `@jonny-boi/*`
 * imports resolve through package exports to `dist/`. On a fresh checkout with
 * no dist the suite SKIPS (same contract as the CLI itself, which also needs
 * the build); with a STALE dist it can fail — deliberately, because a stale
 * dist means the CLI you would measure is equally stale. `npm run verify`
 * builds before testing, so the gate holds where it matters.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import { loadDeck } from './deck.js';
import { gameSeedFor, type MatchupPilots } from './matchup.js';
import { runGauntlet } from './gauntlet.js';
import { runPilotAb } from './pilot-ab.js';
import {
  mergeGauntletFromSlices,
  mergePilotAbFromSlices,
  planMatchupSlices,
  planPilotAbSlices,
  type MatchupSliceResult,
  type PilotAbSliceResult,
} from './parallel-slices.js';
import { createWorkerPool } from './parallel-host.js';

const PILOT_ID = 'heuristic';
const SEED = 0xa11e5;
/** Worker startup loads the card pool from dist — generous on a loaded box. */
const WORKER_TEST_TIMEOUT_MS = 180_000;

/**
 * A worker resolves `@jonny-boi/*` through package exports → `dist/`. Resolve
 * the same way (not by a hard-coded path) so the gate cannot silently pass
 * while the worker would crash.
 */
const require = createRequire(import.meta.url);
function distBuilt(): boolean {
  try {
    return (
      existsSync(require.resolve('@jonny-boi/cards')) &&
      existsSync(require.resolve('@jonny-boi/core')) &&
      existsSync(require.resolve('@jonny-boi/ai'))
    );
  } catch {
    return false;
  }
}

const HAVE_DIST = distBuilt();

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function freshPilots(): MatchupPilots {
  const ai = createDefaultAiRegistry();
  return { pilotA: ai.getPilot(PILOT_ID) as Pilot, pilotB: ai.getPilot(PILOT_ID) as Pilot };
}

describe.skipIf(!HAVE_DIST)('the worker_threads host (spawns real workers; needs a built dist)', () => {
  it(
    'plays a gauntlet on 2 workers byte-identical to runGauntlet, then a pilot-ab batch on the SAME warm pool',
    async () => {
      const games = 6;
      const hero = loadDeck(SAMPLE_DECKS[0]!, pool);
      const opponents = [SAMPLE_DECKS[1]!, SAMPLE_DECKS[2]!].map((d) => loadDeck(d, pool));
      const sequential = runGauntlet(hero, opponents, freshPilots(), games, SEED, registry);

      const jobs = planMatchupSlices(opponents.length, games, 2, (i) => gameSeedFor(SEED, i));
      expect(jobs.length).toBeGreaterThan(1);

      // One worker init serves BOTH batches: the same worker pool plays a
      // gauntlet and then a pilot-ab, which is exactly the soak's two-phase
      // shape (and proves a pool survives batch boundaries).
      const workerPool = createWorkerPool(
        {
          heroName: hero.name,
          opponentNames: opponents.map((d) => d.name),
          deckNames: [SAMPLE_DECKS[0]!.name, SAMPLE_DECKS[1]!.name],
          pilotId: PILOT_ID,
          pilotAId: PILOT_ID,
          pilotBId: PILOT_ID,
        },
        2,
      );
      try {
        let ticks = 0;
        const results = await workerPool.run(jobs, () => {
          ticks++;
        });
        const slices = results as readonly MatchupSliceResult[];
        // Results come back keyed by job index, whatever order threads finished in.
        expect(slices.map((s) => s.jobId)).toEqual(jobs.map((j) => j.jobId));
        const merged = mergeGauntletFromSlices(slices);
        expect(merged).toEqual(sequential);
        expect(JSON.stringify(merged)).toBe(JSON.stringify(sequential));
        expect(ticks).toBeGreaterThanOrEqual(0); // progress is best-effort batching, never required

        // Batch two on the SAME pool: the pilot-ab control, which must come out
        // EXACTLY level — through real threads, or the harness is broken.
        const abGames = 4;
        const abDecks = [SAMPLE_DECKS[0]!, SAMPLE_DECKS[1]!].map((d) => loadDeck(d, pool));
        const abSequential = runPilotAb({
          decks: abDecks,
          pilots: freshPilots(),
          registry,
          gamesPerOrientation: abGames,
          baseSeed: SEED,
        });
        const abJobs = planPilotAbSlices(1, abGames, 2, SEED);
        const abSlices = (await workerPool.run(abJobs)) as readonly PilotAbSliceResult[];
        const abMerged = mergePilotAbFromSlices(abSlices, {
          decks: abDecks,
          pilotAId: PILOT_ID,
          pilotBId: PILOT_ID,
          gamesPerOrientation: abGames,
        });
        expect(abMerged).toEqual(abSequential);
        expect(JSON.stringify(abMerged)).toBe(JSON.stringify(abSequential));
        expect(abMerged.control).toBe(true);
        expect(abMerged.balanced).toBe(true);
      } finally {
        await workerPool.close();
      }
    },
    WORKER_TEST_TIMEOUT_MS,
  );

  it(
    'a worker failure is loud and total — an unknown deck name rejects the run instead of merging a hole',
    async () => {
      const workerPool = createWorkerPool(
        { heroName: 'No Such Deck', opponentNames: [SAMPLE_DECKS[1]!.name], pilotId: PILOT_ID },
        1,
      );
      try {
        await expect(
          workerPool.run(planMatchupSlices(1, 4, 1, () => SEED)),
        ).rejects.toThrow(/No Such Deck/);
      } finally {
        await workerPool.close();
      }
    },
    WORKER_TEST_TIMEOUT_MS,
  );
});
