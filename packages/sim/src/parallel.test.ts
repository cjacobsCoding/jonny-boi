/**
 * BYTE-IDENTITY of the parallel slice layer (DESIGN §3.53).
 *
 * The CLI's worker host may only ever change the WALL CLOCK of a run — never a
 * row, a CI, a p-value or a verdict. These tests prove it the direct way: play
 * small grids through the sequential functions and through the slice plan +
 * executor + merge (in-process, in deliberately scrambled completion order),
 * and require the results to be equal FIELD FOR FIELD — including
 * `JSON.stringify` equality, so even key order and float bit-patterns match.
 *
 * The executor here is the SAME `executeParallelJob` the worker thread entry
 * calls; what these tests cannot cover (an actual `node:worker_threads` spawn,
 * `workerData` marshalling, the tsx loader) is `parallel-host.test.ts`'s job.
 */

import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import { loadDeck } from './deck.js';
import { gameSeedFor, makeSeats, runMatchup, type MatchupPilots } from './matchup.js';
import { runGauntlet } from './gauntlet.js';
import { evaluateSwap } from './swap.js';
import { runPilotAb } from './pilot-ab.js';
import { finishSoak, formatSoakReport, runSoak, runSoakAnchored, runSoakMixedRange } from './soak.js';
import {
  createParallelContext,
  executeParallelJob,
  maxUsefulSlices,
  mergeGauntletFromSlices,
  mergeMatchupsFromSlices,
  mergePilotAbFromSlices,
  mergeSwapFromSlices,
  planMatchupSlices,
  planPairedSlices,
  planPilotAbSlices,
  splitGameRange,
  slicesPerUnit,
  type MatchupSliceResult,
  type PairedSliceResult,
  type ParallelJob,
  type ParallelResult,
  type PilotAbSliceResult,
} from './parallel-slices.js';
import { AUTO_GAMES_PER_WORKER, HOST_RESERVED_CORES, autoWorkerCount, explicitWorkerCount } from './parallel-config.js';

/**
 * The heuristic pilot everywhere: the identity property is pilot-independent
 * (it rests on absolute-index seeding, which pilots never see), and these
 * grids are about proving plumbing, not strength.
 */
const PILOT_ID = 'heuristic';
const SEED = 0x5eed5;

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function freshPilots(): MatchupPilots {
  const ai = createDefaultAiRegistry();
  return { pilotA: ai.getPilot(PILOT_ID) as Pilot, pilotB: ai.getPilot(PILOT_ID) as Pilot };
}

/** Execute a plan in REVERSED order — a stand-in for "whichever worker finished
 * first" — through the same executor the worker entry uses. */
function executeScrambled(jobs: readonly ParallelJob[], init: Parameters<typeof createParallelContext>[0]): ParallelResult[] {
  const context = createParallelContext(init);
  return [...jobs].reverse().map((job) => executeParallelJob(context, job));
}

const heroDeck = SAMPLE_DECKS[0]!;
const oppDecks = [SAMPLE_DECKS[1]!, SAMPLE_DECKS[2]!];

describe('parallel slices reproduce the sequential run byte-for-byte', () => {
  it('gauntlet: plan → execute (scrambled) → merge equals runGauntlet, at several worker counts', () => {
    const games = 6;
    const hero = loadDeck(heroDeck, pool);
    const opponents = oppDecks.map((d) => loadDeck(d, pool));
    const sequential = runGauntlet(hero, opponents, freshPilots(), games, SEED, registry);

    for (const workerCount of [1, 2, 5]) {
      const jobs = planMatchupSlices(opponents.length, games, workerCount, (i) => gameSeedFor(SEED, i));
      const slices = executeScrambled(jobs, {
        heroName: hero.name,
        opponentNames: opponents.map((d) => d.name),
        pilotId: PILOT_ID,
      }) as MatchupSliceResult[];
      const merged = mergeGauntletFromSlices(slices);
      expect(merged).toEqual(sequential);
      // Byte identity, not just deep equality: same key order, same float bits.
      expect(JSON.stringify(merged)).toBe(JSON.stringify(sequential));
    }
  });

  it('match: a one-opponent plan seeded with the run seed equals runMatchup', () => {
    const games = 8;
    const deckA = loadDeck(heroDeck, pool);
    const deckB = loadDeck(oppDecks[0]!, pool);
    const sequential = runMatchup(makeSeats(deckA, deckB, freshPilots(), registry), games, SEED);

    const jobs = planMatchupSlices(1, games, 3, () => SEED);
    expect(jobs.length).toBeGreaterThan(1); // the point: one matchup, several slices
    const slices = executeScrambled(jobs, {
      heroName: deckA.name,
      opponentNames: [deckB.name],
      pilotId: PILOT_ID,
    }) as MatchupSliceResult[];
    const merged = mergeMatchupsFromSlices(slices);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(sequential);
    expect(JSON.stringify(merged[0])).toBe(JSON.stringify(sequential));
  });

  it('swap: sliced paired evaluation equals evaluateSwap (self-swap sanity case included)', () => {
    const games = 4;
    const opponents = oppDecks.map((d) => loadDeck(d, pool));
    const selfSwapCard = heroDeck.cards[0]!.cardId;
    const swap = { out: selfSwapCard, in: selfSwapCard };
    const sequential = evaluateSwap(heroDeck, swap, opponents, freshPilots(), games, SEED, pool, registry, {
      swapScope: 'playset',
    });
    // The lab's own sanity property must hold before the comparison means anything.
    expect(sequential.verdict).toBe('inconclusive');
    expect(sequential.paired.baseOnly + sequential.paired.variantOnly).toBe(0);

    for (const workerCount of [2, 4]) {
      const jobs = planPairedSlices(opponents.length, games, workerCount, SEED, {
        out: swap.out,
        in: swap.in,
        scope: 'playset',
      });
      const slices = executeScrambled(jobs, {
        heroName: heroDeck.name,
        opponentNames: opponents.map((d) => d.name),
        pilotId: PILOT_ID,
      }) as PairedSliceResult[];
      const merged = mergeSwapFromSlices(slices, swap);
      expect(merged).toEqual(sequential);
      expect(JSON.stringify(merged)).toBe(JSON.stringify(sequential));
    }
  });

  it('pilot-ab: sliced pairs equal runPilotAb — and the control stays EXACTLY balanced', () => {
    const games = 4;
    const decks = [SAMPLE_DECKS[0]!, SAMPLE_DECKS[1]!, SAMPLE_DECKS[2]!].map((d) => loadDeck(d, pool));
    const sequential = runPilotAb({
      decks,
      pilots: freshPilots(), // same id both sides — the balance control
      registry,
      gamesPerOrientation: games,
      baseSeed: SEED,
    });
    expect(sequential.control).toBe(true);
    expect(sequential.balanced).toBe(true);

    const jobs = planPilotAbSlices(3, games, 2, SEED);
    const slices = executeScrambled(jobs, {
      deckNames: decks.map((d) => d.name),
      pilotAId: PILOT_ID,
      pilotBId: PILOT_ID,
    }) as PilotAbSliceResult[];
    const merged = mergePilotAbFromSlices(slices, {
      decks,
      pilotAId: PILOT_ID,
      pilotBId: PILOT_ID,
      gamesPerOrientation: games,
    });
    expect(merged).toEqual(sequential);
    expect(JSON.stringify(merged)).toBe(JSON.stringify(sequential));
    expect(merged.balanced).toBe(true);
  });

  it('pilot-ab: a real contest (heuristic vs random, odd game count) merges identically', () => {
    const games = 3; // odd on purpose — the on-the-play fairness has no even-count crutch
    const decks = [SAMPLE_DECKS[0]!, SAMPLE_DECKS[1]!].map((d) => loadDeck(d, pool));
    const ai = createDefaultAiRegistry();
    const sequential = runPilotAb({
      decks,
      pilots: { pilotA: ai.getPilot(PILOT_ID) as Pilot, pilotB: ai.getPilot('random') as Pilot },
      registry,
      gamesPerOrientation: games,
      baseSeed: SEED,
    });

    const jobs = planPilotAbSlices(1, games, 4, SEED);
    const slices = executeScrambled(jobs, {
      deckNames: decks.map((d) => d.name),
      pilotAId: PILOT_ID,
      pilotBId: 'random',
    }) as PilotAbSliceResult[];
    const merged = mergePilotAbFromSlices(slices, {
      decks,
      pilotAId: PILOT_ID,
      pilotBId: 'random',
      gamesPerOrientation: games,
    });
    expect(merged).toEqual(sequential);
    expect(JSON.stringify(merged)).toBe(JSON.stringify(sequential));
  });

  it('soak: anchored + split mixed ranges finish into the sequential report, printed form included', () => {
    const ai = createDefaultAiRegistry();
    const options = {
      pool,
      registry,
      pilot: ai.getPilot(PILOT_ID) as Pilot,
      mixedGames: 6,
      anchorAttempts: 1,
      baseSeed: SEED,
    };
    const sequential = runSoak(options);

    const anchored = runSoakAnchored(options);
    const mixedA = runSoakMixedRange(options, anchored.games, 0, 4);
    const mixedB = runSoakMixedRange(options, anchored.games, 4, 6);
    // cpuMillis is a resource MEASUREMENT, not a result — inject the sequential
    // run's value so the comparison covers everything deterministic.
    const merged = finishSoak(pool, [anchored, mixedA, mixedB], sequential.cpuMillis);

    expect(merged).toEqual(sequential);
    // Insertion order of the mechanics tally decides tie order in the printed
    // report; assert it explicitly (toEqual on Maps ignores order).
    expect([...merged.mechanicGames.entries()]).toEqual([...sequential.mechanicGames.entries()]);
    expect(formatSoakReport(merged)).toBe(formatSoakReport(sequential));
  });
});

describe('the planning arithmetic', () => {
  it('splitGameRange tiles [0, total) exactly, remainder on the leading chunks', () => {
    for (const [total, parts] of [
      [10, 3],
      [7, 7],
      [5, 12],
      [1, 1],
      [0, 4],
    ] as const) {
      const ranges = splitGameRange(total, parts);
      let cursor = 0;
      for (const r of ranges) {
        expect(r.gameStart).toBe(cursor);
        expect(r.gameEnd).toBeGreaterThan(r.gameStart);
        cursor = r.gameEnd;
      }
      expect(cursor).toBe(total);
      if (total > 0) {
        const sizes = ranges.map((r) => r.gameEnd - r.gameStart);
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('slicesPerUnit never cuts below the minimum slice size', () => {
    // 8 games can afford at most 2 slices of ≥4; even 12 hungry workers don't change that.
    expect(slicesPerUnit(1, 8, 12)).toBe(2);
    // Plenty of units already: one slice per unit.
    expect(slicesPerUnit(36, 100, 2)).toBe(1);
  });

  it('worker-count policies: explicit is capped by useful slices, auto by cores/games/units', () => {
    expect(explicitWorkerCount(8, 3)).toBe(3);
    expect(explicitWorkerCount(2, 100)).toBe(2);
    expect(explicitWorkerCount(0, 4)).toBe(1);

    const cores = 12;
    // A big run: limited by cores minus the host's share.
    expect(autoWorkerCount(100_000, 10_000, cores)).toBe(cores - HOST_RESERVED_CORES);
    // A run too small to pay one worker's startup stays sequential.
    expect(autoWorkerCount(AUTO_GAMES_PER_WORKER * 2 - 1, 10_000, cores)).toBe(1);
    // Exactly two workers' worth of games hires two.
    expect(autoWorkerCount(AUTO_GAMES_PER_WORKER * 2, 10_000, cores)).toBe(2);
    // Never more hands than units of work.
    expect(autoWorkerCount(100_000, 3, cores)).toBe(3);
    // One core: always sequential.
    expect(autoWorkerCount(100_000, 10_000, 1)).toBe(1);
  });

  it('maxUsefulSlices reflects the finest legal cut', () => {
    expect(maxUsefulSlices(7, 100)).toBe(7 * 25);
    expect(maxUsefulSlices(1, 3)).toBe(1); // below one slice minimum → still one unit
  });
});
