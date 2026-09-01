/**
 * "A AND B" MEANS ONE THING — the conjunction helper is shared (§3.60).
 *
 * `compileConjunction` splits a printed sentence that joins two clauses the
 * table already implements ("Draw two cards and create two Treasure tokens").
 * It existed, but only `compileTriggerBody` called it — so the identical
 * sentence compiled inside a trigger and reported on a spell's own line. That
 * is the DRY failure this file pins: one helper, called from every place a
 * clause is compiled, or "and" quietly means two different things.
 *
 * Measured honestly before the change: a text scan suggested 49 candidate
 * cards, but the strict test (BOTH halves must compile alone) predicted 5, and
 * the actual corpus delta was 5. The change is kept for the shared meaning, not
 * for the count.
 */

import { describe, expect, it } from 'vitest';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';

function card(oracleText: string, types: readonly string[] = ['Instant']): CompilableCard {
  return {
    id: 'test:conj',
    name: 'Probe Card',
    manaCost: { generic: 1, W: 0, U: 0, B: 1, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: [...types], subtypes: [] },
    oracleText,
    power: types.includes('Creature') ? '2' : null,
    toughness: types.includes('Creature') ? '2' : null,
    keywords: [],
  };
}

const JOINED = 'Draw two cards and create two Treasure tokens.';

describe('the conjunction helper is shared by every clause compiler', () => {
  it("compiles the joined sentence on a SPELL's own line", () => {
    const result = compileCard(card(JOINED));
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects?.map((ref) => ref.primitive)).toEqual([
      'drawCards',
      'createPredefinedToken',
    ]);
  });

  it('compiles the SAME sentence inside a trigger body, to the same refs', () => {
    const result = compileCard(card(`When this creature enters, ${JOINED.toLowerCase()}`, ['Creature']));
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.triggers?.[0]?.effects.map((ref) => ref.primitive)).toEqual([
      'drawCards',
      'createPredefinedToken',
    ]);
  });

  it('still REFUSES a conjunction whose halves do not both compile', () => {
    // The right half is not a clause this table implements, so the whole line
    // reports — splitting on "and" must never salvage half a card.
    expect(compileCard(card('Draw two cards and become the monarch.')).status).toBe('incomplete');
  });
});
