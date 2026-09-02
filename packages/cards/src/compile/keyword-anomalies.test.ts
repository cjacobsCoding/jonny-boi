/**
 * §3.109 — the keyword ANOMALIES: cards the gap report listed as blocked by an
 * already-implemented keyword (flying, protection, trample, affinity), which
 * meant the keyword was not the problem — the printed LINE around it was.
 *
 * Three classes, each pinned against the real printed card:
 *   1. semicolon-separated keyword lines ("Trample; haste; shroud");
 *   2. protection qualities outside the original colour/artifact/creature
 *      table — card types, "monocolored", "each color", and printed subtypes;
 *   3. affinity for a SUBTYPE ("Affinity for Slivers").
 *
 * Every positive case also asserts the compiled PAYLOAD, because a card that
 * compiles to the wrong protection is worse than one that reports.
 */
import { describe, expect, it } from 'vitest';
import type { CompilableCard } from './types.js';
import { compileCard } from './compile.js';

function creature(
  name: string,
  oracleText: string,
  overrides: Partial<CompilableCard> = {},
): CompilableCard {
  return {
    id: `id:${name}`,
    name,
    manaCost: { generic: 2, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human'] },
    power: 2,
    toughness: 2,
    keywords: [],
    oracleText,
    ...overrides,
  } as CompilableCard;
}

describe('semicolon-separated keyword lines', () => {
  it('Giant Solifuge — "Trample; haste; shroud" compiles all three', () => {
    const result = compileCard(
      creature('Giant Solifuge', 'Trample; haste; shroud', { keywords: ['Trample', 'Haste', 'Shroud'] }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.keywords).toMatchObject({ trample: true, haste: true, shroud: true });
  });

  it('still reports a semicolon line whose LAST keyword is unmodelled (Kjeldoran Skycaptain)', () => {
    // Banding has no implementation; splitting on ";" must not let the first
    // two keywords absolve the third.
    const result = compileCard(
      creature('Kjeldoran Skycaptain', 'Flying; first strike; banding', {
        keywords: ['Flying', 'First strike', 'Banding'],
      }),
    );
    expect(result.status).toBe('incomplete');
    expect(result.missing.map((m) => m.text)).toContain('Flying; first strike; banding');
  });
});

describe('protection qualities beyond colours', () => {
  it('Dragonstalker — protection from a printed subtype', () => {
    const result = compileCard(
      creature('Dragonstalker', 'Flying, protection from Dragons', { keywords: ['Flying', 'Protection'] }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.keywords).toMatchObject({ flying: true, protectionFrom: ['subtype:Dragon'] });
  });

  it('Baneslayer Angel — two subtypes in one line, joined with "and from"', () => {
    const result = compileCard(
      creature('Baneslayer Angel', 'Flying, first strike, lifelink, protection from Demons and from Dragons', {
        keywords: ['Flying', 'First strike', 'Lifelink', 'Protection'],
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.keywords?.protectionFrom).toEqual(['subtype:Demon', 'subtype:Dragon']);
  });

  it('Elite Inquisitor — three subtypes with the Oxford-comma separator', () => {
    const result = compileCard(
      creature(
        'Elite Inquisitor',
        'First strike, vigilance\nProtection from Vampires, from Werewolves, and from Zombies',
        { keywords: ['First strike', 'Vigilance', 'Protection'] },
      ),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.keywords?.protectionFrom).toEqual([
      'subtype:Vampire',
      'subtype:Werewolf',
      'subtype:Zombie',
    ]);
  });

  it('Iridescent Angel — "each color" is the five colours (CR 702.16j)', () => {
    const result = compileCard(
      creature('Iridescent Angel', 'Flying, protection from each color', { keywords: ['Flying', 'Protection'] }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.keywords?.protectionFrom).toEqual(['white', 'blue', 'black', 'red', 'green']);
  });

  it('Guardian of the Guildpact, Azorius First-Wing, Horizon Drake — the colour-count and card-type words', () => {
    const guardian = compileCard(creature('Guardian of the Guildpact', 'Protection from monocolored', { keywords: ['Protection'] }));
    expect(guardian.status, JSON.stringify(guardian.missing)).toBe('complete');
    expect(guardian.definition.keywords?.protectionFrom).toEqual(['monocolored']);

    const wing = compileCard(
      creature('Azorius First-Wing', 'Flying, protection from enchantments', { keywords: ['Flying', 'Protection'] }),
    );
    expect(wing.status, JSON.stringify(wing.missing)).toBe('complete');
    expect(wing.definition.keywords?.protectionFrom).toEqual(['enchantments']);

    const drake = compileCard(
      creature('Horizon Drake', 'Flying, protection from lands', { keywords: ['Flying', 'Protection'] }),
    );
    expect(drake.status, JSON.stringify(drake.missing)).toBe('complete');
    expect(drake.definition.keywords?.protectionFrom).toEqual(['lands']);
  });

  it('still reports a quality outside the closed tables (Reaver Titan, Voice of All)', () => {
    const titan = compileCard(creature('Reaver Titan', 'Protection from mana value 3 or less', { keywords: ['Protection'] }));
    expect(titan.status).toBe('incomplete');
    const voice = compileCard(
      creature('Voice of All', 'Flying\nAs Voice of All enters, choose a color.\nVoice of All has protection from the chosen color.', {
        keywords: ['Flying', 'Protection'],
      }),
    );
    expect(voice.status).toBe('incomplete');
    // And a subtype NOT in the closed table is refused, never guessed at.
    const made = compileCard(creature('Not Printed', 'Protection from Dwarves', { keywords: ['Protection'] }));
    expect(made.status).toBe('incomplete');
  });
});

describe('affinity for a subtype', () => {
  it('Thrumming Hivepool-style "Affinity for Slivers" counts Slivers', () => {
    const result = compileCard(
      creature('Sliver Hivepool', 'Affinity for Slivers', {
        keywords: ['Affinity'],
        typeLine: { supertypes: [], types: ['Artifact'], subtypes: [] },
        power: null,
        toughness: null,
      }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.castCostReductionPerPermanent).toEqual({
      amount: 1,
      filter: { anyOfSubtypes: ['Sliver'] },
    });
  });

  it('Hellspur Brute — "Affinity for outlaws" is the five outlaw types (CR 205.3d)', () => {
    const result = compileCard(
      creature('Hellspur Brute', 'Affinity for outlaws\nTrample', { keywords: ['Affinity', 'Trample'] }),
    );
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.castCostReductionPerPermanent?.filter).toEqual({
      anyOfSubtypes: ['Assassin', 'Mercenary', 'Pirate', 'Rogue', 'Warlock'],
    });
  });

  it('still reports an affinity noun outside both tables', () => {
    const result = compileCard(creature('Not Printed', 'Affinity for Dwarves', { keywords: ['Affinity'] }));
    expect(result.status).toBe('incomplete');
  });
});
