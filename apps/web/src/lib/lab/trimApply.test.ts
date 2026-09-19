/**
 * APPLY REMOVES ONE COPY AND LEAVES THE REST (§3.174) — the Lab's apply
 * function on a real web deck object, no GameSession, no worker.
 */
import { describe, expect, it } from 'vitest';
import { allCards } from '../cards.js';
import { deckSize, type Deck } from '../deck.js';
import { applyCutToDeck, describeCutApplied } from './trimApply.js';

/** A card from the index by name — the web deck stores the index's (Scryfall) ids. */
function findByName(name: string): { id: string; name: string } {
  const card = allCards.find((c) => c.name === name);
  if (!card) throw new Error(`card index has no "${name}"`);
  return { id: card.id, name: card.name };
}
const SWAMP = findByName('Swamp');
const FOREST = findByName('Forest');
const WURM = findByName('Craw Wurm');

const deck: Deck = {
  id: 'd-trim',
  name: 'Rigged Green',
  updatedAt: '2026-09-19T00:00:00.000Z',
  cards: [
    { cardId: WURM.id, count: 4, name: WURM.name },
    { cardId: FOREST.id, count: 24, name: FOREST.name },
    { cardId: SWAMP.id, count: 3, name: SWAMP.name },
  ],
};

describe('applyCutToDeck', () => {
  it('removes exactly one copy of the named card and leaves every other line alone', () => {
    const result = applyCutToDeck(deck, [{ cardId: SWAMP.id, name: 'Swamp', isLand: true }]);
    expect(result.copiesRemoved).toBe(1);
    expect(result.problem).toBeUndefined();
    expect(deckSize(result.deck)).toBe(30);
    expect(result.deck.cards.find((e) => e.cardId === SWAMP.id)?.count).toBe(2);
    expect(result.deck.cards.find((e) => e.cardId === FOREST.id)?.count).toBe(24);
    expect(result.deck.cards.find((e) => e.cardId === WURM.id)?.count).toBe(4);
    // The input deck is untouched (immutable update).
    expect(deck.cards.find((e) => e.cardId === SWAMP.id)?.count).toBe(3);
    expect(describeCutApplied(result, deck.name)).toBe('Cut 1× Swamp from “Rigged Green”.');
  });

  it('a pair removes one copy of each; the last copy drops its line', () => {
    const one: Deck = { ...deck, cards: [...deck.cards.filter((e) => e.cardId !== SWAMP.id), { cardId: SWAMP.id, count: 1 }] };
    const result = applyCutToDeck(one, [
      { cardId: WURM.id, name: 'Craw Wurm', isLand: false },
      { cardId: SWAMP.id, name: 'Swamp', isLand: true },
    ]);
    expect(result.copiesRemoved).toBe(2);
    expect(result.deck.cards.some((e) => e.cardId === SWAMP.id)).toBe(false);
    expect(result.deck.cards.find((e) => e.cardId === WURM.id)?.count).toBe(3);
    expect(describeCutApplied(result, 'X')).toBe('Cut 1× Craw Wurm and 1× Swamp from “X”.');
  });

  it('reports a card the deck no longer holds and still applies the rest', () => {
    const result = applyCutToDeck(deck, [
      { cardId: 'no-such-id', name: 'Lightning Bolt', isLand: false },
      { cardId: SWAMP.id, name: 'Swamp', isLand: true },
    ]);
    expect(result.copiesRemoved).toBe(1);
    expect(result.problem).toBe('Lightning Bolt is no longer in this deck.');
    const nothing = applyCutToDeck(deck, [{ cardId: 'no-such-id', name: 'Lightning Bolt', isLand: false }]);
    expect(nothing.copiesRemoved).toBe(0);
    expect(nothing.deck).toBe(deck);
    expect(describeCutApplied(nothing, 'X')).toBe('Lightning Bolt is no longer in this deck.');
  });
});
