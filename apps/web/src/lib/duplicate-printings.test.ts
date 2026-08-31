/**
 * ONE CARD, ONE ROW — a second printing is not a second card.
 *
 * Everything in the display layer joins on Scryfall id, but an id names a
 * PRINTING. The import store can legitimately hold the same card as the curated
 * pool under a different id: a deck imported before the card joined the pool
 * keeps whatever printing was fetched then, and the fuzzy add-card lookup
 * returns Scryfall's default printing, not the pool's. Both used to surface in
 * the card browser as two identical rows — reported as "two identical Acidic
 * Slimes in the card library".
 *
 * The fix is at the display seam, not the store: `allAvailableCards()` dedupes
 * by normalized name with the curated record winning. The store entry must
 * SURVIVE — a saved deck may reference the imported printing's id, and
 * `getCard` has to keep resolving it or that deck goes blank.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImportedCard } from './decklist/importedCards.js';
import { clearImportedCards, registerImportedCards } from './decklist/importedCards.js';
import { allAvailableCards, allCards, getCard, getCardByName } from './cards.js';

/** The curated card the duplicate was reported against. */
const CURATED = allCards.find((card) => card.name === 'Acidic Slime');
/** A fabricated second printing: same card, different Scryfall id. */
const OTHER_PRINTING_ID = '00000000-dead-beef-0000-000000000001';

function otherPrinting(): ImportedCard {
  return {
    card: { ...CURATED!, id: OTHER_PRINTING_ID, set: 'xxx' },
  };
}

beforeEach(() => clearImportedCards());
afterEach(() => clearImportedCards());

describe('a second printing of a curated card', () => {
  it('exists in the curated pool (test premise)', () => {
    expect(CURATED, 'Acidic Slime left the bundled card index').toBeDefined();
  });

  it('never shows as a second row in the available pool', () => {
    registerImportedCards([otherPrinting()]);
    const rows = allAvailableCards().filter((card) => card.name === 'Acidic Slime');
    expect(rows).toHaveLength(1);
    // And the row that survives is the CURATED printing, not the import.
    expect(rows[0]!.id).toBe(CURATED!.id);
  });

  it('still resolves by its own id, so a deck referencing it keeps rendering', () => {
    registerImportedCards([otherPrinting()]);
    expect(getCard(OTHER_PRINTING_ID)?.name).toBe('Acidic Slime');
  });

  it('does not hide a genuinely new imported card', () => {
    const novel = {
      card: { ...CURATED!, id: '00000000-dead-beef-0000-000000000002', name: 'Totally Novel Card' },
    };
    registerImportedCards([otherPrinting(), novel]);
    expect(allAvailableCards().some((card) => card.name === 'Totally Novel Card')).toBe(true);
  });
});

describe('getCardByName', () => {
  it('finds a curated card whatever the case and spacing', () => {
    expect(getCardByName('ACIDIC   SLIME')?.id).toBe(CURATED!.id);
  });

  it('prefers the curated record over an imported printing of the same name', () => {
    registerImportedCards([otherPrinting()]);
    expect(getCardByName('Acidic Slime')?.id).toBe(CURATED!.id);
  });

  it('falls back to the import store for a card only imported', () => {
    const novel = {
      card: { ...CURATED!, id: '00000000-dead-beef-0000-000000000003', name: 'Totally Novel Card' },
    };
    registerImportedCards([novel]);
    expect(getCardByName('totally novel card')?.id).toBe(novel.card.id);
  });

  it('answers undefined for a name nobody has', () => {
    expect(getCardByName('No Such Card At All')).toBeUndefined();
  });
});
