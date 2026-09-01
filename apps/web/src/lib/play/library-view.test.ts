/**
 * §3.66 — what the library list SAYS, and the ordering that makes forks legible.
 */
import { describe, expect, it } from 'vitest';
import { libraryRows, outcomeText } from './library-view.js';
import type { HistoryEntry } from './history.js';
import type { PlayRecord } from './persist.js';
import { PLAY_RECORD_VERSION } from './persist.js';

function record(turn = 3, actions = 12, ai = true): PlayRecord {
  return {
    version: PLAY_RECORD_VERSION,
    savedAt: 1,
    setup: {
      names: { A: 'Player 1', B: 'Computer' },
      deckA: { name: 'Selesnya Blink', archetype: 'Midrange', cards: [] },
      deckB: { name: 'Mono-Red Aggro', archetype: 'Aggro', cards: [] },
      startingPlayer: 'A',
      seed: 99,
      ...(ai ? { ai: { seat: 'B', pilotId: 'lookahead' } } : {}),
    },
    mulligans: [],
    actions: Array.from({ length: actions }, () => ({ kind: 'passPriority', player: 'A' })),
    ui: { revealed: null, scrollY: 0, turn },
  } as unknown as PlayRecord;
}

function entry(id: string, over: Partial<HistoryEntry> = {}): HistoryEntry {
  return { id, record: record(), outcome: { kind: 'unfinished' }, createdAt: 1, updatedAt: 1, ...over };
}

describe('a library row reads like a game', () => {
  const row = libraryRows([entry('a', { record: record(7, 30) })])[0]!;

  it('names the players, the decks and the mode', () => {
    expect(row.title).toBe('Player 1 vs Computer');
    expect(row.decks).toBe('Selesnya Blink vs Mono-Red Aggro');
    expect(row.mode).toBe('Solo');
    expect(row.turn).toBe(7);
    expect(row.actions).toBe(30);
  });

  it('says pass-and-play when no seat is the computer', () => {
    expect(libraryRows([entry('a', { record: record(2, 4, false) })])[0]?.mode).toBe('pass-and-play');
  });

  it('reads the outcome as a sentence, naming the winner', () => {
    expect(outcomeText(entry('a'))).toBe('in progress');
    expect(outcomeText(entry('a', { outcome: { kind: 'win', winner: 'A', reason: 'life' } }))).toBe(
      'Player 1 won — life',
    );
    expect(outcomeText(entry('a', { outcome: { kind: 'win', winner: 'B', reason: 'life' } }))).toBe(
      'Computer won — life',
    );
    expect(outcomeText(entry('a', { outcome: { kind: 'draw', reason: 'turn limit' } }))).toBe('draw — turn limit');
  });

  it('marks only unfinished games resumable', () => {
    expect(libraryRows([entry('a')])[0]?.resumable).toBe(true);
    const done = entry('a', { outcome: { kind: 'win', winner: 'A', reason: 'life' } });
    expect(libraryRows([done])[0]?.resumable).toBe(false);
  });
});

describe('forks are visibly connected to what they came from', () => {
  const entries: readonly HistoryEntry[] = [
    entry('root', { createdAt: 1, updatedAt: 10 }),
    entry('f1', { parentId: 'root', forkedAt: 5, createdAt: 2, updatedAt: 20 }),
    entry('f1a', { parentId: 'f1', forkedAt: 8, createdAt: 3, updatedAt: 30 }),
    entry('other', { createdAt: 4, updatedAt: 5 }),
  ];
  const rows = libraryRows(entries);
  const byId = new Map(rows.map((r) => [r.id, r]));

  it('places every fork directly under the game it forked from', () => {
    // NOT recency order (which would be f1a, f1, root, other) — lineage order.
    expect(rows.map((r) => r.id)).toEqual(['root', 'f1', 'f1a', 'other']);
  });

  it('indents by fork depth', () => {
    expect(byId.get('root')?.depth).toBe(0);
    expect(byId.get('f1')?.depth).toBe(1);
    expect(byId.get('f1a')?.depth).toBe(2);
    expect(byId.get('other')?.depth).toBe(0);
  });

  it('says in words what each fork came from and where it split', () => {
    expect(byId.get('f1')?.forkedFrom).toContain('at action 5');
    expect(byId.get('f1a')?.forkedFrom).toContain('at action 8');
    expect(byId.get('root')?.forkedFrom).toBeUndefined();
  });

  it('counts the direct forks of each game', () => {
    expect(byId.get('root')?.forkCount).toBe(1);
    expect(byId.get('f1')?.forkCount).toBe(1);
    expect(byId.get('f1a')?.forkCount).toBe(0);
  });

  it('gives one lineage a shared root id, and an unrelated game its own', () => {
    expect(byId.get('f1a')?.rootId).toBe('root');
    expect(byId.get('f1')?.rootId).toBe('root');
    expect(byId.get('other')?.rootId).toBe('other');
  });

  it('orders lineages by their most recent activity, newest first', () => {
    // 'other' was last touched at 5; the root lineage at 30 — so it comes first.
    expect(rows[0]?.id).toBe('root');
    expect(rows.at(-1)?.id).toBe('other');
  });

  it('never hides a game whose lineage cannot be resolved', () => {
    const orphan = [entry('kid', { parentId: 'ghost', forkedAt: 2 })];
    expect(libraryRows(orphan).map((r) => r.id)).toEqual(['kid']);
    // No parent to name, so no fork sentence rather than a broken one.
    expect(libraryRows(orphan)[0]?.forkedFrom).toBeUndefined();
  });

  it('emits each game exactly once', () => {
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
