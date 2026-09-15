import { beforeEach, describe, expect, it } from 'vitest';
import { DECKS_STORAGE_KEY, PLAY_HISTORY_STORAGE_KEY, SUGGESTION_HISTORY_KEY_PREFIX } from '../config.js';
import { PROXY_CACHE_STORAGE_KEY } from '../proxy/config.js';
import {
  ORIGIN_STORAGE_BUDGET_CHARS,
  STORAGE_BUDGET_HEADROOM_SHARE,
  TYPICAL_GAME_RECORD_CHARS,
  allocatedLocalShare,
  historyGameLimit,
  writeBudgetChars,
} from './budget.js';
import {
  clearStorageArea,
  formatChars,
  measureStorage,
  type EnumerableStorage,
} from './usage.js';

/** An in-memory enumerable storage — the readout needs `length`/`key(i)`. */
function fakeStorage(seed: Record<string, string> = {}): EnumerableStorage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    removeItem: (k: string) => void map.delete(k),
  };
}

describe('the storage readout', () => {
  it('attributes every stored key to the area that owns it', () => {
    const storage = fakeStorage({
      [DECKS_STORAGE_KEY]: 'x'.repeat(1000),
      [PLAY_HISTORY_STORAGE_KEY]: 'y'.repeat(2000),
      [`${SUGGESTION_HISTORY_KEY_PREFIX}.v1.heuristic.aaa`]: 'z'.repeat(50),
      [`${SUGGESTION_HISTORY_KEY_PREFIX}.v1.heuristic.bbb`]: 'z'.repeat(70),
    });
    const usage = measureStorage(storage);
    const byId = new Map(usage.areas.map((a) => [a.area.id, a]));

    // Key names count toward a browser quota too, so they count here.
    expect(byId.get('decks')!.chars).toBe(1000 + DECKS_STORAGE_KEY.length);
    expect(byId.get('play-history')!.chars).toBe(2000 + PLAY_HISTORY_STORAGE_KEY.length);
    // A prefixed family folds its many keys into one row.
    expect(byId.get('suggestion-history')!.keys).toBe(2);
    expect(usage.unattributed.keys).toEqual([]);
  });

  it('REPORTS what it cannot attribute instead of hiding it in the total', () => {
    // Something else on the origin is exactly what made this failure a mystery.
    // A total that silently excluded it would be the same lie in a new place.
    const storage = fakeStorage({ 'some-other-app.blob': 'q'.repeat(5000) });
    const usage = measureStorage(storage);

    expect(usage.unattributed.keys).toEqual(['some-other-app.blob']);
    expect(usage.unattributed.chars).toBe(5000 + 'some-other-app.blob'.length);
    expect(usage.totalChars).toBe(usage.unattributed.chars);
  });

  it('orders areas largest-first, because the question is what to clear', () => {
    const storage = fakeStorage({
      [DECKS_STORAGE_KEY]: 'x'.repeat(100),
      [PLAY_HISTORY_STORAGE_KEY]: 'y'.repeat(9000),
      [PROXY_CACHE_STORAGE_KEY]: 'z'.repeat(3000),
    });
    const ids = measureStorage(storage).areas.map((a) => a.area.id);
    expect(ids.slice(0, 3)).toEqual(['play-history', 'proxy-cache', 'decks']);
  });

  it('reads as empty rather than throwing when there is no storage', () => {
    const usage = measureStorage(null);
    expect(usage.totalChars).toBe(0);
    expect(usage.areas.every((a) => a.chars === 0)).toBe(true);
  });

  it('clears a clearable area and leaves the others alone', () => {
    const storage = fakeStorage({
      [DECKS_STORAGE_KEY]: 'deck',
      [PLAY_HISTORY_STORAGE_KEY]: 'games',
      [`${SUGGESTION_HISTORY_KEY_PREFIX}.v1.a.b`]: 'one',
      [`${SUGGESTION_HISTORY_KEY_PREFIX}.v1.a.c`]: 'two',
    });
    expect(clearStorageArea('suggestion-history', storage)).toBe(2);
    expect(storage.getItem(DECKS_STORAGE_KEY)).toBe('deck');
    expect(storage.getItem(PLAY_HISTORY_STORAGE_KEY)).toBe('games');
  });

  /**
   * The one that matters. `clearable: false` is a property of the TABLE, not of
   * whether a button happens to be rendered — so a second caller cannot wipe the
   * user's decks by passing the wrong id.
   */
  it('REFUSES to clear the saved decks, whoever asks', () => {
    const storage = fakeStorage({ [DECKS_STORAGE_KEY]: 'the only copy' });
    expect(clearStorageArea('decks', storage)).toBe(0);
    expect(storage.getItem(DECKS_STORAGE_KEY)).toBe('the only copy');
  });

  it('formats sizes in units a person reads', () => {
    expect(formatChars(400)).toBe('400 characters');
    expect(formatChars(12_000)).toBe('12 KB');
    expect(formatChars(2_500_000)).toBe('2.5 MB');
  });
});

describe('the budget divides one origin, and says where its numbers came from', () => {
  it('leaves real headroom rather than committing the whole origin', () => {
    expect(allocatedLocalShare()).toBeLessThanOrEqual(1 - STORAGE_BUDGET_HEADROOM_SHARE);
  });

  it('gives the in-progress game room for a game far longer than any measured', () => {
    // The measurement: 12 real games, max 47,341 characters. A human game makes
    // more decisions per turn, so the budget carries a multiple of the max seen
    // rather than sitting on it.
    expect(writeBudgetChars('play-in-progress')).toBeGreaterThan(TYPICAL_GAME_RECORD_CHARS * 3);
  });

  it('derives the library game count from the budget, so the two cannot disagree', () => {
    const limit = historyGameLimit();
    expect(limit).toBeGreaterThan(0);
    expect(limit * TYPICAL_GAME_RECORD_CHARS).toBeLessThanOrEqual(
      writeBudgetChars('play-history'),
    );
    // And the whole library still fits inside the origin alongside everything
    // else — the property the old 4,000,000-character cap did not have.
    expect(writeBudgetChars('play-history')).toBeLessThan(ORIGIN_STORAGE_BUDGET_CHARS / 2);
  });
});
