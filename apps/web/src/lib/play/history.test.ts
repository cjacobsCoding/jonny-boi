/**
 * §3.66 — the game library: every game kept, deletable, forkable.
 *
 * The properties pinned here are the ones a careless change would quietly break
 * and no other test would notice:
 *  - a FORK SHARES ITS PARENT'S SEED (otherwise it is a different game, and the
 *    whole point of forking a deck-tuning lab game is that only the DECISION
 *    changed, not the shuffle);
 *  - pruning never drops an UNFINISHED game;
 *  - a corrupt entry costs its own row, not the whole library;
 *  - lineage cannot hang on a deleted parent or a cyclic pointer.
 */
import { describe, expect, it } from 'vitest';
import {
  childrenOf,
  decodeHistory,
  deleteEntry,
  encodeHistory,
  findEntry,
  forkEntry,
  isUnfinished,
  lineageOf,
  readHistory,
  rootOf,
  updateHistory,
  upsertEntry,
  writeHistory,
  type HistoryEntry,
} from './history.js';
import { PLAY_HISTORY_STORAGE_KEY } from '../config.js';
import type { PlayRecord } from './persist.js';
import { PLAY_RECORD_VERSION } from './persist.js';
import type { PlayStorage } from './persist.js';

const SEED = 0xc0ffee;

function record(actions: number, seed: number = SEED): PlayRecord {
  return {
    version: PLAY_RECORD_VERSION,
    savedAt: 1,
    setup: {
      names: { A: 'Player 1', B: 'Computer' },
      deckA: { name: 'Selesnya Blink', archetype: 'Midrange', cards: [{ cardId: 'Forest', count: 60 }] },
      deckB: { name: 'Mono-Red Aggro', archetype: 'Aggro', cards: [{ cardId: 'Mountain', count: 60 }] },
      startingPlayer: 'A',
      seed,
    },
    mulligans: [],
    // The engine only needs these to be action-shaped objects for replay; the
    // library never interprets them, it only counts and slices them.
    actions: Array.from({ length: actions }, (_, i) => ({ kind: 'passPriority', player: i % 2 ? 'B' : 'A' })),
    ui: { revealed: null, scrollY: 0, turn: 1 },
  } as unknown as PlayRecord;
}

function entry(id: string, over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    record: record(10),
    outcome: { kind: 'unfinished' },
    createdAt: 100,
    updatedAt: 100,
    ...over,
  };
}

const FINISHED = { kind: 'win', winner: 'A', reason: 'life' } as const;

/** An in-memory PlayStorage, so storage behaviour is testable without a DOM. */
function memoryStorage(initial: Record<string, string> = {}): PlayStorage & { readonly map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('forking', () => {
  it('shares the parent seed and setup exactly — only the decision differs', () => {
    const parent = entry('p', { record: record(20) });
    const fork = forkEntry(parent, 8, 'f', 500);
    expect(fork.record.setup.seed).toBe(parent.record.setup.seed);
    expect(fork.record.setup).toEqual(parent.record.setup);
  });

  it('inherits exactly the actions up to the scrub point, and no more', () => {
    const parent = entry('p', { record: record(20) });
    const fork = forkEntry(parent, 8, 'f', 500);
    expect(fork.record.actions).toHaveLength(8);
    expect(fork.record.actions).toEqual(parent.record.actions.slice(0, 8));
    expect(fork.forkedAt).toBe(8);
    expect(fork.parentId).toBe('p');
  });

  it('starts unfinished even when forked from a finished game', () => {
    const parent = entry('p', { record: record(20), outcome: FINISHED });
    expect(isUnfinished(forkEntry(parent, 20, 'f', 1))).toBe(true);
  });

  it('clamps an out-of-range scrub point instead of throwing', () => {
    const parent = entry('p', { record: record(5) });
    expect(forkEntry(parent, 999, 'a', 1).record.actions).toHaveLength(5);
    expect(forkEntry(parent, -3, 'b', 1).record.actions).toHaveLength(0);
    expect(forkEntry(parent, 2.7, 'c', 1).record.actions).toHaveLength(2);
  });

  it('leaves the parent untouched', () => {
    const parent = entry('p', { record: record(20) });
    forkEntry(parent, 3, 'f', 1);
    expect(parent.record.actions).toHaveLength(20);
    expect(parent.outcome.kind).toBe('unfinished');
  });
});

describe('the library list', () => {
  it('keeps newest first and replaces rather than duplicates on re-save', () => {
    let list = upsertEntry([], entry('a', { updatedAt: 1 }));
    list = upsertEntry(list, entry('b', { updatedAt: 2 }));
    list = upsertEntry(list, entry('a', { updatedAt: 3 }));
    expect(list.map((e) => e.id)).toEqual(['a', 'b']);
    expect(list).toHaveLength(2);
  });

  it('prunes the oldest FINISHED games and never an unfinished one', () => {
    let list: readonly HistoryEntry[] = [];
    // Three finished games, oldest first, then two unfinished ones.
    for (let i = 0; i < 3; i++) {
      list = upsertEntry(list, entry(`done${i}`, { outcome: FINISHED, updatedAt: i }), 4);
    }
    list = upsertEntry(list, entry('live1', { updatedAt: 10 }), 4);
    list = upsertEntry(list, entry('live2', { updatedAt: 11 }), 4);
    expect(list).toHaveLength(4);
    expect(list.map((e) => e.id)).toContain('live1');
    expect(list.map((e) => e.id)).toContain('live2');
    // The oldest finished game is the one that went.
    expect(list.map((e) => e.id)).not.toContain('done0');
  });

  it('keeps every unfinished game even past the cap — losing one is unacceptable', () => {
    let list: readonly HistoryEntry[] = [];
    for (let i = 0; i < 6; i++) list = upsertEntry(list, entry(`live${i}`, { updatedAt: i }), 3);
    expect(list).toHaveLength(6);
    expect(list.every(isUnfinished)).toBe(true);
  });

  it('deletes by id and finds by id', () => {
    const list = upsertEntry(upsertEntry([], entry('a')), entry('b'));
    expect(findEntry(list, 'a')?.id).toBe('a');
    expect(findEntry(deleteEntry(list, 'a'), 'a')).toBeNull();
    expect(deleteEntry(list, 'nope')).toHaveLength(2);
  });
});

describe('lineage', () => {
  const tree: readonly HistoryEntry[] = [
    entry('root', { createdAt: 1 }),
    entry('f1', { parentId: 'root', forkedAt: 4, createdAt: 2 }),
    entry('f2', { parentId: 'root', forkedAt: 9, createdAt: 3 }),
    entry('f1a', { parentId: 'f1', forkedAt: 6, createdAt: 4 }),
    entry('unrelated', { createdAt: 5 }),
  ];

  it('walks a fork of a fork back to the original playthrough', () => {
    expect(rootOf(tree, 'f1a')).toBe('root');
    expect(rootOf(tree, 'root')).toBe('root');
    expect(rootOf(tree, 'unrelated')).toBe('unrelated');
  });

  it('groups a playthrough with all of its forks, and nothing else', () => {
    expect(lineageOf(tree, 'f2').map((e) => e.id)).toEqual(['root', 'f1', 'f2', 'f1a']);
    expect(lineageOf(tree, 'unrelated').map((e) => e.id)).toEqual(['unrelated']);
  });

  it('lists direct forks only', () => {
    expect(childrenOf(tree, 'root').map((e) => e.id)).toEqual(['f1', 'f2']);
    expect(childrenOf(tree, 'f1').map((e) => e.id)).toEqual(['f1a']);
  });

  it('survives a deleted parent — an orphan is its own root, not a crash', () => {
    const orphaned = deleteEntry(tree, 'f1');
    expect(rootOf(orphaned, 'f1a')).toBe('f1a');
    expect(() => lineageOf(orphaned, 'f1a')).not.toThrow();
  });

  it('cannot hang on a cyclic parent pointer', () => {
    const cyclic = [entry('x', { parentId: 'y' }), entry('y', { parentId: 'x' })];
    expect(() => rootOf(cyclic, 'x')).not.toThrow();
    expect(['x', 'y']).toContain(rootOf(cyclic, 'x'));
  });
});

describe('storage', () => {
  it('round-trips through encode/decode', () => {
    const list = [entry('a'), entry('b', { outcome: FINISHED, parentId: 'a', forkedAt: 3 })];
    const back = decodeHistory(encodeHistory(list));
    expect(back).toHaveLength(2);
    expect(back[1]?.parentId).toBe('a');
    expect(back[1]?.forkedAt).toBe(3);
    expect(back[0]?.record.setup.seed).toBe(SEED);
  });

  it('drops only the corrupt entry, keeping the rest of the library', () => {
    const good = entry('good');
    const raw = JSON.stringify({
      version: 1,
      entries: [good, { id: 'bad', outcome: { kind: 'unfinished' }, createdAt: 1, updatedAt: 1, record: { nope: true } }],
    });
    const back = decodeHistory(raw);
    expect(back.map((e) => e.id)).toEqual(['good']);
  });

  it('refuses an alien or unversioned blob without throwing', () => {
    expect(decodeHistory('not json')).toEqual([]);
    expect(decodeHistory(JSON.stringify({ version: 999, entries: [entry('a')] }))).toEqual([]);
    expect(decodeHistory(JSON.stringify({ version: 1, entries: 'nope' }))).toEqual([]);
  });

  it('reads and writes through storage, and reads empty when storage is absent', () => {
    const storage = memoryStorage();
    writeHistory([entry('a')], storage);
    expect(readHistory(storage).map((e) => e.id)).toEqual(['a']);
    expect(readHistory(null)).toEqual([]);
    expect(storage.map.has(PLAY_HISTORY_STORAGE_KEY)).toBe(true);
  });

  it('never throws when storage does', () => {
    const hostile: PlayStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => readHistory(hostile)).not.toThrow();
    expect(readHistory(hostile)).toEqual([]);
    expect(() => writeHistory([entry('a')], hostile)).not.toThrow();
  });

  it('updateHistory is the read-change-write funnel', () => {
    const storage = memoryStorage();
    updateHistory((list) => upsertEntry(list, entry('a')), storage);
    updateHistory((list) => upsertEntry(list, entry('b')), storage);
    const after = updateHistory((list) => deleteEntry(list, 'a'), storage);
    expect(after.map((e) => e.id)).toEqual(['b']);
    expect(readHistory(storage).map((e) => e.id)).toEqual(['b']);
  });
});
