/**
 * The Lab's persistence of a deck's tuning record.
 *
 * The engine is storage-free by design — it hands its memory back as JSON and
 * relies on the caller to keep it. So this thin layer is where the user-visible
 * bug actually lives or dies: lose the record and the search has amnesia and
 * re-derives the same shortlist ("it just started comparing to Eternal Witness
 * AGAIN"); reuse the WRONG record and the search is steered by numbers measured on
 * a different decklist — or, since the pilot became selectable, at a different
 * level of play, which is the same mistake wearing a different hat.
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
import { SELECTABLE_PILOT_IDS } from '@jonny-boi/ai';
import {
  clearSuggestionHistory,
  historyRejectionText,
  legacySuggestionHistoryKey,
  otherPilotHistories,
  readSuggestionHistory,
  suggestionHistoryKey,
  writeSuggestionHistory,
  type HistoryStorage,
} from './history-store.js';
import { DEFAULT_PILOT_ID } from './pilots.js';

const DECK: Deck = SAMPLE_DECKS[0] as Deck;

/**
 * The two pilots the partition tests use. DERIVED from the ai package's list
 * rather than spelled out, so this suite keeps testing "two different pilots" even
 * if the ids are renamed or the default moves.
 */
const PILOT = DEFAULT_PILOT_ID;
const OTHER_PILOT = SELECTABLE_PILOT_IDS.find((id) => id !== DEFAULT_PILOT_ID) as string;

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

/** Store a raw value under the key a given pilot's record lives at. */
function putRaw(storage: HistoryStorage, pilotId: string, value: unknown): void {
  storage.setItem(
    suggestionHistoryKey(deckFingerprint(DECK), pilotId),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

describe('the tuning record round-trips', () => {
  it('writes a record and reads it back unchanged', () => {
    const { storage } = fakeStorage();
    const history = historyFor(DECK);
    writeSuggestionHistory(history, PILOT, storage);
    expect(readSuggestionHistory(DECK, PILOT, storage)).toEqual({ history });
  });

  it('files it under the deck’s CONTENT, so two decks keep two records', () => {
    const { storage, map } = fakeStorage();
    const other: Deck = { ...DECK, name: 'Other', cards: DECK.cards.slice(1) };
    writeSuggestionHistory(historyFor(DECK), PILOT, storage);
    writeSuggestionHistory(historyFor(other), PILOT, storage);

    expect(map.size).toBe(2);
    expect(readSuggestionHistory(DECK, PILOT, storage).history?.deckFingerprint).toBe(
      deckFingerprint(DECK),
    );
    expect(readSuggestionHistory(other, PILOT, storage).history?.deckFingerprint).toBe(
      deckFingerprint(other),
    );
  });

  it('reports "no record" for a deck nobody has tuned — not an error', () => {
    expect(readSuggestionHistory(DECK, PILOT, fakeStorage().storage)).toEqual({});
  });
});

/**
 * THE PARTITION. A tuning record is accumulated EVIDENCE, not a cache: it retires
 * candidates as settled, and its length is the Holm–Bonferroni family size every
 * verdict is corrected against. Pooling two pilots' runs into one record would
 * therefore (a) hide a card one pilot settled that the other would love, and
 * (b) correct a family that mixes tests of two different hypotheses. Both are
 * silent, so they are pinned here.
 */
describe('records are partitioned by PILOT, and nothing is discarded', () => {
  it('keeps a separate record per pilot for the same deck', () => {
    const { storage, map } = fakeStorage();
    const mine = historyFor(DECK);
    writeSuggestionHistory(mine, PILOT, storage);
    writeSuggestionHistory(mine, OTHER_PILOT, storage);

    expect(map.size).toBe(2);
    expect(readSuggestionHistory(DECK, PILOT, storage).history).toEqual(mine);
    expect(readSuggestionHistory(DECK, OTHER_PILOT, storage).history).toEqual(mine);
  });

  it('does not serve one pilot’s evidence to another', () => {
    const { storage } = fakeStorage();
    writeSuggestionHistory(historyFor(DECK), PILOT, storage);
    // The other pilot has never run: it must see NO history, not the first one's.
    expect(readSuggestionHistory(DECK, OTHER_PILOT, storage)).toEqual({});
  });

  it('rejects a record whose envelope names a different pilot', () => {
    // Belt and braces: the key already separates them, but a record that carries
    // its own provenance can refuse to be adopted if a future refactor mis-derives
    // a key — the same reason the deck fingerprint is checked twice.
    const { storage } = fakeStorage();
    putRaw(storage, PILOT, { pilotId: OTHER_PILOT, history: historyFor(DECK) });

    const read = readSuggestionHistory(DECK, PILOT, storage);
    expect(read.history).toBeUndefined();
    expect(read.rejected).toBe('pilot-changed');
    expect(historyRejectionText('pilot-changed')).toMatch(/pilot/);
  });

  it('switching pilot LEAVES the other search intact and reports it', () => {
    // The whole point of partitioning rather than invalidating: a user's evidence
    // can be hours of compute, and changing a dropdown must not spend it.
    const { storage } = fakeStorage();
    writeSuggestionHistory(historyFor(DECK), PILOT, storage);

    const others = otherPilotHistories(DECK, OTHER_PILOT, storage);
    expect(others).toEqual([{ pilotId: PILOT, runsCompleted: 1, candidateCount: 1 }]);

    // …and switching back finds it exactly as it was.
    expect(readSuggestionHistory(DECK, PILOT, storage).history).toEqual(historyFor(DECK));
  });

  it('does not list the current pilot, an unrun pilot, or another deck’s record', () => {
    const { storage } = fakeStorage();
    const other: Deck = { ...DECK, name: 'Other', cards: DECK.cards.slice(1) };
    writeSuggestionHistory(historyFor(DECK), PILOT, storage);
    writeSuggestionHistory(historyFor(other), OTHER_PILOT, storage);

    expect(otherPilotHistories(DECK, PILOT, storage)).toEqual([]);
  });

  it('resetting forgets only the named pilot’s search', () => {
    const { storage } = fakeStorage();
    writeSuggestionHistory(historyFor(DECK), PILOT, storage);
    writeSuggestionHistory(historyFor(DECK), OTHER_PILOT, storage);

    clearSuggestionHistory(DECK, PILOT, storage);
    expect(readSuggestionHistory(DECK, PILOT, storage)).toEqual({});
    expect(readSuggestionHistory(DECK, OTHER_PILOT, storage).history).toBeDefined();
  });
});

/**
 * Records written before the pilot was selectable carry no pilot — but they were
 * all played by the default pilot, because nothing else could be run. Dropping
 * them would silently cost a user every run they had banked.
 */
describe('pre-partition records are adopted, not lost', () => {
  it('hands a legacy record to the default pilot and re-files it', () => {
    const { storage, map } = fakeStorage();
    const legacy = historyFor(DECK);
    storage.setItem(legacySuggestionHistoryKey(deckFingerprint(DECK)), JSON.stringify(legacy));

    expect(readSuggestionHistory(DECK, DEFAULT_PILOT_ID, storage).history).toEqual(legacy);
    // Migrated exactly once: the old key is gone and the new one holds it.
    expect(map.has(legacySuggestionHistoryKey(deckFingerprint(DECK)))).toBe(false);
    expect(map.has(suggestionHistoryKey(deckFingerprint(DECK), DEFAULT_PILOT_ID))).toBe(true);
    expect(readSuggestionHistory(DECK, DEFAULT_PILOT_ID, storage).history).toEqual(legacy);
  });

  it('does NOT hand a legacy record to a non-default pilot', () => {
    const { storage } = fakeStorage();
    storage.setItem(
      legacySuggestionHistoryKey(deckFingerprint(DECK)),
      JSON.stringify(historyFor(DECK)),
    );
    expect(readSuggestionHistory(DECK, OTHER_PILOT, storage)).toEqual({});
  });

  it('keeps the legacy record when the migration write fails', () => {
    // A full quota during migration must not be the moment the evidence dies.
    const { storage, map } = fakeStorage({ failWrites: true });
    const legacy = historyFor(DECK);
    map.set(legacySuggestionHistoryKey(deckFingerprint(DECK)), JSON.stringify(legacy));

    expect(readSuggestionHistory(DECK, DEFAULT_PILOT_ID, storage).history).toEqual(legacy);
    expect(map.has(legacySuggestionHistoryKey(deckFingerprint(DECK)))).toBe(true);
  });
});

describe('a record that does not apply is REJECTED, with a reason', () => {
  it('refuses one gathered on a different decklist', () => {
    // A swap's measured effect is a property of the deck it was measured in, so
    // silently reusing this would steer the search with meaningless numbers.
    const { storage } = fakeStorage();
    putRaw(storage, PILOT, {
      pilotId: PILOT,
      history: { ...historyFor(DECK), deckFingerprint: 'a-different-deck' },
    });

    const read = readSuggestionHistory(DECK, PILOT, storage);
    expect(read.history).toBeUndefined();
    expect(read.rejected).toBe('deck-changed');
    expect(historyRejectionText('deck-changed')).toMatch(/different decklist/);
  });

  it('refuses one written by an incompatible version', () => {
    const { storage } = fakeStorage();
    putRaw(storage, PILOT, {
      pilotId: PILOT,
      history: { ...historyFor(DECK), version: SUGGESTION_HISTORY_VERSION + 99 },
    });
    expect(readSuggestionHistory(DECK, PILOT, storage).rejected).toBe('version');
  });

  it('refuses a corrupt entry instead of white-screening the Lab', () => {
    const { storage } = fakeStorage();
    putRaw(storage, PILOT, '{not json');
    expect(readSuggestionHistory(DECK, PILOT, storage).rejected).toBe('unreadable');

    putRaw(storage, PILOT, { hello: 'world' });
    expect(readSuggestionHistory(DECK, PILOT, storage).rejected).toBe('unreadable');

    // A bare (un-enveloped) record under a pilot key is corruption too: the only
    // legitimate home for that shape is the pre-partition key.
    putRaw(storage, PILOT, historyFor(DECK));
    expect(readSuggestionHistory(DECK, PILOT, storage).rejected).toBe('unreadable');
  });

  it('names every rejection reason in words a user can act on', () => {
    for (const reason of ['deck-changed', 'pilot-changed', 'version', 'unreadable'] as const) {
      expect(historyRejectionText(reason).length).toBeGreaterThan(0);
    }
  });
});

describe('storage failures cost a memory, never a run', () => {
  it('survives storage that refuses to read', () => {
    const { storage } = fakeStorage({ failReads: true });
    expect(readSuggestionHistory(DECK, PILOT, storage).rejected).toBe('unreadable');
    expect(otherPilotHistories(DECK, PILOT, storage)).toEqual([]);
  });

  it('survives storage that refuses to write (a full quota)', () => {
    const { storage } = fakeStorage({ failWrites: true });
    expect(() => writeSuggestionHistory(historyFor(DECK), PILOT, storage)).not.toThrow();
  });

  it('does nothing at all when there is no storage (private browsing)', () => {
    expect(readSuggestionHistory(DECK, PILOT, null)).toEqual({});
    expect(otherPilotHistories(DECK, PILOT, null)).toEqual([]);
    expect(() => writeSuggestionHistory(historyFor(DECK), PILOT, null)).not.toThrow();
    expect(() => clearSuggestionHistory(DECK, PILOT, null)).not.toThrow();
  });
});

describe('resetting', () => {
  it('forgets this deck’s record and leaves every other deck’s alone', () => {
    const { storage } = fakeStorage();
    const other: Deck = { ...DECK, name: 'Other', cards: DECK.cards.slice(1) };
    writeSuggestionHistory(historyFor(DECK), PILOT, storage);
    writeSuggestionHistory(historyFor(other), PILOT, storage);

    clearSuggestionHistory(DECK, PILOT, storage);
    expect(readSuggestionHistory(DECK, PILOT, storage)).toEqual({});
    expect(readSuggestionHistory(other, PILOT, storage).history).toBeDefined();
  });

  it('also drops the pre-partition record, so a reset does not resurrect it', () => {
    const { storage, map } = fakeStorage();
    map.set(legacySuggestionHistoryKey(deckFingerprint(DECK)), JSON.stringify(historyFor(DECK)));

    clearSuggestionHistory(DECK, DEFAULT_PILOT_ID, storage);
    expect(readSuggestionHistory(DECK, DEFAULT_PILOT_ID, storage)).toEqual({});
  });
});
