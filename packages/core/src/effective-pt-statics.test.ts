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
 *
 * §3.146 adds the second shape that reads settled P/T — a granted BOUND that
 * reads the static SOURCE'S own power (Champion of Lambholt) — and the proof
 * that one settled pass is enough for both: the pass reads powers and writes
 * KEYWORDS, and nothing that produces a power reads a keyword, so its output
 * can never change its own input. `a fixpoint, proved by re-deriving it` below
 * executes that argument rather than asserting it in a comment.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameState } from './index.js';
import { aggregateFor, indexContinuous } from './internal/continuous.js';
import { effectiveKeywords, effectivePower } from './internal/stats.js';

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

/** Champion of Lambholt's static, as the compiler emits it. */
const CHAMPION: CardDefinition = {
  id: 'champion',
  name: 'Champion of Lambholt',
  types: ['creature'],
  power: 3,
  toughness: 3,
  statics: [
    {
      affects: { anyOfTypes: ['creature'], controller: 'you' },
      blockBoundFromSourcePower: 'minBlockerPower',
      label: "creatures with power less than ~'s power can't block creatures you control",
    },
  ],
};

describe("a granted BOUND that reads the static source's own power", () => {
  it("hands every creature you control a 'blockers need power at least mine' restriction", () => {
    const { state, ids } = boardOf([CHAMPION, creature(1, 1, 1)]);
    const index = indexContinuous(state);
    // Champion is 3/3, so a legal blocker needs power 3 — and the Champion is
    // itself one of "creatures you control" (the printed line has no "other").
    for (let i = 0; i < ids.length; i++) {
      expect(
        effectiveKeywords(state.battlefield[i]!, index.get(ids[i]!) ?? undefined).blockRestriction,
      ).toEqual({ minBlockerPower: 3 });
    }
  });

  it('the bound is the SETTLED power — an anthem on the Champion raises it', () => {
    const { state, ids } = boardOf([CHAMPION, creature(1, 1, 1), ANTHEM]);
    const index = indexContinuous(state);
    // The anthem makes the 3/3 Champion a 5/5, so the bound is 5, not the
    // printed 3. Reading the printed box here is the whole defect this guards.
    expect(effectiveKeywords(state.battlefield[1]!, index.get(ids[1]!) ?? undefined).blockRestriction).toEqual({
      minBlockerPower: 5,
    });
  });

  it('the bound follows +1/+1 counters, which is how the printed card grows', () => {
    const { state, ids } = boardOf([CHAMPION, creature(1, 1, 1)]);
    (state.battlefield[0] as { counters: Record<string, number> }).counters = { '+1/+1': 2 };
    const index = indexContinuous(state);
    expect(effectiveKeywords(state.battlefield[1]!, index.get(ids[1]!) ?? undefined).blockRestriction).toEqual({
      minBlockerPower: 5,
    });
  });

  it('two Champions are both in force — the stricter bound decides', () => {
    const bigger: CardDefinition = { ...CHAMPION, id: 'champion2', name: 'Champion Two', power: 6 };
    const { state, ids } = boardOf([CHAMPION, bigger, creature(1, 1, 1)]);
    const index = indexContinuous(state);
    expect(effectiveKeywords(state.battlefield[2]!, index.get(ids[2]!) ?? undefined).blockRestriction).toEqual({
      minBlockerPower: 6,
    });
  });

  it('an INERT-looking static with only a source bound is still applied', () => {
    // The generic inertness test sees no P/T delta and no keywords and would
    // skip the ability before it was ever deferred — the card compiling
    // 'complete' and doing nothing, which is this project's signature failure.
    const { state, ids } = boardOf([CHAMPION]);
    expect(
      effectiveKeywords(state.battlefield[0]!, indexContinuous(state).get(ids[0]!) ?? undefined).blockRestriction,
    ).toEqual({ minBlockerPower: 3 });
  });
});

describe('a fixpoint, proved by re-deriving it — the CR 613.8 loop that is not there', () => {
  /**
   * THE ADVERSARIAL CASE: two creatures whose statics each read a power the
   * other's grant could plausibly have moved, with an anthem moving both. If
   * the settled pass could feed itself, a second iteration would produce a
   * different answer — so the test runs that second iteration by hand, off the
   * index's OWN output, and demands the same numbers.
   *
   * This is the executable form of the argument in `indexContinuous`: the pass
   * reads POWERS and writes KEYWORDS, and nothing that produces a power reads a
   * keyword.
   */
  it('two source-power bounds reading each other settle in ONE pass', () => {
    const a: CardDefinition = { ...CHAMPION, id: 'champ-a', name: 'Champ A', power: 2, toughness: 2 };
    const b: CardDefinition = { ...CHAMPION, id: 'champ-b', name: 'Champ B', power: 4, toughness: 4 };
    const { state, ids } = boardOf([a, b, ANTHEM]);
    const index = indexContinuous(state);
    const powerOf = (i: number) => effectivePower(state.battlefield[i]!, index.get(ids[i]!) ?? undefined);
    expect(powerOf(0)).toBe(4); // 2 + the anthem's +2
    expect(powerOf(1)).toBe(6); // 4 + the anthem's +2
    // Iteration 2, recomputed HERE from the index's own output: each bound is
    // still the max of the two sources' settled powers, so the first pass was
    // already the fixpoint.
    const expected = Math.max(powerOf(0), powerOf(1));
    for (const i of [0, 1]) {
      expect(effectiveKeywords(state.battlefield[i]!, index.get(ids[i]!) ?? undefined).blockRestriction).toEqual({
        minBlockerPower: expected,
      });
    }
  });

  it('a selector-reading static and a bound-reading static cross-referencing settle too', () => {
    // Delney's filter reads the Champion's settled power to decide whether the
    // Champion is even in its set; the Champion's bound reads its own settled
    // power. Neither can move the other, because neither writes a P/T.
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
        },
      ],
    };
    const small: CardDefinition = { ...CHAMPION, id: 'champ-small', name: 'Small Champ', power: 2, toughness: 2 };
    const { state, ids } = boardOf([DELNEY, small]);
    const index = indexContinuous(state);
    // The Champion is a 2/2, so it IS within Delney's "power 2 or less" — it
    // carries BOTH bounds, merged to the strictest of each.
    expect(effectiveKeywords(state.battlefield[1]!, index.get(ids[1]!) ?? undefined).blockRestriction).toEqual({
      maxBlockerPower: 2,
      minBlockerPower: 2,
    });
    // And the settled power it was judged by is unchanged by either grant.
    expect(effectivePower(state.battlefield[1]!, index.get(ids[1]!) ?? undefined)).toBe(2);
  });
});

describe('indexContinuous and aggregateFor agree about a SETTLED-stats static', () => {
  /**
   * ⚠️ THE DEFECT THIS EXISTS FOR, and it had SHIPPED. `aggregateFor` is the
   * single-instance twin of `indexContinuous` and a live production path (the
   * engine's ability lookup, protection, intervening-if, the pilot's board
   * reads). It folded a settled-stats static UNCONDITIONALLY — `staticAppliesTo`
   * does not read the effective bounds — so Tetsuko made EVERY creature its
   * controller owned unblockable through that path while the index path got it
   * right. Two answers to one question, which is exactly the shape rule 12
   * forbids, and the older "same answer" test never saw it because its board
   * carried a plain anthem.
   *
   * A TABLE, so the next field that defers is a ROW here rather than a shape
   * nobody re-checked.
   */
  const shapes: ReadonlyArray<{ readonly name: string; readonly defs: readonly CardDefinition[] }> = [
    { name: 'maxEffectivePowerOrToughness (Tetsuko)', defs: [TETSUKO, creature(1, 1, 1), creature(2, 4, 4)] },
    { name: 'maxEffectivePowerOrToughness under an anthem', defs: [TETSUKO, creature(1, 1, 1), ANTHEM] },
    { name: 'blockBoundFromSourcePower (Champion)', defs: [CHAMPION, creature(1, 1, 1)] },
    { name: 'blockBoundFromSourcePower under an anthem', defs: [CHAMPION, creature(1, 1, 1), ANTHEM] },
  ];
  for (const shape of shapes) {
    it(`${shape.name}: every permanent reads the same both ways`, () => {
      const { state, ids } = boardOf(shape.defs);
      const index = indexContinuous(state);
      for (let i = 0; i < ids.length; i++) {
        // `NO_MOD` and "absent from the map" are the same answer, so the
        // comparison is on the effective READS — what every caller consumes.
        const perm = state.battlefield[i]!;
        const single = aggregateFor(state, ids[i]!);
        const bulk = index.get(ids[i]!);
        expect(effectiveKeywords(perm, single)).toEqual(effectiveKeywords(perm, bulk ?? undefined));
        expect(effectivePower(perm, single)).toBe(effectivePower(perm, bulk ?? undefined));
      }
    });
  }
});
