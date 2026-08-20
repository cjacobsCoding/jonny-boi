/**
 * COMPILING A SPEND RESTRICTION — "Spend this mana only to cast a creature
 * spell."
 *
 * The parser has to be exact in BOTH directions, because both failures print a
 * different card:
 *  - a restriction that is dropped makes Ancient Ziggurat a land whose mana pays
 *    for anything, which is strictly better than the printed one;
 *  - a restriction that is invented, or read too narrowly, makes it strictly
 *    worse — mana that can never be spent is as much a lie as mana that can be
 *    spent on anything.
 *
 * So every test here pins the DATA the rule produced, not merely that the card
 * compiled; and the refusals assert the reported gap names the thing that is
 * actually missing.
 */

import { describe, expect, it } from 'vitest';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';

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

function land(name: string, oracleText: string): CompilableCard {
  return makeCard({ name, typeLine: { supertypes: [], types: ['Land'], subtypes: [] }, oracleText });
}

function compiled(card: CompilableCard) {
  const result = compileCard(card);
  expect(result.status, `${card.name}: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result;
}

function gapsOf(card: CompilableCard): string {
  const result = compileCard(card);
  expect(result.status, `${card.name} unexpectedly compiled`).toBe('incomplete');
  return result.missing.map((m) => m.missingEngineSystem).join(' | ');
}

describe('the printed forms that compile', () => {
  it('Ancient Ziggurat: any colour, creature spells only', () => {
    const result = compiled(
      land(
        'Ancient Ziggurat',
        '{T}: Add one mana of any color. Spend this mana only to cast a creature spell.',
      ),
    );
    expect(result.definition.manaAbilities).toEqual([
      {
        produces: [{ W: 1 }, { U: 1 }, { B: 1 }, { R: 1 }, { G: 1 }],
        spendRestriction: {
          label: 'only to cast a creature spell',
          allow: [{ purpose: 'cast', types: ['creature'] }],
        },
      },
    ]);
  });

  it('Somberwald Sage: the production payload is the ordinary one, restricted', () => {
    const result = compiled(
      makeCard({
        name: 'Somberwald Sage',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Druid'] },
        power: 1,
        toughness: 1,
        manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
        oracleText:
          '{T}: Add three mana of any one color. Spend this mana only to cast creature spells.',
      }),
    );
    // Five modes of THREE — one tap, one colour — each carrying the restriction.
    expect(result.definition.manaAbilities?.[0]?.produces).toEqual([
      { W: 3 },
      { U: 3 },
      { B: 3 },
      { R: 3 },
      { G: 3 },
    ]);
    expect(result.definition.manaAbilities?.[0]?.spendRestriction?.allow).toEqual([
      { purpose: 'cast', types: ['creature'] },
    ]);
  });

  it('Power Depot: the printed "or" becomes TWO clauses, one per purpose', () => {
    const result = compiled(
      makeCard({
        name: 'Power Depot',
        typeLine: { supertypes: [], types: ['Artifact', 'Land'], subtypes: [] },
        oracleText:
          '{T}: Add {C}.\n{T}: Add one mana of any color. Spend this mana only to cast artifact spells or activate abilities of artifacts.',
      }),
    );
    const restricted = result.definition.manaAbilities?.[1];
    expect(restricted?.spendRestriction?.allow).toEqual([
      { purpose: 'cast', types: ['artifact'] },
      { purpose: 'activate', types: ['artifact'] },
    ]);
  });

  it('Eldrazi Temple: "colorless Eldrazi" is a colour test AND a subtype test', () => {
    const result = compiled(
      land(
        'Eldrazi Temple',
        '{T}: Add {C}.\n{T}: Add {C}{C}. Spend this mana only to cast colorless Eldrazi spells or activate abilities of colorless Eldrazi.',
      ),
    );
    expect(result.definition.manaAbilities?.[1]).toEqual({
      produces: [{ C: 2 }],
      spendRestriction: {
        label:
          'only to cast colorless eldrazi spells or activate abilities of colorless eldrazi',
        allow: [
          { purpose: 'cast', subtypes: ['eldrazi'], colorless: true },
          { purpose: 'activate', subtypes: ['eldrazi'], colorless: true },
        ],
      },
    });
  });

  it('Maelstrom of the Spirit Dragon: a verbless second alternative inherits "cast"', () => {
    // "…only to cast a Dragon spell OR AN OMEN SPELL". Reading the second half as
    // an activation would be a silently different card.
    const result = compileCard(
      land(
        'Maelstrom of the Spirit Dragon',
        '{T}: Add {C}.\n{T}: Add one mana of any color. Spend this mana only to cast a Dragon spell or an Omen spell.',
      ),
    );
    expect(result.definition.manaAbilities?.[1]?.spendRestriction?.allow).toEqual([
      { purpose: 'cast', subtypes: ['dragon'] },
      { purpose: 'cast', subtypes: ['omen'] },
    ]);
  });

  it('Giada: "an Angel spell" is a subtype with no type word', () => {
    const result = compiled(
      makeCard({
        name: 'Giada, Font of Hope',
        typeLine: { supertypes: ['Legendary'], types: ['Creature'], subtypes: ['Angel'] },
        power: 2,
        toughness: 2,
        manaCost: { generic: 1, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        oracleText: 'Flying, vigilance\n{T}: Add {W}. Spend this mana only to cast an Angel spell.',
        keywords: ['Flying', 'Vigilance'],
      }),
    );
    expect(result.definition.manaAbilities?.[0]?.spendRestriction?.allow).toEqual([
      { purpose: 'cast', subtypes: ['angel'] },
    ]);
  });

  it('"a legendary spell" compiles as the supertype test', () => {
    const result = compiled(
      land('Test Legendary Source', '{T}: Add one mana of any color. Spend this mana only to cast a legendary spell.'),
    );
    expect(result.definition.manaAbilities?.[0]?.spendRestriction?.allow).toEqual([
      { purpose: 'cast', legendary: true },
    ]);
  });
});

describe('what the parser must REFUSE, and what it says instead', () => {
  it('"of the chosen type" names the remembered choice, not the spend restriction', () => {
    const gap = gapsOf(
      land(
        'Unclaimed Territory',
        'As this land enters, choose a creature type.\n{T}: Add {C}.\n{T}: Add one mana of any color. Spend this mana only to cast a creature spell of the chosen type.',
      ),
    );
    expect(gap).toContain('CHOSEN AS THE PERMANENT ENTERS');
    // A restriction with the chosen type quietly dropped would be Unclaimed
    // Territory with no creature-type clause at all — a strictly better land.
    expect(gap).not.toContain('a SPEND RESTRICTION on produced mana');
  });

  it('"and that spell can\'t be countered" is reported — counterspells are real here', () => {
    const gap = gapsOf(
      makeCard({
        name: 'Delighted Halfling',
        typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Halfling', 'Citizen'] },
        power: 1,
        toughness: 2,
        manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
        oracleText:
          "{T}: Add {C}.\n{T}: Add one mana of any color. Spend this mana only to cast a legendary spell, and that spell can't be countered.",
      }),
    );
    expect(gap).toContain('CANNOT BE COUNTERED');
  });

  it('a restriction that restricts nothing checkable is refused, not compiled as vacuous', () => {
    const gap = gapsOf(
      land('Test Vacuous', '{T}: Add {G}. Spend this mana only to cast a spell.'),
    );
    expect(gap).toContain('SPEND-RESTRICTION wording');
  });

  it('an unread production payload reports the WORDING, not a missing system', () => {
    const gap = gapsOf(
      land(
        'Test Combination',
        '{T}: Add two mana in any combination of colors. Spend this mana only to cast creature spells.',
      ),
    );
    expect(gap).toContain('restricted mana itself is implemented');
  });
});

describe('the commander family is reported by name, never faked', () => {
  it("Command Tower names the COMMANDER'S COLOR IDENTITY specifically", () => {
    const gap = gapsOf(
      land('Command Tower', "{T}: Add one mana of any color in your commander's color identity."),
    );
    expect(gap).toContain("COMMANDER'S COLOR IDENTITY");
  });

  it('"any type that land produced" is reported as the mana-DOUBLING trigger it is', () => {
    // A different system from the commander one, and it was previously reported
    // together with it — which hid that one is ordinary engine work and the other
    // is a format decision.
    const gap = gapsOf(
      makeCard({
        name: "Mirari's Wake",
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        manaCost: { generic: 3, W: 1, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
        oracleText:
          'Creatures you control get +1/+1.\nWhenever you tap a land for mana, add one mana of any type that land produced.',
      }),
    );
    expect(gap).toContain('mana-DOUBLING trigger');
    expect(gap).not.toContain('commander');
  });
});
