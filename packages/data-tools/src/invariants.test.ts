/**
 * The accuracy guard, offline half.
 *
 * Two jobs:
 *  1. the checker itself is right — each invariant is proved to fire on a card
 *     that breaks it and to stay quiet on one that does not;
 *  2. the COMMITTED index passes all of them. This is the test that fails if a
 *     future edit (by hand, by a bad merge, or by a normalizer regression)
 *     leaves the card data disagreeing with itself.
 *
 * Deliberately no network: `npm test` must be deterministic and offline. The
 * live cross-check against Scryfall is the opt-in `npm run verify -w
 * @jonny-boi/data-tools`.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { checkCard, checkCardIndex, formatManaCost, formatViolations, knownPipTotal } from './invariants.js';
import { cardIndexPath, starterCardListPath } from './paths.js';
import type { CardIndex, NormalizedCard } from './types.js';

/** A minimal well-formed card; each test breaks exactly one thing about it. */
function validCard(overrides: Partial<NormalizedCard> = {}): NormalizedCard {
  return {
    id: 'test-id',
    name: 'Test Card',
    manaCost: { generic: 2, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
    cmc: 3,
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Goblin'] },
    rawTypeLine: 'Creature — Goblin',
    oracleText: 'Haste',
    power: 2,
    toughness: 2,
    colors: ['R'],
    colorIdentity: ['R'],
    keywords: ['Haste'],
    set: 'tst',
    collectorNumber: '1',
    rarity: 'common',
    imageUris: {},
    localImages: {},
    isDoubleFaced: false,
    faces: [],
    ...overrides,
  };
}

/** The rule names a card violates, for concise assertions. */
function rules(card: NormalizedCard): string[] {
  return checkCard(card).map((violation) => violation.rule);
}

describe('mana-cost helpers', () => {
  it('totals only the pips whose mana value is unambiguous', () => {
    expect(knownPipTotal({ generic: 3, W: 0, U: 2, B: 0, R: 0, G: 0, C: 0, other: ['X'] })).toBe(5);
  });

  it('renders a cost back to Scryfall notation', () => {
    expect(formatManaCost({ generic: 3, W: 0, U: 2, B: 0, R: 0, G: 0, C: 0, other: [] })).toBe('{3}{U}{U}');
    expect(formatManaCost({ generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] })).toBe('{}');
    expect(formatManaCost({ generic: 1, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: ['G/W', 'G/W'] })).toBe(
      '{1}{G/W}{G/W}',
    );
  });
});

describe('checkCard', () => {
  it('passes a well-formed card', () => {
    expect(checkCard(validCard())).toEqual([]);
  });

  it('catches a mana value that does not match the pips', () => {
    // The exact shape of the reported corruption: {3}{R} rewritten as {2}{R}{R}
    // keeps the mana value, but dropping a generic pip without adjusting `cmc`
    // does not.
    const card = validCard({ manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] } });
    expect(rules(card)).toContain('mana value is reconcilable with the printed pips');
  });

  it('accepts a cost whose unattributed symbols explain the gap', () => {
    // {1}{G/W}{G/W} — two hybrid pips, mana value 3, only 1 known pip.
    const finks = validCard({
      manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: ['G/W', 'G/W'] },
      cmc: 3,
      colors: ['G', 'W'],
      colorIdentity: ['G', 'W'],
    });
    expect(rules(finks)).toEqual([]);
  });

  it('accepts {X}, which contributes nothing to the printed mana value', () => {
    const fireball = validCard({
      manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: ['X'] },
      cmc: 1,
      typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
      rawTypeLine: 'Sorcery',
      oracleText: 'Deal X damage.',
      keywords: [],
      power: null,
      toughness: null,
    });
    expect(rules(fireball)).toEqual([]);
  });

  it('catches a coloured pip the colour identity does not admit', () => {
    // A generic pip promoted to a coloured one of a colour the card is not.
    const card = validCard({
      manaCost: { generic: 1, W: 0, U: 1, B: 0, R: 1, G: 0, C: 0, other: [] },
      cmc: 3,
    });
    expect(rules(card)).toContain('a coloured pip implies that colour in the colour identity');
  });

  it('catches colors that escape the colour identity', () => {
    expect(rules(validCard({ colors: ['R', 'G'] }))).toContain(
      'colors are a subset of the colour identity',
    );
  });

  it('catches a parsed type line that does not match the raw one', () => {
    const card = validCard({ typeLine: { supertypes: [], types: ['Instant'], subtypes: [] } });
    expect(rules(card)).toContain('the parsed type line round-trips from the raw one');
  });

  it('catches power without toughness', () => {
    expect(rules(validCard({ toughness: null }))).toContain(
      'power and toughness are both present or both absent',
    );
  });

  it('catches power/toughness on a non-creature', () => {
    const card = validCard({
      typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
      rawTypeLine: 'Instant',
      keywords: [],
      oracleText: 'Draw a card.',
    });
    expect(rules(card)).toContain('only creatures carry power/toughness');
  });

  it('allows a creature with no printed numbers (a characteristic-defining */*)', () => {
    const goyf = validCard({
      name: 'Tarmogoyf',
      power: null,
      toughness: null,
      keywords: [],
      oracleText: "Tarmogoyf's power is equal to the number of card types among cards in all graveyards…",
      manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
      cmc: 2,
      colors: ['G'],
      colorIdentity: ['G'],
      typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Lhurgoyf'] },
      rawTypeLine: 'Creature — Lhurgoyf',
    });
    expect(rules(goyf)).toEqual([]);
  });

  it('catches a keyword that is not in the printed text', () => {
    expect(rules(validCard({ keywords: ['Haste', 'Flying'] }))).toContain(
      'every listed keyword appears in the printed text',
    );
  });

  it('accepts a keyword printed only on the back face of a double-faced card', () => {
    const delver = validCard({
      keywords: ['Flying'],
      oracleText: 'At the beginning of your upkeep, look at the top card of your library.',
      isDoubleFaced: true,
      faces: [
        {
          name: 'Front',
          manaCost: { generic: 0, W: 0, U: 1, B: 0, R: 0, G: 0, C: 0, other: [] },
          typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Human'] },
          rawTypeLine: 'Creature — Human Wizard',
          oracleText: 'At the beginning of your upkeep, look at the top card of your library.',
          power: 1,
          toughness: 1,
          colors: ['U'],
          imageUris: {},
        },
        {
          name: 'Back',
          manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
          typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Insect'] },
          rawTypeLine: 'Creature — Human Insect',
          oracleText: 'Flying',
          power: 3,
          toughness: 2,
          colors: ['U'],
          imageUris: {},
        },
      ],
    });
    expect(rules(delver)).toEqual([]);
  });

  it('catches a face list that disagrees with the double-faced flag', () => {
    expect(rules(validCard({ isDoubleFaced: true }))).toContain(
      'a double-faced card carries its faces',
    );
  });
});

describe('checkCardIndex', () => {
  const wrap = (cards: NormalizedCard[]): CardIndex => ({
    generatedAt: '2026-01-01T00:00:00.000Z',
    attribution: 'Card data via Scryfall.',
    requested: cards.length,
    unresolved: [],
    cards,
  });

  it('catches duplicate ids and names', () => {
    const violations = checkCardIndex(wrap([validCard(), validCard()]));
    expect(violations.map((v) => v.rule)).toEqual(
      expect.arrayContaining(['card ids are unique', 'card names are unique']),
    );
  });

  it('catches cards that are out of name order', () => {
    const violations = checkCardIndex(
      wrap([validCard({ id: 'b', name: 'Zealot' }), validCard({ id: 'a', name: 'Adept' })]),
    );
    expect(violations.map((v) => v.rule)).toContain('cards are sorted by name');
  });
});

// --- the standing guard over the real, committed data ---------------------------

const index = JSON.parse(readFileSync(cardIndexPath(), 'utf8')) as CardIndex;
const starter = JSON.parse(readFileSync(starterCardListPath(), 'utf8')) as { names: string[] };

/** The front-face name, which is how a DFC is listed in the starter file. */
function frontFaceName(card: NormalizedCard): string {
  return card.name.split(' // ')[0]!;
}

describe('the committed card index', () => {
  it('satisfies every structural invariant', () => {
    const violations = checkCardIndex(index);
    expect(violations, `\n${formatViolations(violations)}\n`).toEqual([]);
  });

  it('resolved every name the pipeline was asked for', () => {
    expect(index.unresolved).toEqual([]);
    expect(index.cards.length).toBe(index.requested);
  });

  it('holds exactly the cards the starter list asks for', () => {
    const indexed = new Set(index.cards.flatMap((card) => [card.name, frontFaceName(card)]));
    const missing = starter.names.filter((name) => !indexed.has(name));
    expect(missing, `starter names with no index record: ${missing.join(', ')}`).toEqual([]);
    expect(index.cards.length).toBe(new Set(starter.names).size);
  });

  it('carries the art URLs the UI needs for every card', () => {
    const withoutArt = index.cards
      .filter((card) => !card.imageUris.normal || !card.imageUris.art_crop)
      .map((card) => card.name);
    expect(withoutArt).toEqual([]);
  });
});
