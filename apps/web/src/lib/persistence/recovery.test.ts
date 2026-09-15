import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { PLAY_HISTORY_STORAGE_KEY, PLAY_RESUME_STORAGE_KEY } from '../config.js';
import { PLAY_RECORD_VERSION, type PlayRecord } from '../play/persist.js';
import { HISTORY_VERSION } from '../play/history.js';
import type { Deck } from '../deck.js';
import { asDeck, recoverableDecks } from './recovery.js';

/**
 * The honesty test for recovery.
 *
 * A deck lost to a failed write is GONE — it was never on disk. The danger in
 * shipping a "recover your decks" surface is that it implies otherwise, and a
 * user who believes a lost deck is retrievable stops looking for the decklist
 * they still have somewhere else. So the property pinned hardest here is the
 * NEGATIVE one: nothing is offered unless it is demonstrably still stored.
 */

const MINE = {
  name: 'Caleb Burn',
  archetype: 'Aggro',
  cards: [
    { cardId: 'card-bolt', count: 4, name: 'Lightning Bolt' },
    { cardId: 'card-mountain', count: 20, name: 'Mountain' },
  ],
};

function playRecord(deckA: unknown, deckB: unknown, savedAt = 5_000): PlayRecord {
  return {
    version: PLAY_RECORD_VERSION,
    savedAt,
    setup: {
      names: { A: 'You', B: 'Computer' },
      deckA,
      deckB,
      startingPlayer: 'A',
      seed: 7,
    },
    mulligans: [],
    actions: [],
    ui: { revealed: null, scrollY: 0, turn: 1 },
  } as unknown as PlayRecord;
}

/** Seed a fake localStorage with an in-progress game and/or a library. */
function install(seed: Record<string, string>): void {
  const map = new Map(Object.entries(seed));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
}

function libraryOf(records: PlayRecord[]): string {
  return JSON.stringify({
    version: HISTORY_VERSION,
    entries: records.map((record, i) => ({
      id: `e${i}`,
      record,
      outcome: { kind: 'win', winner: 'A', reason: 'damage' },
      createdAt: 1000 + i,
      updatedAt: 1000 + i,
    })),
  });
}

describe('recovery offers only what is genuinely still stored', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('offers nothing at all when storage is empty — the common, correct answer', () => {
    install({});
    expect(recoverableDecks([])).toEqual([]);
  });

  it('finds a deck that is inside the in-progress game but not in the deck list', () => {
    install({ [PLAY_RESUME_STORAGE_KEY]: JSON.stringify(playRecord(MINE, SAMPLE_DECKS[0])) });
    const found = recoverableDecks([]);

    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('Caleb Burn');
    expect(found[0]!.source).toBe('the game in progress');
    // The entries come back whole, names included, because the record stores
    // decks RESOLVED rather than by reference.
    expect(found[0]!.cards).toEqual([
      { cardId: 'card-bolt', count: 4, name: 'Lightning Bolt' },
      { cardId: 'card-mountain', count: 20, name: 'Mountain' },
    ]);
  });

  it('finds one in the game library too', () => {
    install({ [PLAY_HISTORY_STORAGE_KEY]: libraryOf([playRecord(MINE, SAMPLE_DECKS[0])]) });
    const found = recoverableDecks([]);
    expect(found).toHaveLength(1);
    expect(found[0]!.source).toBe('the game library');
  });

  it('never offers a deck the user already has, matching on CONTENT not name', () => {
    install({ [PLAY_RESUME_STORAGE_KEY]: JSON.stringify(playRecord(MINE, SAMPLE_DECKS[0])) });
    // Same cards, different local name and id — still the same deck.
    const saved: Deck = {
      id: 'd1',
      name: 'renamed since',
      cards: [
        { cardId: 'card-bolt', count: 4 },
        { cardId: 'card-mountain', count: 20 },
      ],
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(recoverableDecks([saved])).toEqual([]);
  });

  /**
   * Without this, every game ever played would offer its opponent back, and the
   * one row that matters would be buried under gauntlet decks the user never
   * made. The discriminator is their name, which is fixed data in the sim.
   */
  it('never offers a built-in gauntlet deck as something you lost', () => {
    install({
      [PLAY_RESUME_STORAGE_KEY]: JSON.stringify(
        playRecord(SAMPLE_DECKS[0], SAMPLE_DECKS[1 % SAMPLE_DECKS.length]),
      ),
    });
    expect(recoverableDecks([])).toEqual([]);
  });

  it('offers one row for a deck played many times, preferring the live game', () => {
    install({
      [PLAY_RESUME_STORAGE_KEY]: JSON.stringify(playRecord(MINE, SAMPLE_DECKS[0], 9_000)),
      [PLAY_HISTORY_STORAGE_KEY]: libraryOf([
        playRecord(MINE, SAMPLE_DECKS[0], 1),
        playRecord(MINE, SAMPLE_DECKS[0], 2),
      ]),
    });
    const found = recoverableDecks([]);
    expect(found).toHaveLength(1);
    expect(found[0]!.source).toBe('the game in progress');
  });

  it('offers nothing when the stored records are corrupt', () => {
    // An unreadable record is not a recovery source. This function only ever
    // ADDS options, so finding none is a smaller answer, never a wrong one.
    install({
      [PLAY_RESUME_STORAGE_KEY]: '{not json',
      [PLAY_HISTORY_STORAGE_KEY]: '{also not json',
    });
    expect(recoverableDecks([])).toEqual([]);
  });

  it('turns an offer into a real saved deck', () => {
    install({ [PLAY_RESUME_STORAGE_KEY]: JSON.stringify(playRecord(MINE, SAMPLE_DECKS[0])) });
    const deck = asDeck(recoverableDecks([])[0]!, 1_700_000_000_000);

    expect(deck.name).toBe('Caleb Burn');
    expect(deck.cards).toHaveLength(2);
    expect(deck.id).toMatch(/^recovered-/);
    expect(() => new Date(deck.updatedAt).toISOString()).not.toThrow();
  });
});
