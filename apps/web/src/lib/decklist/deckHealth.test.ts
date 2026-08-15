/**
 * Deck health: a deck containing a card the engine cannot play must SAY SO.
 *
 * The failure this guards against is silent: such a card behaves as a blank, the
 * deck still "works", and an A/B verdict comes back confidently wrong. So the
 * rule is all-or-nothing — one unplayable card makes the whole deck unplayable,
 * and the warning names the cards rather than making the user hunt.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { assessDeckHealth, deckHealthBadge, describeDeckHealth } from './deckHealth.js';
import { clearImportedCards, registerImportedCards } from './importedCards.js';
import type { NormalizedCard } from '@jonny-boi/data-tools/pure';

/** A minimal normalized card record; only id/name are read by deck health. */
function card(id: string, name: string): NormalizedCard {
  return {
    id,
    name,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    cmc: 0,
    typeLine: { supertypes: [], types: ['creature'], subtypes: [] },
    rawTypeLine: 'Creature',
    oracleText: '',
    power: 1,
    toughness: 1,
    colors: [],
    colorIdentity: [],
    keywords: [],
    rarity: 'common',
    setCode: 'tst',
    setName: 'Test',
    collectorNumber: '1',
    legalities: {},
    imageUris: {},
  } as unknown as NormalizedCard;
}

beforeEach(() => clearImportedCards());

describe('assessing a deck', () => {
  it('a deck of curated cards is playable', () => {
    const health = assessDeckHealth([
      { cardId: '4457ed35-7c10-48c8-9776-456485fdf070', count: 4 }, // Lightning Bolt
    ]);
    expect(health.playable).toBe(true);
    expect(deckHealthBadge(health)).toBeUndefined();
  });

  it('ONE unplayable card makes the whole deck unplayable', () => {
    registerImportedCards([
      { card: card('blocked-1', 'Test Walker'), missing: [{ text: '+1: draw', missingEngineSystem: 'planeswalker loyalty' }] },
    ]);
    const health = assessDeckHealth([
      { cardId: '4457ed35-7c10-48c8-9776-456485fdf070', count: 56 },
      { cardId: 'blocked-1', count: 4 },
    ]);
    expect(health.playable).toBe(false);
    expect(health.affectedCopies).toBe(4);
    expect(deckHealthBadge(health)).toBe('1 card not playable');
  });

  it('names the offending cards and what they need', () => {
    registerImportedCards([
      { card: card('blocked-1', 'Test Walker'), missing: [{ text: '+1', missingEngineSystem: 'planeswalker loyalty' }] },
    ]);
    const health = assessDeckHealth([{ cardId: 'blocked-1', count: 2 }]);
    const text = describeDeckHealth(health);
    expect(text).toContain('Test Walker');
    expect(text).toContain('planeswalker loyalty');
    expect(text).toContain('2'); // the copy count — a 2-of is a bigger hole than a 1-of
  });

  it('orders the worst offenders first (most copies)', () => {
    registerImportedCards([
      { card: card('b1', 'Singleton'), missing: [{ text: 'x', missingEngineSystem: 'sys' }] },
      { card: card('b2', 'Playset'), missing: [{ text: 'x', missingEngineSystem: 'sys' }] },
    ]);
    const health = assessDeckHealth([
      { cardId: 'b1', count: 1 },
      { cardId: 'b2', count: 4 },
    ]);
    expect(health.unplayable.map((c) => c.name)).toEqual(['Playset', 'Singleton']);
    expect(health.affectedCopies).toBe(5);
  });

  it('an imported card that DID compile counts as playable', () => {
    registerImportedCards([
      {
        card: card('ok-1', 'Fine Card'),
        definition: { id: 'ok-1', name: 'Fine Card', types: ['creature'], power: 1, toughness: 1 },
      },
    ]);
    const health = assessDeckHealth([{ cardId: 'ok-1', count: 4 }]);
    expect(health.playable).toBe(true);
  });

  it('pluralises the badge correctly', () => {
    registerImportedCards([
      { card: card('b1', 'A'), missing: [{ text: 'x', missingEngineSystem: 's' }] },
      { card: card('b2', 'B'), missing: [{ text: 'x', missingEngineSystem: 's' }] },
    ]);
    const health = assessDeckHealth([
      { cardId: 'b1', count: 1 },
      { cardId: 'b2', count: 1 },
    ]);
    expect(deckHealthBadge(health)).toBe('2 cards not playable');
  });

  it('an empty deck is trivially playable', () => {
    expect(assessDeckHealth([]).playable).toBe(true);
  });
});
