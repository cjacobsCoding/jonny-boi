/**
 * SWAP SCOPE — one copy, or the whole playset.
 *
 * These are two different questions and a verdict is uninterpretable without
 * knowing which was asked. Until now the lab only ever swapped ONE copy and never
 * said so, so "is Lightning Bolt better than Shock" was silently answered as "is
 * the 4th Bolt better than a 4th Shock" — a quarter of the effect, and far more
 * likely to come back inconclusive.
 *
 * The critical property below is that a playset swap preserves the paired
 * common-random-numbers design: the entry is replaced IN PLACE with the SAME
 * count, so the expanded library differs only at those slots and the seeded
 * shuffle produces the same permutation.
 */
import { describe, expect, it } from 'vitest';
import { loadCardPool } from '@jonny-boi/cards';
import { applySwap } from './swap.js';
import { loadDeck } from './deck.js';
import { DEFAULT_SWAP_SCOPE } from './config.js';
import type { Deck } from './deck.js';

const pool = loadCardPool({ onWarn: () => {} });

/** A deck with a 4-of we can swap, padded to a legal size. */
function baseDeck(): Deck {
  return {
    name: 'Scope Test',
    archetype: 'test',
    cards: [
      { cardId: 'Lightning Bolt', count: 4 },
      { cardId: 'Goblin Guide', count: 4 },
      { cardId: 'Mountain', count: 52 },
    ],
  };
}

/** Count copies of a card name in a deck's entries. */
function copies(deck: Deck, name: string): number {
  const id = pool.getByName(name)?.id;
  return deck.cards
    .filter((e) => (pool.get(e.cardId) ?? pool.getByName(e.cardId))?.id === id)
    .reduce((n, e) => n + e.count, 0);
}

describe('swap scope', () => {
  it("'one' replaces a single copy, leaving the rest of the playset", () => {
    const variant = applySwap(baseDeck(), { out: 'Lightning Bolt', in: 'Shock' }, pool, 'one');
    expect(copies(variant, 'Lightning Bolt')).toBe(3);
    expect(copies(variant, 'Shock')).toBe(1);
  });

  it("'playset' replaces EVERY copy — the question people actually ask", () => {
    const variant = applySwap(baseDeck(), { out: 'Lightning Bolt', in: 'Shock' }, pool, 'playset');
    expect(copies(variant, 'Lightning Bolt')).toBe(0);
    expect(copies(variant, 'Shock')).toBe(4);
  });

  it('defaults to the whole playset', () => {
    expect(DEFAULT_SWAP_SCOPE).toBe('playset');
    const explicit = applySwap(baseDeck(), { out: 'Lightning Bolt', in: 'Shock' }, pool, 'playset');
    const implied = applySwap(baseDeck(), { out: 'Lightning Bolt', in: 'Shock' }, pool);
    expect(implied.cards).toEqual(explicit.cards);
  });

  it('names the variant with the number of copies moved, so a result is self-describing', () => {
    const one = applySwap(baseDeck(), { out: 'Lightning Bolt', in: 'Shock' }, pool, 'one');
    const all = applySwap(baseDeck(), { out: 'Lightning Bolt', in: 'Shock' }, pool, 'playset');
    expect(one.name).toContain('1×');
    expect(all.name).toContain('4×');
  });

  it('keeps the deck the same SIZE either way (a swap never adds or drops cards)', () => {
    const size = (d: Deck) => d.cards.reduce((n, e) => n + e.count, 0);
    const base = baseDeck();
    for (const scope of ['one', 'playset'] as const) {
      const variant = applySwap(base, { out: 'Lightning Bolt', in: 'Shock' }, pool, scope);
      expect(size(variant), scope).toBe(size(base));
    }
  });

  it('PRESERVES THE PAIRING: the playset variant differs from the base only at the swapped slots', () => {
    const base = baseDeck();
    const variant = applySwap(base, { out: 'Lightning Bolt', in: 'Shock' }, pool, 'playset');

    const baseLib = loadDeck(base, pool).library;
    const variantLib = loadDeck(variant, pool).library;

    // Same length, and identical at every position except the swapped card's.
    expect(variantLib).toHaveLength(baseLib.length);
    const differing: number[] = [];
    for (let i = 0; i < baseLib.length; i++) {
      if (baseLib[i]!.id !== variantLib[i]!.id) differing.push(i);
    }
    // Exactly the four Bolt slots moved — nothing shifted position. If the entry
    // were removed and re-appended instead, every later card would shift and the
    // two arms would draw completely different games.
    expect(differing).toHaveLength(4);
    for (const i of differing) {
      expect(baseLib[i]!.name).toBe('Lightning Bolt');
      expect(variantLib[i]!.name).toBe('Shock');
    }
  });

  it('a self-swap is still the identity under BOTH scopes (the lab’s sanity check)', () => {
    const base = baseDeck();
    for (const scope of ['one', 'playset'] as const) {
      const variant = applySwap(base, { out: 'Lightning Bolt', in: 'Lightning Bolt' }, pool, scope);
      const baseLib = loadDeck(base, pool).library.map((c) => c.id);
      const variantLib = loadDeck(variant, pool).library.map((c) => c.id);
      expect(variantLib, scope).toEqual(baseLib);
    }
  });

  it('swapping a 1-of behaves identically under both scopes', () => {
    const deck: Deck = {
      name: 'One Of',
      archetype: 'test',
      cards: [
        { cardId: 'Lightning Bolt', count: 1 },
        { cardId: 'Mountain', count: 59 },
      ],
    };
    const one = applySwap(deck, { out: 'Lightning Bolt', in: 'Shock' }, pool, 'one');
    const all = applySwap(deck, { out: 'Lightning Bolt', in: 'Shock' }, pool, 'playset');
    expect(loadDeck(one, pool).library.map((c) => c.id)).toEqual(
      loadDeck(all, pool).library.map((c) => c.id),
    );
  });
});
