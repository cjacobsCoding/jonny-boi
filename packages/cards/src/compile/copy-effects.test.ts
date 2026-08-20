/**
 * The COPY rule table (CR 706) — what compiles, what reports, and why.
 *
 * The contract this file defends is the one the whole compiler rests on: a copy
 * card's identity is *what it may copy* and *how the copy differs*, so a
 * selector or an "except" clause the table only half-read would produce a card
 * that is not the printed one — and a copy card is exactly the kind that would
 * be hard to notice playing wrong. Every negative case below therefore asserts
 * BOTH that the card reports and that the reported reason names the real
 * residual, not "copying is missing".
 */

import { describe, expect, it } from 'vitest';
import { compileCard } from './index.js';
import type { CompilableCard } from './types.js';

/** A minimal compilable record — only the fields the rule table reads. */
function card(partial: {
  name: string;
  oracleText: string;
  types?: readonly string[];
  subtypes?: readonly string[];
  power?: number | null;
  toughness?: number | null;
}): CompilableCard {
  return {
    id: `copy-test-${partial.name.toLowerCase().replace(/[^a-z]+/g, '-')}`,
    name: partial.name,
    manaCost: { generic: 2, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: {
      supertypes: [],
      types: [...(partial.types ?? ['Creature'])],
      subtypes: [...(partial.subtypes ?? [])],
    },
    oracleText: partial.oracleText,
    power: partial.power ?? 0,
    toughness: partial.toughness ?? 0,
    keywords: [],
  };
}

function compiled(partial: Parameters<typeof card>[0]) {
  return compileCard(card(partial));
}

describe('the selector — WHICH objects may be copied', () => {
  it('reads "any <type> on the battlefield" into a card filter', () => {
    const result = compiled({
      name: 'Sculpting Test',
      types: ['Artifact'],
      power: null,
      toughness: null,
      oracleText: 'You may have this artifact enter as a copy of any artifact on the battlefield.',
    });
    expect(result.status).toBe('complete');
    expect(result.definition.copyAsEnters).toEqual({ filter: { anyOfTypes: ['artifact'] } });
  });

  it('reads a two-type selector ("any artifact or enchantment")', () => {
    const result = compiled({
      name: 'Mirror Test',
      types: ['Enchantment'],
      power: null,
      toughness: null,
      oracleText: 'You may have this enchantment enter as a copy of any artifact or enchantment on the battlefield.',
    });
    expect(result.status).toBe('complete');
    expect(result.definition.copyAsEnters?.filter).toEqual({ anyOfTypes: ['artifact', 'enchantment'] });
  });

  it('reads "any nonland permanent" as an EXCLUSION, not as a type list', () => {
    const result = compiled({
      name: 'Impersonator Test',
      oracleText: 'You may have this creature enter as a copy of any nonland permanent on the battlefield.',
    });
    expect(result.status).toBe('complete');
    expect(result.definition.copyAsEnters?.filter).toEqual({ noneOfTypes: ['land'] });
  });

  it('reads "a <type> you control" as a controller restriction', () => {
    const result = compiled({
      name: 'Mimic Test',
      oracleText: "You may have this creature enter as a copy of a creature you control, except it's a Shapeshifter Rogue in addition to its other types.",
    });
    expect(result.status).toBe('complete');
    expect(result.definition.copyAsEnters?.whose).toBe('you');
    expect(result.definition.copyAsEnters?.except?.addSubtypes).toEqual(['Shapeshifter', 'Rogue']);
  });

  it('reads "any land card in a GRAVEYARD", carrying the zone', () => {
    const result = compiled({
      name: 'Echoing Test',
      types: ['Land'],
      power: null,
      toughness: null,
      oracleText:
        "You may have this land enter tapped as a copy of any land card in a graveyard, except it's a Cave in addition to its other types.",
    });
    expect(result.status).toBe('complete');
    expect(result.definition.copyAsEnters?.from).toBe('graveyard');
    // "enter TAPPED" is carried as an exception, not as the card's own
    // `entersTapped`: the copied land replaces this card's characteristics
    // entirely, so the printed word has to survive that replacement.
    expect(result.definition.copyAsEnters?.except?.entersTapped).toBe(true);
    expect(result.definition.copyAsEnters?.except?.addSubtypes).toEqual(['Cave']);
  });

  it('REPORTS a selector outside the closed table (Mockingbird mana-value bound)', () => {
    const result = compiled({
      name: 'Mocking Test',
      oracleText:
        "You may have this creature enter as a copy of any creature on the battlefield with mana value less than or equal to the amount of mana spent to cast this creature, except it's a Bird in addition to its other types and it has flying.",
    });
    expect(result.status).toBe('incomplete');
    // …and the reason names the real residual — the missing FACT, not the system.
    expect(result.missing[0]?.missingEngineSystem).toMatch(/AMOUNT OF MANA SPENT/);
    expect(result.definition.copyAsEnters).toBeUndefined();
  });
});

describe('the "except …" tail — how the copy differs (CR 706.3)', () => {
  it('adds a card TYPE ("it is an artifact in addition to its other types")', () => {
    const result = compiled({
      name: 'Metamorph Test',
      types: ['Artifact', 'Creature'],
      oracleText:
        "You may have this creature enter as a copy of any artifact or creature on the battlefield, except it's an artifact in addition to its other types.",
    });
    expect(result.status).toBe('complete');
    expect(result.definition.copyAsEnters?.except?.addTypes).toEqual(['artifact']);
  });

  it('reads all three of Spark Double clauses in one line', () => {
    const result = compiled({
      name: 'Spark Test',
      oracleText:
        "You may have this creature enter as a copy of a creature or planeswalker you control, except it enters with an additional +1/+1 counter on it if it's a creature, it enters with an additional loyalty counter on it if it's a planeswalker, and it isn't legendary.",
    });
    expect(result.status).toBe('complete');
    const except = result.definition.copyAsEnters?.except;
    expect(except?.extraCounters).toEqual({ '+1/+1': 1 });
    expect(except?.extraLoyalty).toBe(1);
    // `false`, NOT absent: absent means "keep whatever the copied card printed",
    // which would hand a player a second copy of a legend they should lose.
    expect(except?.legendary).toBe(false);
  });

  it('REPORTS an "except … it has \'<ability>\'" tail rather than dropping the drawback', () => {
    const result = compiled({
      name: 'Phantasmal Test',
      oracleText:
        'You may have this creature enter as a copy of any creature on the battlefield, except it\'s an Illusion in addition to its other types and it has "When this creature becomes the target of a spell or ability, sacrifice it."',
    });
    // Dropping the sacrifice trigger would make the card strictly BETTER than
    // printed — the single most damaging kind of infidelity for an A/B verdict.
    expect(result.status).toBe('incomplete');
    expect(result.missing[0]?.missingEngineSystem).toMatch(/GRANTS AN ABILITY/);
  });
});

describe('the residuals are reported by NAME, never as "copying is missing"', () => {
  it('a spell copy names the stack object that would have to cease to exist', () => {
    const result = compiled({
      name: 'Reverberate Test',
      types: ['Instant'],
      power: null,
      toughness: null,
      oracleText: 'Copy target instant or sorcery spell. You may choose new targets for the copy.',
    });
    expect(result.status).toBe('incomplete');
    expect(result.missing[0]?.missingEngineSystem).toMatch(/COPYING A SPELL ON THE STACK/);
  });

  it('a token copy is named as the same missing piece', () => {
    const result = compiled({
      name: 'Replication Test',
      types: ['Sorcery'],
      power: null,
      toughness: null,
      oracleText: "Create a token that's a copy of target creature.",
    });
    expect(result.status).toBe('incomplete');
    expect(result.missing[0]?.missingEngineSystem).toMatch(/TOKEN COPY/);
  });

  it('a "becomes a copy" activated ability reports as a TEMPLATE, not a system', () => {
    const result = compiled({
      name: 'Stage Test',
      types: ['Land'],
      power: null,
      toughness: null,
      oracleText: '{2}, {T}: This land becomes a copy of target land, except it has this ability.',
    });
    expect(result.status).toBe('incomplete');
    expect(result.missing.some((m) => /COPY template/.test(m.missingEngineSystem))).toBe(true);
  });
});

describe('the Kindred card type (CR 308)', () => {
  it('compiles as a real type alongside the card OTHER type', () => {
    const result = compiled({
      name: 'Kindred Test',
      types: ['Kindred', 'Enchantment'],
      subtypes: ['Faerie'],
      power: null,
      toughness: null,
      oracleText: '',
    });
    expect(result.definition.types).toEqual(['kindred', 'enchantment']);
    // Its subtypes are creature types even though the card is not a creature —
    // which in this engine is simply the subtype list, carried through.
    expect(result.definition.subtypes).toEqual(['faerie']);
    // No "the Kindred card type" gap: it has a system now.
    expect(result.missing.map((m) => m.missingEngineSystem)).not.toContain('the "Kindred" card type');
  });

  it('still REPORTS a card whose only type is Kindred — CR 308.1 requires a second', () => {
    const result = compiled({
      name: 'Bare Kindred Test',
      types: ['Kindred'],
      power: null,
      toughness: null,
      oracleText: '',
    });
    expect(result.status).toBe('incomplete');
    expect(result.missing.some((m) => /a card type the engine can represent/.test(m.missingEngineSystem))).toBe(true);
  });
});
