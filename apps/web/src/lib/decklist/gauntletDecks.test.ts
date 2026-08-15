/**
 * Gauntlet decks in the deck builder.
 *
 * The trap here is the id mismatch: sim decks name cards, web decks use Scryfall
 * UUIDs. A copy that silently dropped what it could not resolve would hand back a
 * short deck that looks fine — so these pin that a copy is either complete, or
 * reports exactly what is missing.
 */
import { describe, expect, it } from 'vitest';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { copyGauntletDeck, describeGauntletCopy, gauntletDecks } from './gauntletDecks.js';
import { deckSize } from '../deck.js';
import { getCard } from '../cards.js';

/** Total cards in a bundled sim deck. */
function simSize(deck: (typeof SAMPLE_DECKS)[number]): number {
  return deck.cards.reduce((n, e) => n + e.count, 0);
}

describe('listing the gauntlet decks', () => {
  it('lists every bundled deck with its archetype and size', () => {
    const list = gauntletDecks();
    expect(list.length).toBe(SAMPLE_DECKS.length);
    expect(list.length).toBeGreaterThan(0);
    for (const entry of list) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.archetype.length).toBeGreaterThan(0);
      expect(entry.size).toBe(simSize(entry.deck));
    }
  });

  it('reports the real deck size (the gauntlet decks are full decks)', () => {
    for (const entry of gauntletDecks()) {
      expect(entry.size).toBeGreaterThanOrEqual(60);
    }
  });
});

describe('copying a gauntlet deck into an editable one', () => {
  it('resolves every card, so the copy is the same size as the original', () => {
    for (const sample of SAMPLE_DECKS) {
      const copy = copyGauntletDeck(sample);
      expect(copy.unresolved, `${sample.name} had unresolved cards`).toEqual([]);
      expect(deckSize(copy.deck), `${sample.name} changed size when copied`).toBe(simSize(sample));
    }
  });

  it('converts card NAMES into pool UUIDs, which is what the builder keys on', () => {
    const copy = copyGauntletDeck(SAMPLE_DECKS[0]!);
    for (const entry of copy.deck.cards) {
      // Every id must resolve in the pool — a leftover name would silently break
      // every downstream surface (art, curve, validation, play).
      expect(getCard(entry.cardId), `unresolvable id ${entry.cardId}`).toBeDefined();
    }
  });

  it('gives the copy its own identity so editing it cannot touch the original', () => {
    const sample = SAMPLE_DECKS[0]!;
    const a = copyGauntletDeck(sample);
    const b = copyGauntletDeck(sample);
    expect(a.deck.id).not.toBe(b.deck.id);
    expect(a.deck.name).toContain(sample.name);
    expect(a.deck.name).not.toBe(sample.name); // suffixed, so it reads as a copy
    // Mutating the copy must not reach the bundled data.
    a.deck.cards[0]!.count = 99;
    expect(simSize(sample)).toBe(simSize(SAMPLE_DECKS[0]!));
  });

  it('merges duplicate entries rather than emitting the same card twice', () => {
    const copy = copyGauntletDeck({
      name: 'Dupes',
      archetype: 'test',
      cards: [
        { cardId: 'Forest', count: 2 },
        { cardId: 'Forest', count: 3 },
      ],
    } as (typeof SAMPLE_DECKS)[number]);
    expect(copy.deck.cards).toHaveLength(1);
    expect(copy.deck.cards[0]!.count).toBe(5);
  });

  it('REPORTS a name the pool does not know instead of quietly shrinking the deck', () => {
    const copy = copyGauntletDeck({
      name: 'Partly Unknown',
      archetype: 'test',
      cards: [
        { cardId: 'Forest', count: 4 },
        { cardId: 'Definitely Not A Real Card', count: 4 },
      ],
    } as (typeof SAMPLE_DECKS)[number]);

    expect(copy.unresolved).toEqual(['Definitely Not A Real Card']);
    expect(deckSize(copy.deck)).toBe(4);
    expect(describeGauntletCopy(copy)).toContain('Definitely Not A Real Card');
  });

  it('says plainly when a copy is complete', () => {
    const copy = copyGauntletDeck(SAMPLE_DECKS[0]!);
    const text = describeGauntletCopy(copy);
    expect(text).toContain('ready to edit');
    expect(text).not.toContain('could not be resolved');
  });
});
