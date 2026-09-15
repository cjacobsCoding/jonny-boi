import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECKS_STORAGE_KEY } from './config.js';
import type { Deck } from './deck.js';
import { loadDecks, saveDecks } from './storage.js';
import { entryPrintingOf, type EntryPrinting } from './printings/entryPrinting.js';
import { clearStorageNotices, describeNotice, storageNotices } from './persistence/failures.js';

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

/**
 * A `localStorage` whose `setItem` throws what a real browser throws when the
 * ORIGIN IS FULL. This is the exact condition that lost two imported decks, and
 * it is shaped like a `DOMException` rather than a bare `Error` because the
 * funnel distinguishes a full origin (which the user can act on from the storage
 * readout) from any other refusal (which they cannot).
 */
function installFullStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: () => {
      const error = new Error('quota') as Error & { name: string; code: number };
      error.name = 'QuotaExceededError';
      error.code = 22;
      throw error;
    },
    removeItem: (key: string) => void store.delete(key),
  });
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
    const [loaded] = loadDecks().decks;
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
    const [loaded] = loadDecks().decks;
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
    const [loaded] = loadDecks().decks;
    expect(Object.keys(loaded!.cards[0]!).sort()).toEqual(['cardId', 'count']);
  });

  it('drops entries that are not entries at all', () => {
    installStorage({
      [DECKS_STORAGE_KEY]: JSON.stringify([
        { ...DECK, cards: [null, 'nope', { count: 4 }, { cardId: 'card-bolt', count: 4 }] },
      ]),
    });
    expect(loadDecks().decks[0]!.cards).toEqual([{ cardId: 'card-bolt', count: 4 }]);
  });

  it('recovers from corrupt storage rather than throwing', () => {
    installStorage({ [DECKS_STORAGE_KEY]: '{not json' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadDecks().decks).toEqual([]);
    warn.mockRestore();
  });

  it('returns no decks when nothing has been saved', () => {
    expect(loadDecks().decks).toEqual([]);
  });
});

/**
 * THE REGRESSION SUITE FOR THE DECK-LOSS BUG.
 *
 * Caleb imported two decks; they showed up for the session and were gone on the
 * next load. `saveDecks` had caught the quota error into a `console.warn`, and a
 * deck lives in React state the moment it is imported, so the session looked
 * perfectly healthy. Every test here fails if that swallow comes back.
 *
 * Note WHAT is asserted. Not "it did not throw" — that is what a
 * storage-refuses-to-write test usually checks, and a swallow passes it
 * trivially. These assert the PRESENCE of a report and the ABSENCE of a false
 * success, which is the only pair that can tell the two apart.
 */
describe('a write that cannot land is never reported as saved', () => {
  beforeEach(() => clearStorageNotices());
  afterEach(() => {
    vi.unstubAllGlobals();
    clearStorageNotices();
  });

  it('tells the caller the save failed when the origin is full', () => {
    installFullStorage();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = saveDecks([DECK]);
    warn.mockRestore();

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('quota');
  });

  it('raises a user-visible notice naming the decks, not just a console line', () => {
    installFullStorage();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    saveDecks([DECK]);
    warn.mockRestore();

    const notices = storageNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.areaId).toBe('decks');
    expect(notices[0]!.severity).toBe('error');
    // The message has to be worth showing: it must name the thing that failed
    // and say the change will not survive a reload, which is precisely the fact
    // the user was missing while wondering where two decks went.
    const text = describeNotice(notices[0]!);
    expect(text).toContain('Saved decks');
    expect(text.toLowerCase()).toContain('reload');
  });

  it('does not bury the reader under a flood of failed debounced saves', () => {
    installFullStorage();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 60; i += 1) saveDecks([DECK]);
    warn.mockRestore();

    // Sixty failures are ONE banner. A registry that appended would bury the
    // storage readout under its own scrollback.
    expect(storageNotices()).toHaveLength(1);
  });

  it('reports the failure when storage is absent entirely (private browsing)', () => {
    vi.stubGlobal('localStorage', undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = saveDecks([DECK]);
    warn.mockRestore();

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('unavailable');
    expect(storageNotices()).toHaveLength(1);
  });

  it('refuses a deck list bigger than the decks area is budgeted for', () => {
    installStorage();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // One absurd deck name, well past the decks area share of the origin.
    const huge: Deck = { ...DECK, name: 'x'.repeat(600_000) };
    const result = saveDecks([huge]);
    warn.mockRestore();

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('over-budget');
    // And nothing was written, so whatever WAS stored is still there to read.
    expect(localStorage.getItem(DECKS_STORAGE_KEY)).toBeNull();
  });

  it('says so when stored decks exist but cannot be read, and flags them corrupt', () => {
    installStorage({ [DECKS_STORAGE_KEY]: '{not json' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadDecks();
    warn.mockRestore();

    // `corrupt` is what stops `useDecks` writing a starter deck over the blob —
    // a second, and unrecoverable, way to lose the same decks.
    expect(result).toEqual({ decks: [], corrupt: true });
    expect(storageNotices()[0]!.reason).toBe('unreadable');
  });

  it('does NOT flag corrupt when simply nothing has been saved', () => {
    installStorage();
    expect(loadDecks()).toEqual({ decks: [], corrupt: false });
    expect(storageNotices()).toEqual([]);
  });
});
