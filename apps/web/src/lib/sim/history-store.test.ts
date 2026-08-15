/**
 * The Lab's persistence of a deck's tuning record.
 *
 * The engine is storage-free by design — it hands its memory back as JSON and
 * relies on the caller to keep it. So this thin layer is where the user-visible
 * bug actually lives or dies: lose the record and the search has amnesia and
 * re-derives the same shortlist ("it just started comparing to Eternal Witness
 * AGAIN"); reuse the WRONG record and the search is steered by numbers measured on
 * a different decklist, which is worse than having none.
 *
 * Storage is injected, so the failure modes a real `localStorage` will not perform
 * on cue — a throwing quota, a corrupt entry, storage refused outright — are all
 * exercised here rather than hoped about.
 */
import { describe, expect, it } from 'vitest';
import {
  SUGGESTION_HISTORY_VERSION,
  deckFingerprint,
  emptyHistory,
  mergeHistory,
  DEFAULT_EXPLORATION_WEIGHTS,
  SAMPLE_DECKS,
  type Deck,
  type SuggestionHistory,
} from '@jonny-boi/sim';
import {
  clearSuggestionHistory,
  historyRejectionText,
  readSuggestionHistory,
  suggestionHistoryKey,
  writeSuggestionHistory,
  type HistoryStorage,
} from './history-store.js';

const DECK: Deck = SAMPLE_DECKS[0] as Deck;

/** An in-memory `localStorage` whose behaviour a test can bend. */
function fakeStorage(options: { readonly failWrites?: boolean; readonly failReads?: boolean } = {}) {
  const map = new Map<string, string>();
  const storage: HistoryStorage = {
    getItem: (key) => {
      if (options.failReads) throw new Error('storage is blocked');
      return map.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (options.failWrites) throw new Error('quota exceeded');
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
  return { storage, map };
}

/** A record for `deck` with one candidate in it. */
function historyFor(deck: Deck): SuggestionHistory {
  return mergeHistory(
    emptyHistory(deck),
    [
      {
        outId: 'lightning-bolt',
        inId: 'sol-ring',
        outName: 'Lightning Bolt',
        inName: 'Sol Ring',
        gamesPlayed: 26,
        delta: -0.02,
        verdict: 'inconclusive',
        provenNotBetter: false,
      },
    ],
    DEFAULT_EXPLORATION_WEIGHTS,
  );
}

describe('the tuning record round-trips', () => {
  it('writes a record and reads it back unchanged', () => {
    const { storage } = fakeStorage();
    const history = historyFor(DECK);
    writeSuggestionHistory(history, storage);
    expect(readSuggestionHistory(DECK, storage)).toEqual({ history });
  });

  it('files it under the deck’s CONTENT, so two decks keep two records', () => {
    const { storage, map } = fakeStorage();
    const other: Deck = { ...DECK, name: 'Other', cards: DECK.cards.slice(1) };
    writeSuggestionHistory(historyFor(DECK), storage);
    writeSuggestionHistory(historyFor(other), storage);

    expect(map.size).toBe(2);
    expect(readSuggestionHistory(DECK, storage).history?.deckFingerprint).toBe(deckFingerprint(DECK));
    expect(readSuggestionHistory(other, storage).history?.deckFingerprint).toBe(deckFingerprint(other));
  });

  it('reports "no record" for a deck nobody has tuned — not an error', () => {
    expect(readSuggestionHistory(DECK, fakeStorage().storage)).toEqual({});
  });
});

describe('a record that does not apply is REJECTED, with a reason', () => {
  it('refuses one gathered on a different decklist', () => {
    // A swap's measured effect is a property of the deck it was measured in, so
    // silently reusing this would steer the search with meaningless numbers.
    const { storage } = fakeStorage();
    const foreign = { ...historyFor(DECK), deckFingerprint: 'a-different-deck' };
    storage.setItem(suggestionHistoryKey(deckFingerprint(DECK)), JSON.stringify(foreign));

    const read = readSuggestionHistory(DECK, storage);
    expect(read.history).toBeUndefined();
    expect(read.rejected).toBe('deck-changed');
    expect(historyRejectionText('deck-changed')).toMatch(/different decklist/);
  });

  it('refuses one written by an incompatible version', () => {
    const { storage } = fakeStorage();
    const stale = { ...historyFor(DECK), version: SUGGESTION_HISTORY_VERSION + 99 };
    storage.setItem(suggestionHistoryKey(deckFingerprint(DECK)), JSON.stringify(stale));
    expect(readSuggestionHistory(DECK, storage).rejected).toBe('version');
  });

  it('refuses a corrupt entry instead of white-screening the Lab', () => {
    const { storage } = fakeStorage();
    storage.setItem(suggestionHistoryKey(deckFingerprint(DECK)), '{not json');
    expect(readSuggestionHistory(DECK, storage).rejected).toBe('unreadable');

    storage.setItem(suggestionHistoryKey(deckFingerprint(DECK)), JSON.stringify({ hello: 'world' }));
    expect(readSuggestionHistory(DECK, storage).rejected).toBe('unreadable');
  });

  it('names every rejection reason in words a user can act on', () => {
    for (const reason of ['deck-changed', 'version', 'unreadable'] as const) {
      expect(historyRejectionText(reason).length).toBeGreaterThan(0);
    }
  });
});

describe('storage failures cost a memory, never a run', () => {
  it('survives storage that refuses to read', () => {
    const { storage } = fakeStorage({ failReads: true });
    expect(readSuggestionHistory(DECK, storage).rejected).toBe('unreadable');
  });

  it('survives storage that refuses to write (a full quota)', () => {
    const { storage } = fakeStorage({ failWrites: true });
    expect(() => writeSuggestionHistory(historyFor(DECK), storage)).not.toThrow();
  });

  it('does nothing at all when there is no storage (private browsing)', () => {
    expect(readSuggestionHistory(DECK, null)).toEqual({});
    expect(() => writeSuggestionHistory(historyFor(DECK), null)).not.toThrow();
    expect(() => clearSuggestionHistory(DECK, null)).not.toThrow();
  });
});

describe('resetting', () => {
  it('forgets this deck’s record and leaves every other deck’s alone', () => {
    const { storage } = fakeStorage();
    const other: Deck = { ...DECK, name: 'Other', cards: DECK.cards.slice(1) };
    writeSuggestionHistory(historyFor(DECK), storage);
    writeSuggestionHistory(historyFor(other), storage);

    clearSuggestionHistory(DECK, storage);
    expect(readSuggestionHistory(DECK, storage)).toEqual({});
    expect(readSuggestionHistory(other, storage).history).toBeDefined();
  });
});
