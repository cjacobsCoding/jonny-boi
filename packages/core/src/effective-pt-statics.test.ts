/**
 * STATICS WHOSE SELECTOR READS EFFECTIVE P/T — "creatures you control with
 * power or toughness 1 or less can't be blocked" (Tetsuko Umezawa), "…with
 * power 2 or less can't be blocked by creatures with power 3 or greater"
 * (Delney, Streetwise Lookout).
 *
 * The fidelity edge is the word EFFECTIVE. These read the number on the board,
 * not the number in the printed box — so an anthem lifts a creature OUT of the
 * selector, which is exactly what a player watching the board expects and what
 * a printed-box read gets wrong. Core settles every P/T layer first and folds
 * these afterwards, which is sound because such a static may grant KEYWORDS
 * ONLY (a P/T delta would need its own output as input).
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameState } from './index.js';
import { indexContinuous } from './internal/continuous.js';
import { effectiveKeywords } from './internal/stats.js';

/** Tetsuko's static, as the compiler emits it. */
const TETSUKO: CardDefinition = {
  id: 'tetsuko',
  name: 'Tetsuko Umezawa, Fugitive',
  types: ['creature'],
  power: 1,
  toughness: 3,
  statics: [
    {
      affects: { anyOfTypes: ['creature'], controller: 'you', maxEffectivePowerOrToughness: 1 },
      keywords: { unblockable: true },
      label: "creatures you control with power or toughness 1 or less can't be blocked",
    },
  ],
};

/** A plain anthem — the thing that can lift a creature out of the selector. */
const ANTHEM: CardDefinition = {
  id: 'anthem',
  name: 'Test Anthem',
  types: ['enchantment'],
  statics: [{ affects: { anyOfTypes: ['creature'], controller: 'you' }, power: 2, toughness: 2 }],
};

function creature(id: number, power: number, toughness: number): CardDefinition {
  return { id: `c${id}`, name: `Creature ${id}`, types: ['creature'], power, toughness };
}

function boardOf(defs: readonly CardDefinition[]): { state: GameState; ids: number[] } {
  const ids: number[] = [];
  const battlefield: CardInstance[] = defs.map((def, i) => {
    const instanceId = 10 + i;
    ids.push(instanceId);
    return {
      instanceId,
      def,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    } as CardInstance;
  });
  const state = {
    battlefield,
    stack: [],
    continuous: [],
    players: {
      A: { hand: [], library: [], graveyard: [], exile: [], command: [] },
      B: { hand: [], library: [], graveyard: [], exile: [], command: [] },
    },
  } as unknown as GameState;
  return { state, ids };
}

describe('a static selector that reads EFFECTIVE power/toughness', () => {
  it('reaches a 1/1 and skips a 2/2 — the printed board, read as printed', () => {
    const { state, ids } = boardOf([TETSUKO, creature(1, 1, 1), creature(2, 2, 2)]);
    const index = indexContinuous(state);
    const [, smallId, bigId] = ids as [number, number, number];
    expect(effectiveKeywords(state.battlefield[1]!, index.get(smallId) ?? undefined).unblockable).toBe(true);
    expect(effectiveKeywords(state.battlefield[2]!, index.get(bigId) ?? undefined).unblockable).toBeFalsy();
  });

  it('an ANTHEM lifts the creature OUT of the selector — the whole point of "effective"', () => {
    // The 1/1 becomes a 3/3 under the anthem, so neither stat is 1 or less any
    // more and the evasion stops applying. A printed-box read would keep it.
    const { state, ids } = boardOf([TETSUKO, creature(1, 1, 1), ANTHEM]);
    const index = indexContinuous(state);
    const smallId = ids[1]!;
    const mod = index.get(smallId);
    expect(mod?.power).toBe(2);
    expect(effectiveKeywords(state.battlefield[1]!, mod ?? undefined).unblockable).toBeFalsy();
  });

  it("Delney's blocker bound rides the same selector", () => {
    const DELNEY: CardDefinition = {
      id: 'delney',
      name: 'Delney, Streetwise Lookout',
      types: ['creature'],
      power: 1,
      toughness: 3,
      statics: [
        {
          affects: { anyOfTypes: ['creature'], controller: 'you', maxEffectivePower: 2 },
          keywords: { blockRestriction: { maxBlockerPower: 2 } },
          label: 'delney',
        },
      ],
    };
    const { state, ids } = boardOf([DELNEY, creature(1, 2, 2), creature(2, 5, 5)]);
    const index = indexContinuous(state);
    expect(effectiveKeywords(state.battlefield[1]!, index.get(ids[1]!) ?? undefined).blockRestriction).toEqual({
      maxBlockerPower: 2,
    });
    // The 5/5 is outside "power 2 or less" and gets nothing.
    expect(effectiveKeywords(state.battlefield[2]!, index.get(ids[2]!) ?? undefined).blockRestriction).toBeUndefined();
  });
});
