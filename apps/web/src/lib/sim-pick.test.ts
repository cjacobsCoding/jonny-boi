/**
 * Deck-pick validation glue: a saved web deck (cardId = Scryfall UUID) must
 * convert into the sim's Deck shape and validate against the sim's curated pool.
 * This is the check the Lab runs before dispatching to the worker, so a clear
 * legal/illegal decision (and message) is load-bearing. The heavy sim is tested
 * in packages/sim; here we only prove the conversion + validation seam holds.
 */
import { describe, expect, it } from 'vitest';
import { loadCardPool } from '@jonny-boi/cards';
import { validateDeck as validateSimDeck, type Deck as SimDeck } from '@jonny-boi/sim';
import { allCards } from './cards.js';
import { toSimPayload } from './sim-format.js';
import type { Deck } from './deck.js';

const pool = loadCardPool({ onWarn: () => {} });

/** A basic land from the web card index (used to build a trivially-legal deck). */
const mountain = allCards.find((c) => c.name === 'Mountain');

const makeDeck = (cards: Deck['cards']): Deck => ({
  id: 'hero',
  name: 'Hero',
  cards,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('hero deck validation through the sim pool', () => {
  it('every web card id resolves in the sim pool (the join key holds)', () => {
    for (const card of allCards) {
      expect(pool.get(card.id), `pool should resolve ${card.name}`).toBeDefined();
    }
  });

  it('accepts a legal 60-card deck (the worker would run it)', () => {
    expect(mountain).toBeDefined();
    const deck = makeDeck([{ cardId: mountain!.id, count: 60 }]);
    const problems = validateSimDeck(toSimPayload(deck) as SimDeck, pool);
    expect(problems).toEqual([]);
  });

  it('rejects an under-60 deck with a clear size message (guided, not a crash)', () => {
    const deck = makeDeck([{ cardId: mountain!.id, count: 40 }]);
    const problems = validateSimDeck(toSimPayload(deck) as SimDeck, pool);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toMatch(/below the minimum/i);
  });

  it('flags an unknown card id rather than throwing', () => {
    const deck = makeDeck([
      { cardId: mountain!.id, count: 59 },
      { cardId: 'not-a-real-card-id', count: 1 },
    ]);
    const problems = validateSimDeck(toSimPayload(deck) as SimDeck, pool);
    expect(problems.some((p) => /unknown card/i.test(p))).toBe(true);
  });
});
