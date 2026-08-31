import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECKS_STORAGE_KEY } from './config.js';
import type { Deck } from './deck.js';
import { loadDecks, saveDecks } from './storage.js';
import { entryPrintingOf, type EntryPrinting } from './printings/entryPrinting.js';

/**
 * A minimal in-memory `localStorage`. The suite runs in plain Node with no DOM,
 * and the alternative — mocking the module — would test the mock rather than the
 * defensive parsing that is the whole point of `storage.ts`.
 */
function installStorage(seed: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(seed));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  return store;
}

const RETRO: EntryPrinting = {
  scryfallId: 'print-retro',
  imageUrl: 'https://img.example/retro.png',
  set: 'STA',
};

const DECK: Deck = {
  id: 'd1',
  name: 'Burn',
  cards: [
    { cardId: 'card-bolt', count: 4, printing: RETRO },
    { cardId: 'card-mountain', count: 20 },
  ],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('deck storage', () => {
  beforeEach(() => installStorage());
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips a deck, chosen printings included', () => {
    saveDecks([DECK]);
    const [loaded] = loadDecks();
    expect(loaded).toEqual(DECK);
    expect(entryPrintingOf(loaded!, 'card-bolt')).toEqual(RETRO);
  });

  it('keeps the card and drops the art when a stored printing is malformed', () => {
    installStorage({
      [DECKS_STORAGE_KEY]: JSON.stringify([
        {
          ...DECK,
          cards: [{ cardId: 'card-bolt', count: 4, printing: { set: 'STA' } }],
        },
      ]),
    });
    const [loaded] = loadDecks();
    expect(loaded!.cards).toEqual([{ cardId: 'card-bolt', count: 4 }]);
  });

  /**
   * `normalizeDeck` used to `filter()` the stored entries and hand the RAW
   * objects back under a `{ cardId, count }` type. Anything else riding on a
   * stored entry therefore survived into the deck model untyped. Rebuilding each
   * entry field by field is what makes the loaded value actually be a DeckEntry.
   */
  it('strips unknown fields off a stored entry instead of passing them through', () => {
    installStorage({
      [DECKS_STORAGE_KEY]: JSON.stringify([
        {
          ...DECK,
          cards: [{ cardId: 'card-bolt', count: 4, note: 'left over from v0', foil: true }],
        },
      ]),
    });
    const [loaded] = loadDecks();
    expect(Object.keys(loaded!.cards[0]!).sort()).toEqual(['cardId', 'count']);
  });

  it('drops entries that are not entries at all', () => {
    installStorage({
      [DECKS_STORAGE_KEY]: JSON.stringify([
        { ...DECK, cards: [null, 'nope', { count: 4 }, { cardId: 'card-bolt', count: 4 }] },
      ]),
    });
    expect(loadDecks()[0]!.cards).toEqual([{ cardId: 'card-bolt', count: 4 }]);
  });

  it('recovers from corrupt storage rather than throwing', () => {
    installStorage({ [DECKS_STORAGE_KEY]: '{not json' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadDecks()).toEqual([]);
    warn.mockRestore();
  });

  it('returns no decks when nothing has been saved', () => {
    expect(loadDecks()).toEqual([]);
  });
});
