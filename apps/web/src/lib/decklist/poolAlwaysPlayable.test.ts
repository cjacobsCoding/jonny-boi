/**
 * EVERY CURATED CARD IS PLAYABLE, WHATEVER THE IMPORT STORE REMEMBERS — the
 * §3.49 sweep for the §3.37 class.
 *
 * §3.37's bug: `unsupportedReason` consulted only the imported-card store, so
 * a card that was BOTH curated and imported was judged by its import-time
 * verdict — Thragtusk, Cloudshift and Conjurer's Closet reported "not
 * playable" while the engine shipped hand-verified definitions for all three.
 * `poolBeatsImport.test.ts` pins those three by name; this file is the CLASS:
 * the promise "cards in the curated pool are always playable" is asserted for
 * EVERY pool card, against an ADVERSARIAL store that remembers a failed
 * import verdict for every single one of them. A new pool card is covered the
 * day it lands; a new lookup that forgets to ask the pool first fails for all
 * ~590 at once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CARD_POOL } from '@jonny-boi/cards';
import {
  clearImportedCards,
  registerImportedCards,
  unsupportedReason,
  type ImportedCard,
} from './importedCards.js';
import { assessDeckHealth } from './deckHealth.js';

/** A failed import verdict for a card — the stalest cache imaginable. */
function failedImport(id: string, name: string): ImportedCard {
  return {
    card: { id, name } as ImportedCard['card'],
    missing: [{ text: name, missingEngineSystem: 'a template this build has long since shipped' }],
  };
}

describe('the curated pool beats a failed import — for EVERY card (§3.37 class)', () => {
  beforeEach(() => {
    clearImportedCards();
    // Poison the well completely: a failed import verdict for every pool card.
    registerImportedCards(CARD_POOL.map((card) => failedImport(card.id, card.name)));
  });

  afterEach(() => {
    clearImportedCards();
  });

  it('unsupportedReason defers to the pool for every card', () => {
    const misreported = CARD_POOL.filter((card) => unsupportedReason(card.id) !== undefined).map(
      (card) => card.name,
    );
    expect(
      misreported,
      'curated cards reported unplayable because a stale import verdict outranked the pool',
    ).toEqual([]);
  });

  it('a deck built from ANY pool cards stays healthy under the poisoned store', () => {
    // Deck health is the user-facing read of the same promise. One deck entry
    // per pool card keeps this a single sweep rather than 590 tiny decks.
    const health = assessDeckHealth(CARD_POOL.map((card) => ({ cardId: card.id, count: 1 })));
    expect(
      health.unplayable.map((entry) => entry.name),
      'deck health flagged curated cards as unplayable',
    ).toEqual([]);
  });
});
