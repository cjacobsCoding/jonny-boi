/**
 * The COPY rule table (CR 707) — what compiles, what reports, and why.
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
import { UNSUPPORTED_HINTS, compileCard, explainUnsupported } from './index.js';
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

describe('the "except …" tail — how the copy differs (CR 707.3)', () => {
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
  /*
   * ✅ FLIPPED BY §3.30. These two cases used to assert that a spell copy and a
   * token copy REPORTED by name — the honest record the as-enters branch left
   * behind. Both systems are shipped, so the same two printings now compile, and
   * the tests say so rather than being deleted: the pair is the before/after of
   * this file's whole contract.
   */
  it('a SPELL copy compiles (it used to report the non-card stack object)', () => {
    const result = compiled({
      name: 'Reverberate Test',
      types: ['Instant'],
      power: null,
      toughness: null,
      oracleText: 'Copy target instant or sorcery spell. You may choose new targets for the copy.',
    });
    expect(result.status).toBe('complete');
    const ref = result.definition?.effects?.[0];
    expect(ref?.primitive).toBe('copySpell');
    // The narrow restriction, never the broad `'spell'` — Reverberate may not
    // copy a creature spell, and widening it would make the card castable in a
    // board state the printed one is dead in.
    expect(ref?.params?.targets).toBe('instantOrSorcerySpell');
    // The printed permission is DATA, so a card that omits it keeps the aim.
    expect(ref?.params?.mayRetarget).toBe(true);
  });

  it('a TOKEN copy compiles, and its kicked count replaces the base count', () => {
    const result = compiled({
      name: 'Replication Test',
      types: ['Sorcery'],
      power: null,
      toughness: null,
      oracleText:
        "Create a token that's a copy of target creature. If this spell was kicked, create five of those tokens instead.",
    });
    expect(result.status).toBe('complete');
    const ref = result.definition?.effects?.[0];
    expect(ref?.primitive).toBe('createTokenCopy');
    expect(ref?.params?.count).toBe(1);
    // "INSTEAD" — one ref with two counts, not a base token plus five more.
    expect(ref?.params?.kickedCount).toBe(5);
    expect(result.definition?.effects).toHaveLength(1);
  });

  it('"you may choose new targets" is NOT granted to a card that does not print it', () => {
    const result = compiled({
      name: 'Plain Copy Test',
      types: ['Instant'],
      power: null,
      toughness: null,
      oracleText: 'Copy target instant or sorcery spell.',
    });
    expect(result.status).toBe('complete');
    expect(result.definition?.effects?.[0]?.params?.mayRetarget).toBe(false);
  });

  it(`"then return it to its owner's hand" is a SECOND ref, ordered after the copy`, () => {
    const result = compiled({
      name: 'Reversal Test',
      types: ['Instant'],
      power: null,
      toughness: null,
      oracleText:
        "Copy target instant or sorcery spell, then return it to its owner's hand. You may choose new targets for the copy.",
    });
    expect(result.status).toBe('complete');
    expect(result.definition?.effects?.map((e) => e.primitive)).toEqual(['copySpell', 'returnSpellToHand']);
  });

  /*
   * ⚠️ THIS TEST USED TO ASSERT THE OPPOSITE — "'another target creature you
   * control' is deliberately still outside the table" — and its reasoning was
   * right at the time: the printed word excludes the ASKING INSTANCE, and core's
   * target vocabulary is checked against a source DEFINITION that never learns
   * which object is asking.
   *
   * The pair the engine was missing is now there (`excludesSelfOfEffects`, read
   * by the activation menu and by the rejection path alike), so the selector is
   * a ROW and the refusal would be a lie. What the test keeps is the half that
   * still matters: the word must survive into the compiled card, never be
   * quietly dropped.
   */
  it('"another target creature you control" compiles, carrying the exclusion as data', () => {
    const result = compiled({
      name: 'Orthion Test',
      types: ['Sorcery'],
      power: null,
      toughness: null,
      oracleText: "Create a token that's a copy of another target creature you control.",
    });
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const params = result.definition?.effects?.[0]?.params;
    expect(params?.targets).toBe('creatureYouControl');
    expect(params?.excludeSelf).toBe(true);
  });

  it('a token copy whose SELECTOR is outside the closed table still reports', () => {
    // "target artifact or enchantment you control" (Adagia, Windswept Bastion).
    // A real printed selector with no row — the table holds "artifact or
    // creature" and not this one — and widening the nearest neighbour to reach
    // it would let the card copy a creature it may not touch.
    const result = compiled({
      name: 'Adagia Test',
      types: ['Sorcery'],
      power: null,
      toughness: null,
      oracleText: "Create a token that's a copy of target artifact or enchantment you control.",
    });
    expect(result.status).toBe('incomplete');
    expect(result.missing[0]?.missingEngineSystem).toMatch(/COPY-CREATING template/);
  });

  /*
   * ⚠️ THIS TEST USED TO ASSERT THE OPPOSITE — "the DELAYED sacrifice is
   * reported by name" — and its reasoning was exactly right: a token copy
   * compiled WITHOUT the sacrifice clause is a permanent hasty copy with no
   * drawback, i.e. strictly better than the printed card. DESIGN §3.32 built the
   * delayed triggered ability, so the clause compiles now; what the old test was
   * really protecting is that the drawback is never silently dropped, and that
   * is what is asserted here instead.
   */
  it('the DELAYED sacrifice compiles as a real clause, never dropped', () => {
    const result = compiled({
      name: 'Twin Test',
      types: ['Sorcery'],
      power: null,
      toughness: null,
      oracleText:
        "Create a token that's a copy of target creature, except it has haste. Sacrifice it at the beginning of the next end step.",
    });
    expect(result.status).toBe('complete');
    const params = result.definition.effects?.[0]?.params as Record<string, unknown> | undefined;
    expect(params?.delayedRemoval).toBe('sacrifice');
    // The "except" tail is still the COPY's, not a grant — two different things,
    // and a second copy taken of the token would inherit one and not the other.
    expect(params?.except).toMatchObject({ addKeywords: { haste: true } });
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

/**
 * THE HINT MUST NAME THE RIGHT SYSTEM — a guard for a defect class this file has
 * already been bitten by twice.
 *
 * `explainUnsupported` returns the FIRST hint whose pattern matches the clause
 * TEXT, and one printed sentence can appear inside several different templates.
 * The delayed-removal sentence is the worst case: it is fully implemented on a
 * token copy, so every Orthion-shaped card reported "this engine has no delayed
 * triggers" while the real blocker was a selector three words away. A reader
 * acting on that would rebuild a system that already exists.
 *
 * These are table rows: a clause, and the system its report must NAME. Adding a
 * hint that steals one of them fails here rather than in someone's afternoon.
 */
describe('an unsupported clause reports the system that is actually missing', () => {
  const CASES: ReadonlyArray<{ clause: string; names: RegExp; notNames?: RegExp }> = [
    {
      // Whip of Erebos: the delayed exile rides no creating ref.
      clause:
        'return target creature card from your graveyard to the battlefield. it gains haste. exile it at the beginning of the next end step.',
      names: /DELAYED triggered ability/,
    },
    {
      // Jaxis: the delayed sacrifice is READ; the quoted ability is not.
      clause:
        `create a token that's a copy of another target creature you control. it gains haste and "when this token dies, draw a card." sacrifice it at the beginning of the next end step.`,
      names: /GRANTS AN ABILITY printed in quotes/,
      notNames: /DELAYED triggered ability/,
    },
    {
      // Electroduplicate: the quote sits after a keyword, not against "it has".
      clause:
        `create a token that's a copy of target creature you control, except it has haste and "at the beginning of the end step, sacrifice this token."`,
      names: /GRANTS AN ABILITY printed in quotes/,
    },
    {
      // Kitsa: the copy line is read in full; the trailing condition is not.
      clause:
        "copy target instant or sorcery spell you control. you may choose new targets for the copy. activate only if ~'s power is 3 or greater.",
      names: /ACTIVATION CONDITION/,
      notNames: /COPY-CREATING template/,
    },
    {
      // Mockingbird: a fact nothing records, not a template.
      clause:
        'you may have ~ enter as a copy of any creature on the battlefield with mana value less than or equal to the amount of mana spent to cast ~.',
      names: /AMOUNT OF MANA SPENT/,
    },
  ];

  for (const { clause, names, notNames } of CASES) {
    it(`names the right system for: ${clause.slice(0, 54)}…`, () => {
      const explained = explainUnsupported(clause);
      expect(explained).toMatch(names);
      if (notNames) expect(explained).not.toMatch(notNames);
    });
  }

  it('every hint that says a system is IMPLEMENTED is telling the truth about delayed triggers', () => {
    // The specific stale claim that cost time: a hint asserting the engine has
    // no delayed triggered abilities, while `createTokenCopy` compiles one.
    const delayed = UNSUPPORTED_HINTS.find((h) => /DELAYED triggered ability/.test(h.missingEngineSystem));
    expect(delayed).toBeDefined();
    expect(delayed!.missingEngineSystem).toMatch(/implemented/);
    // And it must NOT claim a token copy's own delayed sentence is missing.
    expect(delayed!.pattern.test('sacrifice it at the beginning of the next end step')).toBe(true);
    expect(
      explainUnsupported("create a token that's a copy of that thing. sacrifice it at the beginning of the next end step."),
    ).not.toMatch(/DELAYED triggered ability/);
  });
});
