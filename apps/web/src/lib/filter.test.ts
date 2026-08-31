import { describe, expect, it } from 'vitest';
import { allCards, allAvailableCards } from './cards.js';
import { TYPE_FILTERS } from './config.js';
import { queryCards, filterableTypes, EMPTY_QUERY } from './filter.js';

describe('queryCards', () => {
  it('returns the whole pool, name-sorted, for the empty query', () => {
    const result = queryCards(allCards, EMPTY_QUERY);
    expect(result).toHaveLength(allCards.length);
    for (let i = 1; i < result.length; i += 1) {
      expect(result[i - 1]!.name.localeCompare(result[i]!.name)).toBeLessThanOrEqual(0);
    }
  });

  it('filters by case-insensitive name substring', () => {
    const result = queryCards(allCards, { ...EMPTY_QUERY, search: 'counter' });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((c) => c.name.toLowerCase().includes('counter'))).toBe(true);
  });

  it('filters by color (any selected color present)', () => {
    const result = queryCards(allCards, { ...EMPTY_QUERY, colors: new Set(['U']) });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((c) => c.colors.includes('U'))).toBe(true);
  });

  it('treats colorless (C) as cards with no colors', () => {
    const result = queryCards(allCards, { ...EMPTY_QUERY, colors: new Set(['C']) });
    expect(result.every((c) => c.colors.length === 0)).toBe(true);
  });

  it('filters by type', () => {
    const result = queryCards(allCards, { ...EMPTY_QUERY, types: new Set(['Creature']) });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((c) => filterableTypes(c).has('Creature'))).toBe(true);
  });

  it('sorts by mana value ascending and descending', () => {
    const asc = queryCards(allCards, { ...EMPTY_QUERY, sort: 'cmc-asc' });
    for (let i = 1; i < asc.length; i += 1) {
      expect(asc[i - 1]!.cmc).toBeLessThanOrEqual(asc[i]!.cmc);
    }
    const desc = queryCards(allCards, { ...EMPTY_QUERY, sort: 'cmc-desc' });
    for (let i = 1; i < desc.length; i += 1) {
      expect(desc[i - 1]!.cmc).toBeGreaterThanOrEqual(desc[i]!.cmc);
    }
  });

  it('returns an empty result for a no-match search', () => {
    const result = queryCards(allCards, { ...EMPTY_QUERY, search: 'zzzzz-no-such-card' });
    expect(result).toHaveLength(0);
  });

  it('does not mutate the input array', () => {
    const copy = [...allCards];
    queryCards(allCards, { ...EMPTY_QUERY, sort: 'cmc-desc' });
    expect(allCards).toEqual(copy);
  });
});

/**
 * The type chips, checked against the pool the Cards browser and the Deck
 * Builder actually filter — `allAvailableCards()`, not the curated slice.
 *
 * A user reported "the Instant type filter does not filter". Selecting a chip
 * *does* narrow the list, and always did; what it did not do was find every
 * card of that type. These tests are per-chip and data-backed rather than a
 * single spot-check on Creature, because the old defect was invisible to a spot
 * check: it hid in the pool's fifty multi-face cards, and only ever affected the
 * chip matching a card's SECOND face.
 */
describe('the type filter chips', () => {
  const pool = allAvailableCards();

  it('narrows the pool for every chip, and every result carries that type', () => {
    for (const type of TYPE_FILTERS) {
      const result = queryCards(pool, { ...EMPTY_QUERY, types: new Set([type]) });
      expect(result.length, `${type} matched nothing`).toBeGreaterThan(0);
      expect(result.length, `${type} did not narrow the pool`).toBeLessThan(pool.length);
      const leaked = result.filter((card) => !filterableTypes(card).has(type));
      expect(leaked.map((c) => c.name), `${type} let non-${type} cards through`).toEqual([]);
    }
  });

  it('intersects the type filter with an active name search', () => {
    const term = 'a';
    const searched = queryCards(pool, { ...EMPTY_QUERY, search: term });
    for (const type of TYPE_FILTERS) {
      const both = queryCards(pool, { ...EMPTY_QUERY, search: term, types: new Set([type]) });
      expect(both.length, `search + ${type} should not exceed search alone`).toBeLessThanOrEqual(
        searched.length,
      );
      for (const card of both) {
        expect(card.name.toLowerCase()).toContain(term);
        expect(filterableTypes(card).has(type)).toBe(true);
      }
    }
  });

  it('unions multiple selected chips rather than intersecting them', () => {
    const instants = queryCards(pool, { ...EMPTY_QUERY, types: new Set(['Instant']) });
    const sorceries = queryCards(pool, { ...EMPTY_QUERY, types: new Set(['Sorcery']) });
    const either = queryCards(pool, { ...EMPTY_QUERY, types: new Set(['Instant', 'Sorcery']) });
    expect(either.length).toBeGreaterThanOrEqual(Math.max(instants.length, sorceries.length));
    expect(either.length).toBeLessThanOrEqual(instants.length + sorceries.length);
    for (const card of either) {
      const types = filterableTypes(card);
      expect(types.has('Instant') || types.has('Sorcery')).toBe(true);
    }
  });

  /**
   * The report's actual defect. Every one of these is a real card in the pool
   * whose printed type line names a type that no chip could reach, because
   * `parseTypeLine` only survives the FIRST face intact.
   */
  it.each([
    ['Kazandu Mammoth // Kazandu Valley', 'Land'],
    ['Akoum Warrior // Akoum Teeth', 'Land'],
    ['Glasswing Grace // Age-Graced Chapel', 'Land'],
    ['Foulmire Knight // Profane Insight', 'Instant'],
    ["Garenbrig Carver // Shield's Might", 'Instant'],
    ['Beanstalk Giant // Fertile Footsteps', 'Sorcery'],
    ['Invasion of Belenon // Belenon War Anthem', 'Enchantment'],
    ['Invasion of Dominaria // Serra Faithkeeper', 'Creature'],
  ])('finds %s under the %s chip', (name, type) => {
    const card = pool.find((c) => c.name === name);
    // Guard rather than skip: if the pool stops carrying the card the assertion
    // below is meaningless, and a silently-vacuous test is worse than none.
    expect(card, `${name} is no longer in the pool — repoint this case`).toBeDefined();
    expect(card!.rawTypeLine, `${name} no longer prints ${type}`).toContain(type);
    const result = queryCards(pool, { ...EMPTY_QUERY, types: new Set([type]) });
    expect(result.map((c) => c.name)).toContain(name);
  });

  it('never offers a card no chip can reach', () => {
    // Asserted through `queryCards`, not through `filterableTypes`: the question
    // is whether every card is reachable BY CLICKING A CHIP, so the predicate
    // the chips run has to be the thing under test.
    const reachable = new Set<string>();
    for (const type of TYPE_FILTERS) {
      for (const card of queryCards(pool, { ...EMPTY_QUERY, types: new Set([type]) })) {
        reachable.add(card.id);
      }
    }
    const unreachable = pool
      .filter((card) => !reachable.has(card.id))
      .map((card) => `${card.name} (${card.rawTypeLine})`);
    expect(unreachable).toEqual([]);
  });

  it('never treats the "//" face separator as a card type', () => {
    for (const card of pool) {
      expect(filterableTypes(card).has('//'), `${card.name} exposes "//" as a type`).toBe(false);
    }
    // And it is not selectable either: a query for it matches nothing.
    expect(queryCards(pool, { ...EMPTY_QUERY, types: new Set(['//']) })).toEqual([]);
  });
});
