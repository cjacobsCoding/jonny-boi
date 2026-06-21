import { describe, expect, it } from 'vitest';
import { allCards } from './cards.js';
import { queryCards, EMPTY_QUERY } from './filter.js';

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
    expect(result.every((c) => c.typeLine.types.includes('Creature'))).toBe(true);
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
