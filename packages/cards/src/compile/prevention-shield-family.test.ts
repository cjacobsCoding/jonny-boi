/**
 * THE SHIELD FAMILY — "Prevent the next N damage that would be dealt to ___
 * this turn."
 *
 * The single largest printed BODY in the activated-ability backlog: 114 clauses
 * across the corpus, 78 of them on cards whose only unread sentence is this one
 * (measured by `packages/cards/scripts/activated-blame.mjs`). The primitive
 * already existed — `preventDamage` has carried a `preventUpTo` ceiling since
 * the fog family — so what was missing was the sentence, not the mechanism.
 *
 * The defect this file guards is the one that makes the family worth refusing
 * until it is right: a SHIELD compiled as a FOG. "Prevent the next 1 damage"
 * absorbs one point and stops; a blanket prevention absorbs a Blightning, a
 * Wrath's worth of combat damage and an alpha strike. Every card here would
 * play strictly better than printed, and "complete" would say nothing about it.
 *
 * ⚠️ Every Oracle string below is copied from a real printed card in the corpus
 * (the card is named), because `dead-rule-sweep.mjs` exists for the other case:
 * a rule written from a remembered wording matches nothing and no test sees it.
 */

import { describe, expect, it } from 'vitest';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';

function card(
  overrides: Partial<CompilableCard> & { name: string; oracleText: string },
): CompilableCard {
  return {
    id: `id:${overrides.name}`,
    manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Cleric'] },
    power: 1,
    toughness: 1,
    keywords: [],
    ...overrides,
  } as CompilableCard;
}

/** The single effect ref a one-ability card's only activated ability carries. */
function soleEffect(printed: CompilableCard) {
  const result = compileCard(printed);
  expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
  const ability = (result.definition.activated ?? [])[0];
  expect(ability, 'expected exactly one activated ability').toBeDefined();
  expect(ability!.effects).toHaveLength(1);
  return ability!.effects[0]!;
}

/** One REAL printed card per row of the two recipient tables. */
const PRINTED_SHIELDS: ReadonlyArray<{
  readonly name: string;
  readonly oracleText: string;
  readonly amount: number;
  readonly expect: Record<string, unknown>;
}> = [
  {
    name: 'Barrenton Medic',
    oracleText: '{T}: Prevent the next 1 damage that would be dealt to any target this turn.',
    amount: 1,
    expect: { targeted: true, targets: 'any' },
  },
  {
    name: 'Oasis',
    oracleText: '{T}: Prevent the next 1 damage that would be dealt to target creature this turn.',
    amount: 1,
    expect: { targeted: true, targets: 'creature' },
  },
  {
    name: 'Noble Vestige',
    oracleText:
      '{T}: Prevent the next 1 damage that would be dealt to target player or planeswalker this turn.',
    amount: 1,
    expect: { targeted: true, targets: 'playerOrPlaneswalker' },
  },
  {
    name: 'Abuna Acolyte',
    oracleText:
      '{T}: Prevent the next 1 damage that would be dealt to target artifact creature this turn.',
    amount: 1,
    expect: { targeted: true, targets: 'artifactCreature' },
  },
  {
    name: 'Conservator',
    oracleText: '{3}, {T}: Prevent the next 2 damage that would be dealt to you this turn.',
    amount: 2,
    expect: { scope: 'you', recipientKind: 'player' },
  },
  {
    name: 'Decorated Griffin',
    oracleText: '{1}{W}: Prevent the next 1 combat damage that would be dealt to you this turn.',
    amount: 1,
    expect: { scope: 'you', recipientKind: 'player', combat: true },
  },
];

describe('the shield rows — one real printed card each', () => {
  for (const printed of PRINTED_SHIELDS) {
    it(`${printed.name} compiles to a CEILING of ${printed.amount}, not a fog`, () => {
      const ref = soleEffect(card({ name: printed.name, oracleText: printed.oracleText }));
      expect(ref.primitive).toBe('preventDamage');
      // The ceiling is the whole card. A missing or zero amount is the fog bug.
      expect(ref.params!.amount).toBe(printed.amount);
      for (const [key, value] of Object.entries(printed.expect)) {
        expect(ref.params![key], `params.${key}`).toBe(value);
      }
    });
  }
});

describe('the SELF shield names no target, so it can never fizzle', () => {
  it("Opal-Eye, Konda's Yojimbo binds the shield to its own source", () => {
    const ref = soleEffect(
      card({
        name: 'Opal-Eye, Konda\'s Yojimbo',
        oracleText:
          '{T}: Prevent the next 1 damage that would be dealt to Opal-Eye, Konda\'s Yojimbo this turn.',
      }),
    );
    expect(ref.primitive).toBe('preventDamage');
    expect(ref.params!.selfShield).toBe(true);
    // `targeted` would give the ability a targeting gate and a fizzle the
    // printed line does not have — the two params must never both be set.
    expect(ref.params!.targeted).toBeUndefined();
    expect(ref.params!.targets).toBeUndefined();
  });
});

describe('the fog is still a fog — the two shapes stay distinct', () => {
  it('"Prevent all combat damage that would be dealt this turn" carries NO ceiling', () => {
    const result = compileCard(
      card({
        name: 'Fog',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        oracleText: 'Prevent all combat damage that would be dealt this turn.',
      }),
    );
    expect(result.status).toBe('complete');
    const ref = result.definition.effects![0]!;
    expect(ref.primitive).toBe('preventDamage');
    expect(ref.params!.amount).toBeUndefined();
    expect(ref.params!.combat).toBe(true);
  });
});

describe('recipients outside the tables report rather than widen', () => {
  /**
   * Real printed cards the tables deliberately do not serve. A row that
   * swallowed any of these would guard more than the printed shield does.
   */
  const REFUSED: ReadonlyArray<{ name: string; oracleText: string }> = [
    // A typal narrowing core's restriction union cannot say.
    {
      name: 'Wandering Mage',
      oracleText:
        '{W}, {T}: Prevent the next 1 damage that would be dealt to target cleric or wizard creature this turn.',
    },
    // A supertype narrowing, likewise.
    {
      name: 'Eiganjo Castle',
      oracleText:
        '{W}, {T}, Sacrifice Eiganjo Castle: Prevent the next 2 damage that would be dealt to target legendary creature this turn.',
    },
    // "A source of your choice" — a second chooser the shield record has no field for.
    {
      name: 'Healing Grace',
      oracleText:
        '{T}: Prevent the next 3 damage that would be dealt to any target this turn by a source of your choice.',
    },
    // "Divided as you choose" across any number of targets.
    {
      name: 'Remedy',
      oracleText:
        '{T}: Prevent the next 4 damage that would be dealt this turn to any number of targets, divided as you choose.',
    },
  ];
  for (const printed of REFUSED) {
    it(`${printed.name} stays reported`, () => {
      expect(compileCard(card({ name: printed.name, oracleText: printed.oracleText })).status).toBe(
        'incomplete',
      );
    });
  }
});
