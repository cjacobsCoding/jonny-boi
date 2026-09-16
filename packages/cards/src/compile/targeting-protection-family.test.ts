/**
 * THE TARGETING-PROTECTION FAMILY — "hexproof from [quality]" (CR 702.11e), in
 * both of its printings.
 *
 * Measured before it was written (`packages/cards/scripts/protect-blame.mjs`
 * over a 32,341-card corpus): of 487 blocked cards whose text matches this
 * family, only 22 are blocked by the family's SHAPE, and only ONE — Fiendslayer
 * Paladin — has nothing else wrong with it. DESIGN §3.152 carries the numbers.
 *
 * ## The defect this file exists to guard, and it cuts BOTH ways
 * Every other family in this repo guards against a card playing WEAKER than
 * printed. This one is the mirror image, and it is the reason the family was
 * worth refusing until it was right:
 *
 *   - Compile `hexproof from black` into `protectionFrom` and the card gains
 *     three rules it does not have (can't be damaged, enchanted or blocked by
 *     black) plus a scope it does not have (its own controller blocked too). It
 *     plays STRONGER than printed, and `status === 'complete'` says nothing.
 *   - Accept the OLDER sentence "can't be the target of red spells or abilities
 *     from red sources" as hexproof-from and the card plays WEAKER than
 *     printed: that wording has no controller clause, so it stops its own
 *     controller too, which hexproof-from does not.
 *
 * Both directions are asserted below, and both were watched RED before being
 * trusted.
 *
 * ⚠️ Every Oracle string here is copied verbatim from a real printed card in
 * the corpus (the card is named) — `dead-rule-sweep.mjs` exists because a rule
 * written from a remembered wording matches nothing and no test can see it.
 * This family adds no `EFFECT_RULES` entry (it lives in the payload-keyword
 * parser), so neither `rule-coverage.test.ts` nor the sweep can reach it: this
 * file IS the coverage gate for it.
 */

import { describe, expect, it } from 'vitest';
import { compileCard } from './compile.js';
import type { CompilableCard } from './types.js';

function card(
  overrides: Partial<CompilableCard> & { name: string; oracleText: string },
): CompilableCard {
  return {
    id: `id:${overrides.name}`,
    manaCost: { generic: 1, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human', 'Knight'] },
    power: 2,
    toughness: 2,
    keywords: [],
    ...overrides,
  } as CompilableCard;
}

const keywordsOf = (printed: CompilableCard) => {
  const result = compileCard(printed);
  expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition.keywords ?? {};
};

describe('hexproof from [quality] — the modern keyword printing', () => {
  /**
   * One REAL printed card per distinguishable shape of the keyword line. The
   * multi-quality rows are the ones that matter: Oracle spells a hexproof-from
   * list WITHOUT repeating the preposition ("artifacts, creatures, and
   * enchantments"), unlike protection ("black and from green"), so the keyword
   * splitter tears them apart and `joinPayloadKeywords` has to put them back.
   */
  const PRINTED: readonly (readonly [string, string, readonly string[]])[] = [
    ["Garruk's Harbinger", 'Hexproof from black', ['black']],
    ['Sporeweb Weaver', 'Reach, hexproof from blue', ['blue']],
    ['Sphinx of the Guildpact', 'Hexproof from monocolored', ['monocolored']],
    ['Niv-Mizzet, Guildpact', 'Flying, hexproof from multicolored', ['multicolored']],
    ['Eradicator Valkyrie', 'Flying, lifelink, hexproof from planeswalkers', ['planeswalkers']],
    ['Jaheira, Merciful Harper', 'Hexproof from artifacts and enchantments', ['artifacts', 'enchantments']],
    [
      'Nevinyrral, Urborg Tyrant',
      'Hexproof from artifacts, creatures, and enchantments',
      ['artifacts', 'creatures', 'enchantments'],
    ],
  ];

  it.each(PRINTED)('%s: %s', (name, oracleText, expected) => {
    const keywords = keywordsOf(card({ name, oracleText }));
    expect(keywords.hexproofFrom).toEqual(expected);
  });

  it('keeps the other keywords on the same line', () => {
    const keywords = keywordsOf(card({ name: 'Eradicator Valkyrie', oracleText: 'Flying, lifelink, hexproof from planeswalkers' }));
    expect(keywords.flying).toBe(true);
    expect(keywords.lifelink).toBe(true);
  });

  it('is NEVER compiled into protection — that would grant three rules the card does not print', () => {
    const keywords = keywordsOf(card({ name: "Garruk's Harbinger", oracleText: 'Hexproof from black' }));
    expect(keywords.protectionFrom).toBeUndefined();
    expect(keywords.hexproof).toBeUndefined();
    expect(keywords.shroud).toBeUndefined();
  });

  it('refuses a quality outside the closed table rather than approximating it', () => {
    // Volatile Stormdrake, verbatim. "activated and triggered abilities" is not
    // a ProtectionQuality — a source KIND, not a source quality.
    const result = compileCard(card({ name: 'Volatile Stormdrake', oracleText: 'Flying, hexproof from activated and triggered abilities' }));
    expect(result.status).toBe('incomplete');
    expect((result.definition.keywords ?? {}).hexproofFrom).toBeUndefined();
  });
});

describe("the older sentence printing — \"can't be the target of …\"", () => {
  /** Fiendslayer Paladin's whole printed card, verbatim, reminder text included. */
  const FIENDSLAYER = card({
    name: 'Fiendslayer Paladin',
    manaCost: { generic: 1, W: 2, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    oracleText:
      'First strike (This creature deals combat damage before creatures without first strike.)\n' +
      'Lifelink (Damage dealt by this creature also causes you to gain that much life.)\n' +
      "This creature can't be the target of black or red spells your opponents control.",
    keywords: ['Lifelink', 'First strike'],
  });

  it('THE ACCEPTANCE CARD: Fiendslayer Paladin compiles whole', () => {
    const result = compileCard(FIENDSLAYER);
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    const keywords = result.definition.keywords ?? {};
    expect(keywords.hexproofFrom).toEqual(['black', 'red']);
    expect(keywords.firstStrike).toBe(true);
    expect(keywords.lifelink).toBe(true);
    // The three rules of protection it does NOT have, and hexproof's blanket form.
    expect(keywords.protectionFrom).toBeUndefined();
    expect(keywords.hexproof).toBeUndefined();
  });

  /**
   * ⚠️ THE UNDER-MATCH DIRECTION, and the residue this lane deliberately did
   * not implement. Each of these prints "can't be the target of [quality]
   * spells" with NO "your opponents control" clause, so it binds against its
   * own controller too — shroud's scope, not hexproof's. Compiling them as
   * hexproof-from would let their controller target them, which is not how they
   * are printed.
   *
   * They are PINNED here rather than left to chance: if a later widening of the
   * sentence pattern ever makes one of them quietly compile, this fails.
   */
  const SHROUD_SCOPED: readonly (readonly [string, string])[] = [
    ['Suq’Ata Firewalker', "This creature can't be the target of red spells or abilities from red sources."],
    ['Mercenary Informer', "This creature can't be the target of black spells or abilities from black sources."],
    ['Rebel Informer', "This creature can't be the target of white spells or abilities from white sources."],
    ['Raiding Party', "This enchantment can't be the target of white spells or abilities from white sources."],
    // Karplusan Strider: no controller clause AND spells only, never abilities.
    ['Karplusan Strider', "This creature can't be the target of blue or black spells."],
  ];

  it.each(SHROUD_SCOPED)('%s keeps REPORTING — its scope is not hexproof’s', (name, oracleText) => {
    const result = compileCard(card({ name, oracleText }));
    expect(result.status).toBe('incomplete');
    expect((result.definition.keywords ?? {}).hexproofFrom).toBeUndefined();
  });

  it('refuses a sentence quality outside the closed table', () => {
    // Thrun, Breaker of Silence, verbatim. "nongreen" is a negated colour and
    // is not a ProtectionQuality.
    const result = compileCard(
      card({
        name: 'Thrun, Breaker of Silence',
        oracleText:
          "Thrun can't be the target of nongreen spells your opponents control or abilities from nongreen sources your opponents control.",
      }),
    );
    expect(result.status).toBe('incomplete');
  });
});

describe('the Scryfall keyword sweep must not widen the ability', () => {
  /**
   * ⚠️ THE STRONGER-THAN-PRINTED TRAP. Scryfall stamps BOTH `"Hexproof from"`
   * and a bare `"Hexproof"` on every hexproof-from card. The sweep's flag table
   * maps the bare word to `hexproof`, so without
   * `KEYWORD_NARROWED_BY_PAYLOAD` a creature printing only "Hexproof from
   * black" enters the pool with FULL hexproof — untargetable by every opponent
   * spell of every colour.
   */
  it("Garruk's Harbinger does not gain full hexproof from Scryfall's bare keyword", () => {
    const result = compileCard(
      card({ name: "Garruk's Harbinger", oracleText: 'Hexproof from black', keywords: ['Hexproof from', 'Hexproof'] }),
    );
    const keywords = result.definition.keywords ?? {};
    expect(keywords.hexproofFrom).toEqual(['black']);
    expect(keywords.hexproof).toBeUndefined();
  });

  it('a card that really prints plain hexproof still gets it', () => {
    // Invisible Stalker, verbatim — the row must narrow nothing here.
    const keywords = keywordsOf(
      card({ name: 'Invisible Stalker', oracleText: 'Hexproof', keywords: ['Hexproof'] }),
    );
    expect(keywords.hexproof).toBe(true);
    expect(keywords.hexproofFrom).toBeUndefined();
  });

  it('the bare "Hexproof from" keyword alone, with no printed line, still REPORTS', () => {
    // Evidence-based, like every other sweep guard: no compiled payload means
    // the line was never read, so the keyword may not be silently swallowed.
    const result = compileCard(card({ name: 'Probe', oracleText: '', keywords: ['Hexproof from'] }));
    expect(result.status).toBe('incomplete');
  });
});

describe('granted hexproof-from — the attachment path comes free', () => {
  it('an Equipment granting it reads the same closed tables', () => {
    const result = compileCard(
      card({
        name: 'Probe Equipment',
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: ['Equipment'] },
        power: null,
        toughness: null,
        oracleText: 'Equipped creature gets +1/+0 and has hexproof from black.\nEquip {2}',
      }),
    );
    expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
    expect(result.definition.attachment?.modifies?.keywords?.hexproofFrom).toEqual(['black']);
  });
});
