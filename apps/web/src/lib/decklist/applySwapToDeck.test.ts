/**
 * Applying a lab verdict to a real deck.
 *
 * The risk here is producing a deck the sim will later refuse to load — a swap
 * that pushes a card past four copies, or removes more copies than the deck
 * holds because it was edited after the test ran. Every one of those is caught
 * and REPORTED rather than silently written into the user's deck.
 */
import { describe, expect, it } from 'vitest';
import { applySwapToDeck, describeApplied } from './applySwapToDeck.js';
import { deckSize, type Deck } from '../deck.js';
import { allAvailableCards } from '../cards.js';

/** Resolve a pool card id by name (the tests read better with names). */
function id(name: string): string {
  const card = allAvailableCards().find((c) => c.name === name);
  if (!card) throw new Error(`no pool card named "${name}"`);
  return card.id;
}

function deckOf(entries: Array<[string, number]>): Deck {
  return {
    id: 'test-deck',
    name: 'Test Deck',
    cards: entries.map(([name, count]) => ({ cardId: id(name), count })),
    updatedAt: new Date(0).toISOString(),
  };
}

function countOf(deck: Deck, name: string): number {
  return deck.cards.filter((e) => e.cardId === id(name)).reduce((n, e) => n + e.count, 0);
}

describe('applying a swap to a deck', () => {
  it('moves the requested number of copies', () => {
    const deck = deckOf([['Lightning Bolt', 4], ['Mountain', 56]]);
    const result = applySwapToDeck(deck, id('Lightning Bolt'), id('Shock'), 4);

    expect(result.problem).toBeUndefined();
    expect(result.copiesMoved).toBe(4);
    expect(countOf(result.deck, 'Lightning Bolt')).toBe(0);
    expect(countOf(result.deck, 'Shock')).toBe(4);
  });

  it('moves a single copy without touching the rest of the playset', () => {
    const deck = deckOf([['Lightning Bolt', 4], ['Mountain', 56]]);
    const result = applySwapToDeck(deck, id('Lightning Bolt'), id('Shock'), 1);

    expect(countOf(result.deck, 'Lightning Bolt')).toBe(3);
    expect(countOf(result.deck, 'Shock')).toBe(1);
  });

  it('never changes the deck SIZE — a swap is a replacement', () => {
    const deck = deckOf([['Lightning Bolt', 4], ['Mountain', 56]]);
    for (const copies of [1, 2, 4]) {
      const result = applySwapToDeck(deck, id('Lightning Bolt'), id('Shock'), copies);
      expect(deckSize(result.deck), `moving ${copies}`).toBe(deckSize(deck));
    }
  });

  it('refuses to exceed the copy limit, and says how many it moved', () => {
    // Already 3 Shock; swapping 4 Bolts in can only legally add 1 more.
    const deck = deckOf([['Lightning Bolt', 4], ['Shock', 3], ['Mountain', 53]]);
    const result = applySwapToDeck(deck, id('Lightning Bolt'), id('Shock'), 4);

    expect(result.copiesMoved).toBe(1);
    expect(countOf(result.deck, 'Shock')).toBe(4);
    expect(countOf(result.deck, 'Lightning Bolt')).toBe(3);
    expect(result.problem).toContain('capped at 4');
  });

  it('does nothing when the in card is already maxed', () => {
    const deck = deckOf([['Lightning Bolt', 4], ['Shock', 4], ['Mountain', 52]]);
    const result = applySwapToDeck(deck, id('Lightning Bolt'), id('Shock'), 4);

    expect(result.copiesMoved).toBe(0);
    expect(result.deck).toBe(deck); // unchanged, same reference
    expect(result.problem).toContain('maximum 4 copies');
  });

  it('reports when the out card is no longer in the deck (edited since the test)', () => {
    const deck = deckOf([['Mountain', 60]]);
    const result = applySwapToDeck(deck, id('Lightning Bolt'), id('Shock'), 4);

    expect(result.copiesMoved).toBe(0);
    expect(result.deck).toBe(deck);
    expect(result.problem).toContain('no longer in this deck');
  });

  it('never removes more copies than the deck actually holds', () => {
    // The verdict swapped 4, but the deck has since been cut to 2.
    const deck = deckOf([['Lightning Bolt', 2], ['Mountain', 58]]);
    const result = applySwapToDeck(deck, id('Lightning Bolt'), id('Shock'), 4);

    expect(result.copiesMoved).toBe(2);
    expect(countOf(result.deck, 'Lightning Bolt')).toBe(0);
    expect(countOf(result.deck, 'Shock')).toBe(2);
    expect(deckSize(result.deck)).toBe(deckSize(deck));
  });

  it('merges with an existing line rather than duplicating the card', () => {
    const deck = deckOf([['Lightning Bolt', 2], ['Shock', 1], ['Mountain', 57]]);
    const result = applySwapToDeck(deck, id('Lightning Bolt'), id('Shock'), 2);

    const shockEntries = result.deck.cards.filter((e) => e.cardId === id('Shock'));
    expect(shockEntries, 'Shock must occupy one line').toHaveLength(1);
    expect(shockEntries[0]!.count).toBe(3);
  });

  it('rejects a self-swap', () => {
    const deck = deckOf([['Lightning Bolt', 4], ['Mountain', 56]]);
    const result = applySwapToDeck(deck, id('Lightning Bolt'), id('Lightning Bolt'), 4);
    expect(result.copiesMoved).toBe(0);
    expect(result.problem).toContain('itself');
  });

  it('describes what happened in one line', () => {
    const deck = deckOf([['Lightning Bolt', 4], ['Mountain', 56]]);
    const result = applySwapToDeck(deck, id('Lightning Bolt'), id('Shock'), 4);
    const text = describeApplied(result, 'Lightning Bolt', 'Shock', 'Test Deck');
    expect(text).toContain('4×');
    expect(text).toContain('Lightning Bolt');
    expect(text).toContain('Shock');
  });
});
