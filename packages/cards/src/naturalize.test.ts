/**
 * "DESTROY TARGET ARTIFACT OR ENCHANTMENT" — the naturalize pair, as its own
 * two-type restriction (`artifactOrEnchantment`).
 *
 * The fidelity edge: neither neighbour is a substitute. Widening to the
 * three-type Acidic Slime form would let Reclamation Sage hit a LAND the
 * printed card cannot; narrowing to `artifact` loses the enchantment half.
 */

import { describe, expect, it } from 'vitest';
import type { GameState } from '@jonny-boi/core';
import { isLegalTarget, legalTargetsFor } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';

function makeCard(overrides: Partial<CompilableCard> & { name: string }): CompilableCard {
  return {
    id: `test:${overrides.name}`,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: [], subtypes: [] },
    oracleText: '',
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  };
}

describe('the artifact-or-enchantment destroy', () => {
  it("compiles Reclamation Sage's ETB completely — optional, targeted, two types", () => {
    const result = compileCard(
      makeCard({
        name: 'Reclamation Sage',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Elf', 'Shaman'] },
        manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
        power: '2',
        toughness: '1',
        oracleText: 'When this creature enters, you may destroy target artifact or enchantment.',
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const trigger = result.definition.triggers?.[0];
    expect(trigger?.targets).toBe('artifactOrEnchantment');
    expect(trigger?.effects[0]?.primitive).toBe('mayEffects');
  });

  it('the restriction reaches both types and NEVER a land or a creature', () => {
    const perm = (id: number, types: string[]): Record<string, unknown> => ({
      instanceId: id,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
      def: { id: `d${id}`, name: `Perm ${id}`, types },
    });
    const s = {
      nextInstanceId: 100,
      battlefield: [perm(1, ['artifact']), perm(2, ['enchantment']), perm(3, ['land']), perm(4, ['creature'])],
      stack: [],
      continuous: [],
      players: {
        A: { exile: [], hand: [], graveyard: [], library: [], command: [] },
        B: { exile: [], hand: [], graveyard: [], library: [], command: [] },
      },
    } as unknown as GameState;
    expect(legalTargetsFor(s, 'artifactOrEnchantment', 'A')).toEqual([1, 2]);
    expect(isLegalTarget(s, 'artifactOrEnchantment', 3, 'A')).toBe(false);
    expect(isLegalTarget(s, 'artifactOrEnchantment', 4, 'A')).toBe(false);
  });
});
