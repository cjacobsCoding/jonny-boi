/**
 * The pure half of the parallel runner: how many workers we ask for, how a run is
 * cut into shards, and which opponents a run faces.
 *
 * These guard the properties the determinism proof stands on — that a plan TILES
 * the run exactly (no game played twice, none dropped) and that the opponent
 * order a shard index refers to is stable — without playing a single game.
 */
import { describe, expect, it } from 'vitest';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import {
  FALLBACK_WORKER_COUNT,
  MAX_POOL_WORKERS,
  MIN_GAMES_PER_SHARD,
  UI_RESERVED_CORES,
  parseWorkerCountOverride,
  poolWorkerCount,
} from './pool-config.js';
import {
  planBaseSlotShards,
  planGauntletShards,
  planPairedShards,
  planVariantSliceShards,
  shardsPerGroup,
  shardsPerMatchup,
  splitGameRange,
  splitSlotRange,
  totalGauntletGames,
  totalPairedGames,
  estimateSuggestionGames,
  type ArmSlice,
} from './plan.js';
import { resolveOpponentNames } from './opponents.js';
import { DEFAULT_PILOT_ID } from './pilots.js';
import type { ShardContext } from './shard-protocol.js';
import type { PairedBaseRecord } from '@jonny-boi/sim';

const hero = { name: 'Hero', archetype: 'Hero', cards: [{ cardId: 'x', count: 60 }] };

function contextWith(opponentNames: readonly string[]): ShardContext {
  return { hero, opponentNames, seed: 0xc0ffee, pilotId: DEFAULT_PILOT_ID };
}

describe('poolWorkerCount', () => {
  it('leaves a core for the UI', () => {
    expect(poolWorkerCount(12)).toBe(12 - UI_RESERVED_CORES);
    expect(poolWorkerCount(4)).toBe(4 - UI_RESERVED_CORES);
  });

  it('degrades to a single worker when hardwareConcurrency is unavailable', () => {
    expect(poolWorkerCount(undefined)).toBe(FALLBACK_WORKER_COUNT);
    expect(poolWorkerCount(Number.NaN)).toBe(FALLBACK_WORKER_COUNT);
  });

  it('still gives one worker on a single-core host (the sim never runs on the UI thread)', () => {
    expect(poolWorkerCount(1)).toBe(1);
    expect(poolWorkerCount(0)).toBe(1);
  });

  it('caps the pool however many cores the machine reports', () => {
    expect(poolWorkerCount(256)).toBe(MAX_POOL_WORKERS);
  });

  it('honours an explicit override, clamped into range', () => {
    expect(poolWorkerCount(12, 1)).toBe(1);
    expect(poolWorkerCount(12, 3)).toBe(3);
    expect(poolWorkerCount(12, 0)).toBe(1);
    expect(poolWorkerCount(12, 9999)).toBe(MAX_POOL_WORKERS);
  });

  it('reads the override off a query string, ignoring anything that is not a number', () => {
    expect(parseWorkerCountOverride('?simWorkers=1')).toBe(1);
    expect(parseWorkerCountOverride('?other=2&simWorkers=6')).toBe(6);
    expect(parseWorkerCountOverride('?simWorkers=lots')).toBeUndefined();
    expect(parseWorkerCountOverride('')).toBeUndefined();
  });
});

describe('splitGameRange', () => {
  it('tiles the whole range with no gap and no overlap', () => {
    for (const total of [1, 5, 10, 37, 100]) {
      for (const parts of [1, 2, 3, 7, 12]) {
        const ranges = splitGameRange(total, parts);
        expect(ranges[0]?.gameStart).toBe(0);
        expect(ranges[ranges.length - 1]?.gameEnd).toBe(total);
        for (let i = 1; i < ranges.length; i++) {
          expect(ranges[i]?.gameStart).toBe(ranges[i - 1]?.gameEnd);
        }
        const covered = ranges.reduce((n, r) => n + (r.gameEnd - r.gameStart), 0);
        expect(covered).toBe(total);
      }
    }
  });

  it('never emits an empty range, and balances to within one game', () => {
    const ranges = splitGameRange(10, 4);
    const sizes = ranges.map((r) => r.gameEnd - r.gameStart);
    expect(Math.min(...sizes)).toBeGreaterThan(0);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it('has nothing to split when there are no games', () => {
    expect(splitGameRange(0, 8)).toEqual([]);
  });
});

describe('shardsPerMatchup', () => {
  it('splits a ONE-opponent run so it can still use every core', () => {
    // The headline case: a single opponent must not mean a single busy worker.
    expect(shardsPerMatchup(1, 200, 11)).toBeGreaterThanOrEqual(11);
  });

  it('does not shard below the minimum batch size', () => {
    const games = MIN_GAMES_PER_SHARD * 2;
    expect(shardsPerMatchup(1, games, 11)).toBe(2);
    expect(shardsPerMatchup(1, MIN_GAMES_PER_SHARD - 1, 11)).toBe(1);
  });

  it('does not over-split when opponents alone already outnumber the workers', () => {
    expect(shardsPerMatchup(24, 100, 2)).toBe(1);
  });
});

describe('planGauntletShards', () => {
  it('covers every game of every matchup exactly once', () => {
    const context = contextWith(['A', 'B', 'C']);
    const gamesPerOpponent = 50;
    for (const workers of [1, 2, 11, 12]) {
      const jobs = planGauntletShards(context, gamesPerOpponent, workers);
      expect(totalGauntletGames(jobs)).toBe(3 * gamesPerOpponent);
      for (let opponentIndex = 0; opponentIndex < 3; opponentIndex++) {
        const mine = jobs.filter((j) => j.opponentIndex === opponentIndex);
        const played = new Set<number>();
        for (const job of mine) {
          for (let g = job.gameStart; g < job.gameEnd; g++) {
            expect(played.has(g)).toBe(false);
            played.add(g);
          }
        }
        expect(played.size).toBe(gamesPerOpponent);
      }
    }
  });

  it('produces more shards with more workers, but the same total work', () => {
    const context = contextWith(['A']);
    const one = planGauntletShards(context, 120, 1);
    const many = planGauntletShards(context, 120, 11);
    expect(many.length).toBeGreaterThan(one.length);
    expect(totalGauntletGames(many)).toBe(totalGauntletGames(one));
  });
});

describe('planPairedShards', () => {
  it('keeps base and variant of a game index in the SAME shard (common random numbers)', () => {
    // A paired shard's unit is the PAIR: a shard covering game indices [a,b)
    // plays both arms of every index in it, so no plan can ever separate them.
    const context = contextWith(['A', 'B']);
    const jobs = planPairedShards(context, { outCardId: 'o', inCardId: 'i' }, 40, 12, 7, null);
    // Two games per pair — the honest game count the progress bar uses.
    expect(totalPairedGames(jobs)).toBe(2 * 2 * 40);
    for (const job of jobs) expect(job.swapSeed).toBe(7);
  });
});

// --- the adaptive search's two per-round phases ---------------------------------

describe('splitSlotRange', () => {
  it('tiles a half-open slot range with no gap and no overlap', () => {
    for (const [start, end] of [[0, 10], [26, 52], [7, 8], [100, 420]] as const) {
      for (const parts of [1, 3, 12]) {
        const ranges = splitSlotRange(start, end, parts);
        expect(ranges[0]?.slotStart).toBe(start);
        expect(ranges[ranges.length - 1]?.slotEnd).toBe(end);
        for (let i = 1; i < ranges.length; i++) {
          expect(ranges[i]?.slotStart).toBe(ranges[i - 1]?.slotEnd);
        }
      }
    }
  });

  it('has nothing to split when a round adds no depth', () => {
    expect(splitSlotRange(40, 40, 12)).toEqual([]);
  });
});

describe('planBaseSlotShards', () => {
  it('covers every new base slot exactly once, and spreads it over the workers', () => {
    const context = contextWith(['A', 'B']);
    const jobs = planBaseSlotShards(context, 99, 26, 152, 11);
    expect(jobs.length).toBeGreaterThanOrEqual(11);
    const played = new Set<number>();
    for (const job of jobs) {
      expect(job.runSeed).toBe(99);
      for (let slot = job.slotStart; slot < job.slotEnd; slot++) {
        // Playing one base slot twice would double-count the base arm and break
        // the "base games played once for the whole run" guarantee.
        expect(played.has(slot)).toBe(false);
        played.add(slot);
      }
    }
    expect(played.size).toBe(152 - 26);
  });

  it('plans nothing when the round needs no new base games', () => {
    expect(planBaseSlotShards(contextWith(['A']), 1, 40, 40, 12)).toEqual([]);
  });
});

describe('planVariantSliceShards', () => {
  const context = contextWith(['A', 'B']);
  const record: PairedBaseRecord = { heroWon: true, leftLibrary: [], libraryDisturbed: false };
  const arm = (key: string, fromSlot: number, toSlot: number): ArmSlice => ({
    candidateKey: key,
    outCardId: 'o',
    inCardId: 'i',
    outName: 'O',
    inName: 'I',
    fromSlot,
    toSlot,
  });

  it('cuts WITHIN an arm, so a two-survivor late round still fills the machine', () => {
    // This is the whole reason slices exist. Handing each survivor one shard would
    // run the deepest, most expensive round of the search on two cores.
    const jobs = planVariantSliceShards(context, 7, [arm('a', 52, 208), arm('b', 52, 208)], 11, () => record);
    expect(jobs.length).toBeGreaterThanOrEqual(11);
    expect(jobs.filter((j) => j.candidateKey === 'a').length).toBeGreaterThan(1);
  });

  it('covers each arm’s outstanding slots exactly once', () => {
    const arms = [arm('a', 0, 26), arm('b', 0, 26), arm('c', 13, 26)];
    const jobs = planVariantSliceShards(context, 7, arms, 12, () => record);
    for (const { candidateKey, fromSlot, toSlot } of arms) {
      const played = new Set<number>();
      for (const job of jobs.filter((j) => j.candidateKey === candidateKey)) {
        for (let slot = job.slotStart; slot < job.slotEnd; slot++) {
          expect(played.has(slot)).toBe(false);
          played.add(slot);
        }
      }
      expect(played.size).toBe(toSlot - fromSlot);
    }
  });

  it('carries the base records for exactly its own slots, so a shard is self-contained', () => {
    // A shard the pool retries on a fresh worker must not need the round replayed,
    // and it cannot apply the identical-game skip without these.
    const jobs = planVariantSliceShards(context, 7, [arm('a', 10, 40)], 4, (slot) => ({
      heroWon: slot % 2 === 0,
      leftLibrary: [slot],
      libraryDisturbed: false,
    }));
    for (const job of jobs) {
      expect(job.baseRecords).toHaveLength(job.slotEnd - job.slotStart);
      job.baseRecords.forEach((rec, i) => {
        expect(rec.leftLibrary).toEqual([job.slotStart + i]);
      });
    }
  });

  it('plans nothing for an arm that is already at depth', () => {
    expect(planVariantSliceShards(context, 7, [arm('a', 26, 26)], 12, () => record)).toEqual([]);
  });
});

describe('shardsPerGroup', () => {
  it('is the same arithmetic matchups and search arms both need', () => {
    expect(shardsPerGroup).toBe(shardsPerMatchup);
    // Two survivors on eleven workers: split each one, do not run at two cores.
    expect(shardsPerGroup(2, 200, 11)).toBeGreaterThanOrEqual(11 / 2);
  });
});

describe('resolveOpponentNames', () => {
  it('defaults to the whole gauntlet, minus the hero', () => {
    const heroName = SAMPLE_DECKS[0]?.name as string;
    const names = resolveOpponentNames([], heroName);
    expect(names).not.toContain(heroName);
    expect(names.length).toBe(SAMPLE_DECKS.length - 1);
  });

  it('ignores an unknown name rather than crashing the run', () => {
    const known = SAMPLE_DECKS[1]?.name as string;
    expect(resolveOpponentNames([known, 'A Deck That Was Renamed'], 'Hero')).toEqual([known]);
  });

  it('orders opponents canonically, so re-picking them in another order cannot move a seed', () => {
    // Opponent INDEX drives the matchup seed, so selection order must not reach it.
    const picked = [SAMPLE_DECKS[3]?.name, SAMPLE_DECKS[1]?.name] as string[];
    const forward = resolveOpponentNames(picked, 'Hero');
    const reversed = resolveOpponentNames([...picked].reverse(), 'Hero');
    expect(forward).toEqual(reversed);
    expect(forward).toEqual([SAMPLE_DECKS[1]?.name, SAMPLE_DECKS[3]?.name]);
  });
});

/**
 * The pre-flight game count the UI multiplies by a pilot's cost to answer "is this
 * run a moment or an afternoon?". It is genuinely an estimate; what must hold is
 * that it is MONOTONE in both sliders and never zero, because those are the
 * properties a user reasons with while dragging them.
 */
describe('estimateSuggestionGames', () => {
  it('grows with both the candidate cap and the depth', () => {
    const base = estimateSuggestionGames(8, 60);
    expect(base).toBeGreaterThan(0);
    expect(estimateSuggestionGames(16, 60)).toBeGreaterThan(base);
    expect(estimateSuggestionGames(8, 120)).toBeGreaterThan(base);
  });

  it('always plays at least the base arm plus one candidate at full depth', () => {
    // One shared base game per slot, one variant game per surviving arm per slot —
    // so a single candidate played to N slots is already 2N games.
    const depth = 40;
    expect(estimateSuggestionGames(1, depth)).toBeGreaterThanOrEqual(2 * depth);
  });

  it('is total for degenerate inputs rather than returning NaN', () => {
    expect(estimateSuggestionGames(0, 0)).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(estimateSuggestionGames(-5, 10))).toBe(true);
  });
});
