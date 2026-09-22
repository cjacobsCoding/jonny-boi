/**
 * THE CARD PICKER'S MODEL (§3.165) — ranking, capping, and the filters it
 * shares with the card browser.
 */
import { describe, expect, it } from 'vitest';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { EMPTY_QUERY } from '../filter.js';
import {
  CARD_PICKER_FUZZY_MIN_OPTIONS,
  CARD_PICKER_FUZZY_MIN_TERM,
  CARD_PICKER_MAX_ROWS,
  CARD_PREVIEW_DWELL_MS,
  buildFuzzyIndex,
  hasAdvancedFilters,
  listPickableCards,
  listPickableCardsWithin,
  offersFuzzy,
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

/**
 * §3.181 — Caleb's ">10 options" rule.
 *
 * ⚠️ Every assertion here is expressed in terms of CARD_PICKER_FUZZY_MIN_OPTIONS
 * rather than the number it currently holds. A test that says `10` passes
 * forever no matter what the picker actually does with the threshold, which is
 * the exact shape of "a check that cannot fail" — and the brief for this lane
 * called it out by name.
 */
describe('offersFuzzy — the >10 rule', () => {
  it('is NOT offered at the threshold, and IS offered one option above it', () => {
    expect(offersFuzzy(CARD_PICKER_FUZZY_MIN_OPTIONS)).toBe(false);
    expect(offersFuzzy(CARD_PICKER_FUZZY_MIN_OPTIONS + 1)).toBe(true);
  });

  it('is not offered for a short list or an empty one', () => {
    expect(offersFuzzy(0)).toBe(false);
    expect(offersFuzzy(1)).toBe(false);
    expect(offersFuzzy(CARD_PICKER_FUZZY_MIN_OPTIONS - 1)).toBe(false);
  });
});

describe('the approximate pass', () => {
  const fuzzy = { index: buildFuzzyIndex(POOL) };

  it('finds a misspelled name that the substring pass cannot', () => {
    const term = 'Grizzly Bearz';
    expect(listPickableCards(POOL, { ...EMPTY_QUERY, search: term }).rows).toHaveLength(0);

    const withFuzzy = listPickableCards(POOL, { ...EMPTY_QUERY, search: term }, fuzzy);
    expect(withFuzzy.rows.map((c) => c.name)).toContain('Grizzly Bears');
    expect(withFuzzy.fuzzy).toBe(withFuzzy.rows.length);
  });

  it('is STRICTLY ADDITIVE — the exact hits keep their order and stay on top', () => {
    const exact = listPickableCards(POOL, { ...EMPTY_QUERY, search: 'soul' });
    const withFuzzy = listPickableCards(POOL, { ...EMPTY_QUERY, search: 'soul' }, fuzzy);
    const head = withFuzzy.rows.slice(0, exact.rows.length).map((c) => c.name);
    expect(head).toEqual(exact.rows.map((c) => c.name));
    expect(withFuzzy.rows.length).toBeGreaterThanOrEqual(exact.rows.length);
    // Everything the approximate pass added sits BELOW the exact hits.
    expect(withFuzzy.rows.length - withFuzzy.fuzzy).toBe(exact.rows.length);
  });

  it('cannot smuggle a card past an active colour filter', () => {
    // "Grizzly Bearz" is a green card's name, misspelled, asked for with the
    // white chip on. Fuzzy must not answer with a card the filter excluded.
    const listing = listPickableCards(
      POOL,
      { ...EMPTY_QUERY, colors: new Set(['W']), search: 'Grizzly Bearz' },
      fuzzy,
    );
    expect(listing.rows.map((c) => c.name)).not.toContain('Grizzly Bears');
  });

  it('does not run on a term too short to mean anything', () => {
    const short = 'x'.repeat(CARD_PICKER_FUZZY_MIN_TERM - 1);
    expect(listPickableCards(POOL, { ...EMPTY_QUERY, search: short }, fuzzy).fuzzy).toBe(0);
  });

  it('adds nothing when it is not asked for', () => {
    expect(listPickableCards(POOL, { ...EMPTY_QUERY, search: 'Grizzly Bearz' }).fuzzy).toBe(0);
    expect(listPickableCardsWithin(POOL, { ...EMPTY_QUERY, search: 'Grizzly Bearz' }, {}).fuzzy).toBe(0);
  });
});

describe('the dwell constant', () => {
  it('is a couple of seconds, as asked — long enough to be a deliberate pause', () => {
    // Pinned as a RANGE, not a value: the point of the constant is that the feel
    // can be tuned, and the point of this test is that it cannot be tuned to
    // something that is no longer a pause (0 would fire on every mouse move).
    expect(CARD_PREVIEW_DWELL_MS).toBeGreaterThanOrEqual(1000);
    expect(CARD_PREVIEW_DWELL_MS).toBeLessThanOrEqual(3000);
  });
});
