/**
 * A CURATED CARD IS NEVER "not playable", whatever the import store remembers.
 *
 * `importedCards.ts` promises the store is "deliberately additive: nothing here
 * can shadow a curated card", and `deckHealth.ts` promises "cards in the curated
 * pool are always playable". Both were true as documentation and false as code:
 * `unsupportedReason` consulted only the import store, so a card that is BOTH
 * curated and imported was judged by the import.
 *
 * That is the ordinary case, not a corner: you paste a real decklist, some of it
 * is already in the pool, and any of those the compiler could not read AT IMPORT
 * TIME were then reported broken forever. It was reported from a deck builder
 * showing "⚠ 10 cards not playable" over a list that included `Thragtusk`,
 * `Cloudshift` and `Conjurer's Closet` — all three curated, all three playable,
 * all three named as broken, one of them (Thragtusk) with a leaves-trigger the
 * engine has had for months.
 *
 * The store doubles as a CACHE of the verdict taken when the card was imported,
 * which is the second half of the same bug: Cloudshift's entry still read "needs
 * a filtered-targeting template" after the rule that compiles it had shipped.
 * Deferring to the pool fixes that permanently for curated cards.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { CARD_POOL } from '@jonny-boi/cards';
import {
  clearImportedCards,
  registerImportedCards,
  unsupportedReason,
  type ImportedCard,
} from './importedCards.js';
import { assessDeckHealth } from './deckHealth.js';

function poolCard(name: string): { id: string; name: string } {
  const card = CARD_POOL.find((entry) => entry.name === name);
  if (!card) throw new Error(`pool missing ${name} — this test needs a CURATED card`);
  return { id: card.id, name: card.name };
}

/** A failed import: a real card the compiler could not read at import time. */
function failedImport(id: string, name: string): ImportedCard {
  return {
    card: { id, name } as ImportedCard['card'],
    missing: [{ text: 'whatever', missingEngineSystem: 'a template the compiler cannot read' }],
  };
}

describe('the curated pool beats a failed import', () => {
  beforeEach(() => {
    clearImportedCards();
  });

  it('reports no reason for a curated card, even when its import failed', () => {
    const thragtusk = poolCard('Thragtusk');
    registerImportedCards([failedImport(thragtusk.id, thragtusk.name)]);
    expect(
      unsupportedReason(thragtusk.id),
      'Thragtusk is in the pool with a leaves-trigger the engine plays — it is not unplayable',
    ).toBeUndefined();
  });

  it('keeps a deck of curated cards HEALTHY despite failed imports of them', () => {
    // The exact reported shape: three curated cards, all imported and all failed.
    const cards = ['Thragtusk', 'Cloudshift', "Conjurer's Closet"].map(poolCard);
    registerImportedCards(cards.map((c) => failedImport(c.id, c.name)));
    const health = assessDeckHealth(cards.map((c) => ({ cardId: c.id, count: 4 })));
    expect(health.unplayable, `flagged: ${health.unplayable.map((u) => u.name).join(', ')}`).toEqual([]);
    expect(health.playable).toBe(true);
  });

  it('still reports a genuinely uncurated card that failed to import', () => {
    // The other half. Silencing every warning would be a worse bug than the one
    // being fixed: a deck full of cards the engine cannot play would look fine
    // and then skew every simulation run on it.
    const id = 'not-a-pool-card-0000';
    registerImportedCards([failedImport(id, 'Some Unreadable Card')]);
    expect(unsupportedReason(id), 'an uncurated failed import must still be reported').toBeDefined();
  });
});
