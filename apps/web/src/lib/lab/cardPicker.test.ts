/**
 * THE CARD PICKER'S MODEL (§3.165) — ranking, capping, and the filters it
 * shares with the card browser.
 */
import { describe, expect, it } from 'vitest';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { EMPTY_QUERY } from '../filter.js';
import {
  CARD_PICKER_MAX_ROWS,
  hasAdvancedFilters,
  listPickableCards,
  listPickableCardsWithin,
  withinManaValue,
} from './cardPicker.js';

function card(name: string, extra: Partial<NormalizedCard> = {}): NormalizedCard {
  return {
    id: `id:${name}`,
    name,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    cmc: 2,
    typeLine: { supertypes: [], types: ['Creature'], subtypes: [] },
    rawTypeLine: 'Creature',
    oracleText: '',
    power: 2,
    toughness: 2,
    colors: ['G'],
    colorIdentity: ['G'],
    keywords: [],
    set: 'tst',
    ...extra,
  } as NormalizedCard;
}

const POOL = [
  card('Soul Warden', { colors: ['W'] }),
  card('Restless Soul', { colors: ['W'] }),
  card('Archangel of Thune', { colors: ['W'], cmc: 5 }),
  card('Soulmender', { colors: ['W'], cmc: 1 }),
  card('Grizzly Bears'),
  card('Forest', { typeLine: { supertypes: ['Basic'], types: ['Land'], subtypes: ['Forest'] }, rawTypeLine: 'Basic Land — Forest', colors: [], cmc: 0 }),
];

describe('listPickableCards — ranking for a typed term', () => {
  it('an exact name first, then names that start with the term, then a word inside, then the rest', () => {
    const { rows } = listPickableCards(POOL, { ...EMPTY_QUERY, search: 'soul' });
    expect(rows.map((c) => c.name)).toEqual(['Soul Warden', 'Soulmender', 'Restless Soul']);
  });

  it('is case-insensitive and ignores surrounding spaces, and an empty term lists everything alphabetically', () => {
    expect(listPickableCards(POOL, { ...EMPTY_QUERY, search: '  SOUL W ' }).rows.map((c) => c.name)).toEqual(['Soul Warden']);
    const all = listPickableCards(POOL, EMPTY_QUERY);
    expect(all.rows.map((c) => c.name)).toEqual([...POOL].map((c) => c.name).sort((a, b) => a.localeCompare(b)));
    expect(all.omitted).toBe(0);
  });

  it('caps the list and says how many it left out', () => {
    const many = Array.from({ length: CARD_PICKER_MAX_ROWS + 25 }, (_, i) => card(`Card ${String(i).padStart(3, '0')}`));
    const listing = listPickableCards(many, EMPTY_QUERY);
    expect(listing.rows).toHaveLength(CARD_PICKER_MAX_ROWS);
    expect(listing.omitted).toBe(25);
    expect(listing.total).toBe(CARD_PICKER_MAX_ROWS + 25);
  });

  it("uses the browser's own colour and type filters", () => {
    const white = listPickableCards(POOL, { ...EMPTY_QUERY, colors: new Set(['W']) });
    expect(white.rows.every((c) => c.colors.includes('W'))).toBe(true);
    expect(white.total).toBe(4);
    const lands = listPickableCards(POOL, { ...EMPTY_QUERY, types: new Set(['Land']) });
    expect(lands.rows.map((c) => c.name)).toEqual(['Forest']);
  });
});

describe('the mana-value bounds', () => {
  it('are inclusive and either side may be open', () => {
    expect(withinManaValue(card('x', { cmc: 2 }), { min: 2, max: 2 })).toBe(true);
    expect(withinManaValue(card('x', { cmc: 3 }), { max: 2 })).toBe(false);
    expect(withinManaValue(card('x', { cmc: 1 }), { min: 2 })).toBe(false);
    expect(withinManaValue(card('x', { cmc: 7 }), {})).toBe(true);
  });

  it('narrow the listing before it is ranked', () => {
    const listing = listPickableCardsWithin(POOL, { ...EMPTY_QUERY, colors: new Set(['W']) }, { max: 2 });
    expect(listing.rows.map((c) => c.name)).toEqual(['Restless Soul', 'Soul Warden', 'Soulmender']);
  });

  it('hasAdvancedFilters is what the toggle reports', () => {
    expect(hasAdvancedFilters({ query: EMPTY_QUERY, manaValue: {} })).toBe(false);
    expect(hasAdvancedFilters({ query: { ...EMPTY_QUERY, search: 'x' }, manaValue: {} }), 'typing is not a filter').toBe(false);
    expect(hasAdvancedFilters({ query: { ...EMPTY_QUERY, colors: new Set(['W']) }, manaValue: {} })).toBe(true);
    expect(hasAdvancedFilters({ query: EMPTY_QUERY, manaValue: { max: 3 } })).toBe(true);
  });
});
