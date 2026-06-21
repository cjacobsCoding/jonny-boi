import { describe, expect, it } from 'vitest';
import { loadCardPool } from '@jonny-boi/cards';
import { loadDeck, validateDeck, DeckLoadError, type Deck } from './deck.js';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import { DEFAULT_DECK_RULES } from './config.js';

const pool = loadCardPool({ onWarn: () => {} });

describe('loadDeck', () => {
  it('expands a deck by name into a flat library of the right size', () => {
    const deck: Deck = {
      name: 'tiny',
      archetype: 'test',
      cards: [
        { cardId: 'Lightning Bolt', count: 4 },
        { cardId: 'Mountain', count: 56 },
      ],
    };
    const loaded = loadDeck(deck, pool);
    expect(loaded.size).toBe(60);
    expect(loaded.library).toHaveLength(60);
    // The four Bolts are present.
    expect(loaded.library.filter((c) => c.name === 'Lightning Bolt')).toHaveLength(4);
  });

  it('accepts cards by Scryfall id as well as name', () => {
    const boltId = '4457ed35-7c10-48c8-9776-456485fdf070';
    const deck: Deck = {
      name: 'by-id',
      archetype: 'test',
      cards: [
        { cardId: boltId, count: 4 },
        { cardId: 'Mountain', count: 56 },
      ],
    };
    const loaded = loadDeck(deck, pool);
    expect(loaded.library.filter((c) => c.id === boltId)).toHaveLength(4);
  });

  it('rejects an unknown card id with a clear reason (no throw of a raw stack)', () => {
    const deck: Deck = {
      name: 'bad-card',
      archetype: 'test',
      cards: [
        { cardId: 'Black Lotus', count: 1 },
        { cardId: 'Mountain', count: 59 },
      ],
    };
    expect(() => loadDeck(deck, pool)).toThrow(DeckLoadError);
    const problems = validateDeck(deck, pool);
    expect(problems.some((p) => p.includes('Black Lotus'))).toBe(true);
  });

  it('rejects an undersized deck', () => {
    const deck: Deck = {
      name: 'too-small',
      archetype: 'test',
      cards: [{ cardId: 'Mountain', count: 40 }],
    };
    const problems = validateDeck(deck, pool);
    expect(problems.some((p) => p.includes('below the minimum'))).toBe(true);
  });

  it('enforces the 4-of limit for non-basics but allows unlimited basics', () => {
    const tooMany: Deck = {
      name: 'five-bolts',
      archetype: 'test',
      cards: [
        { cardId: 'Lightning Bolt', count: 5 },
        { cardId: 'Mountain', count: 55 },
      ],
    };
    expect(validateDeck(tooMany, pool).some((p) => p.includes('4-of'))).toBe(true);

    // 60 Mountains is legal (basics are exempt).
    const allBasics: Deck = {
      name: 'all-mountains',
      archetype: 'test',
      cards: [{ cardId: 'Mountain', count: 60 }],
    };
    expect(validateDeck(allBasics, pool)).toHaveLength(0);
  });
});

describe('SAMPLE_DECKS', () => {
  it('are all legal under the default rules', () => {
    expect(SAMPLE_DECKS.length).toBeGreaterThanOrEqual(4);
    for (const deck of SAMPLE_DECKS) {
      const problems = validateDeck(deck, pool, DEFAULT_DECK_RULES);
      expect(problems, `${deck.name}: ${problems.join('; ')}`).toHaveLength(0);
    }
  });

  it('all expand to exactly the minimum deck size', () => {
    for (const deck of SAMPLE_DECKS) {
      const loaded = loadDeck(deck, pool);
      expect(loaded.size, deck.name).toBe(DEFAULT_DECK_RULES.minDeckSize);
    }
  });
});
