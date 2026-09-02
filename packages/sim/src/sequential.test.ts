/**
 * STOPPING EARLY MUST NOT CHANGE A SINGLE GAME (DESIGN §3.92).
 *
 * A group-sequential run plays its budget in windows and quits when the boundary
 * is crossed. That is only sound if the windows are the SAME games the whole run
 * would have played, in the same order, from the same seeds — otherwise "we
 * stopped early" silently becomes "we played a different experiment".
 *
 * Every game seeds off its ABSOLUTE (opponent × game) index, so [0,G) followed by
 * [G,2G) must equal [0,2G) exactly. These tests pin that, and pin the boundary
 * table against the peeking error it exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import { loadDeck } from './deck.js';
import type { MatchupPilots } from './matchup.js';
import { evaluateSwap } from './swap.js';
import {
  createParallelContext,
  executeParallelJob,
  mergeSwapFromSlices,
  planPairedSlices,
  type PairedSliceResult,
  type ParallelJob,
} from './parallel-slices.js';
import { planSequentialLooks, SUPPORTED_LOOK_COUNTS } from './sequential.js';

const PILOT_ID = HEURISTIC_PILOT_ID;
const SEED = 0xabcde;
const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function freshPilots(): MatchupPilots {
  const ai = createDefaultAiRegistry();
  return { pilotA: ai.getPilot(PILOT_ID) as Pilot, pilotB: ai.getPilot(PILOT_ID) as Pilot };
}

const baseDeck = SAMPLE_DECKS[0]!;
const oppDecks = [SAMPLE_DECKS[1]!, SAMPLE_DECKS[2]!];
const SWAP = { out: baseDeck.cards[0]!.cardId, in: oppDecks[0]!.cards[0]!.cardId };

/** Execute a plan through the same executor the worker entry uses. */
function execute(jobs: readonly ParallelJob[]): PairedSliceResult[] {
  const context = createParallelContext({
    heroName: baseDeck.name,
    opponentNames: oppDecks.map((d) => d.name),
    pilotId: PILOT_ID,
  });
  // Reversed: the pool returns results in job order however they complete.
  return [...jobs].reverse().map((job) => executeParallelJob(context, job)) as PairedSliceResult[];
}

describe('a windowed plan plays exactly the games the whole plan would', () => {
  const games = 6;

  it('two windows equal one full run, and equal evaluateSwap', () => {
    const hero = baseDeck;
    const opponents = oppDecks.map((d) => loadDeck(d, pool));
    const sequential = evaluateSwap(hero, SWAP, opponents, freshPilots(), games, SEED, pool, registry, {});

    const scope = sequential.scope;
    const whole = mergeSwapFromSlices(
      execute(planPairedSlices(opponents.length, games, 3, SEED, { ...SWAP, scope })),
      SWAP,
    );

    // The same run, cut into two windows the way a sequential stop would take it.
    const first = execute(
      planPairedSlices(opponents.length, games, 3, SEED, { ...SWAP, scope }, { gameStart: 0, gameEnd: 3 }),
    );
    const second = execute(
      planPairedSlices(opponents.length, games, 3, SEED, { ...SWAP, scope }, { gameStart: 3, gameEnd: games }),
    );
    const windowed = mergeSwapFromSlices([...first, ...second], SWAP);

    expect(windowed.paired).toEqual(sequential.paired);
    expect(whole.paired).toEqual(sequential.paired);
    // Byte identity, not just deep equality: same key order, same float bits.
    expect(JSON.stringify(windowed)).toBe(JSON.stringify(whole));
  });

  it('a window that covers everything is the full plan', () => {
    const opponents = oppDecks.map((d) => loadDeck(d, pool));
    const scope = evaluateSwap(baseDeck, SWAP, opponents, freshPilots(), games, SEED, pool, registry, {}).scope;
    const full = planPairedSlices(opponents.length, games, 3, SEED, { ...SWAP, scope });
    const windowed = planPairedSlices(opponents.length, games, 3, SEED, { ...SWAP, scope }, { gameStart: 0, gameEnd: games });
    expect(JSON.stringify(windowed)).toBe(JSON.stringify(full));
  });

  it('the first window really is a PREFIX — it plays fewer games, not different ones', () => {
    const opponents = oppDecks.map((d) => loadDeck(d, pool));
    const scope = evaluateSwap(baseDeck, SWAP, opponents, freshPilots(), games, SEED, pool, registry, {}).scope;
    const prefix = execute(
      planPairedSlices(opponents.length, games, 3, SEED, { ...SWAP, scope }, { gameStart: 0, gameEnd: 3 }),
    );
    const merged = mergeSwapFromSlices(prefix, SWAP);
    // Half the run, so half the paired games — and it must be a real, smaller run
    // rather than an empty one, or "stopped early" would be hiding a no-op.
    const total = merged.paired.bothWon + merged.paired.baseOnly + merged.paired.variantOnly + merged.paired.neither;
    expect(total).toBe(3 * opponents.length);
  });
});

describe('the stopping boundary is tabulated, never interpolated', () => {
  it('tightens the per-look threshold as looks are added', () => {
    const one = planSequentialLooks(100, 1).perLookAlpha;
    const four = planSequentialLooks(100, 4).perLookAlpha;
    // ⚠️ THE WHOLE POINT: more chances to stop must cost a stricter bar at each
    // one, or the run is simply peeking and the 5% is a fiction.
    expect(four).toBeLessThan(one);
    expect(one).toBe(0.05);
  });

  it('refuses a look count it has no boundary for', () => {
    expect(() => planSequentialLooks(100, 7)).toThrow(/no Pocock boundary/);
    expect(SUPPORTED_LOOK_COUNTS).toContain(4);
    expect(SUPPORTED_LOOK_COUNTS).not.toContain(7);
  });

  it('refuses an alpha it has no boundary for, rather than scaling one', () => {
    expect(() => planSequentialLooks(100, 4, 0.01)).toThrow(/tabulated for a two-sided alpha of 0.05/);
  });

  it('spaces the checkpoints evenly and ends exactly at the budget', () => {
    const plan = planSequentialLooks(200, 4);
    expect(plan.checkpoints).toEqual([50, 100, 150, 200]);
  });

  it('never repeats a checkpoint on a run too small to split', () => {
    // Three looks over two games cannot be three distinct checkpoints; a repeat
    // would spend a look of the error budget on no new information.
    const plan = planSequentialLooks(2, 3);
    expect(new Set(plan.checkpoints).size).toBe(plan.checkpoints.length);
    expect(plan.checkpoints[plan.checkpoints.length - 1]).toBe(2);
  });
});
