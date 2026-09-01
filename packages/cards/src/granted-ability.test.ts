/**
 * GRANTED ACTIVATED ABILITIES — "Creatures you control have \"{1}: …\"" and
 * "Equipped creature has \"…\"" (§3.62).
 *
 * Found by measuring the FULL card pool rather than a sample: 374 of the 31,091
 * paper cards are blocked by exactly this one mechanism, which made it the
 * largest coherent system available.
 *
 * The design point this pins is that a granted ability is not a second kind of
 * ability. It is compiled by the compiler's OWN activated-ability parser, it
 * rides the SAME `PermanentModification` an anthem uses, and it is read through
 * ONE accessor (`effectiveActivated`) that both the offer path and the apply
 * path call — because `abilityIndex` indexes exactly that list, and two readers
 * with different ideas of what index 1 means activate the wrong ability.
 */

import { describe, expect, it } from 'vitest';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';

function card(overrides: Partial<CompilableCard> & { name: string }): CompilableCard {
  return {
    id: `test:${overrides.name}`,
    manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
    oracleText: '',
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  };
}

const QUOTED = '{1}: This creature gets +1/+1 until end of turn.';

describe('a granted activated ability', () => {
  it('compiles on a GROUP, through the ordinary activated-ability parser', () => {
    const result = compileCard(card({ name: 'Test Rite', oracleText: `Creatures you control have "${QUOTED}"` }));
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const granted = result.definition.statics?.[0];
    expect(granted?.affects).toMatchObject({ anyOfTypes: ['creature'], controller: 'you' });
    // The SAME shape a printed ability has — cost + effects, nothing bespoke.
    expect(granted?.activated?.[0]?.cost).toEqual({ mana: { generic: 1 } });
    expect(granted?.activated?.[0]?.effects[0]?.primitive).toBe('pumpUntilEndOfTurn');
  });

  it('compiles on an ATTACHMENT, into the same modification an anthem uses', () => {
    const result = compileCard(
      card({
        name: 'Test Mantle',
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: ['Equipment'] },
        keywords: ['Equip'],
        oracleText: `Equipped creature has "${QUOTED}"\nEquip {2}`,
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.attachment?.modifies?.activated?.[0]?.cost).toEqual({ mana: { generic: 1 } });
  });

  it('a TYPAL grant is refused on a card that never prints the type', () => {
    // "All Slivers have …" on a card with no Sliver in its type line would be a
    // lord over a type it never claims — the same rule the typal anthem follows.
    const notASliver = compileCard(card({ name: 'Test Impostor', oracleText: `All Slivers have "${QUOTED}"` }));
    expect(notASliver.status).toBe('incomplete');

    const realSliver = compileCard(
      card({
        name: 'Test Sliver Lord',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Sliver'] },
        power: '2',
        toughness: '2',
        oracleText: `All Slivers have "${QUOTED}"`,
      }),
    );
    expect(realSliver.status, JSON.stringify(realSliver.missing)).toBe('complete');
    expect(realSliver.definition.statics?.[0]?.affects).toMatchObject({ anyOfSubtypes: ['Sliver'] });
  });

  it('a quoted ability the parser cannot read reports the whole card', () => {
    const result = compileCard(
      card({ name: 'Test Odd', oracleText: 'Creatures you control have "{1}: Become the monarch."' }),
    );
    expect(result.status).toBe('incomplete');
  });
});
