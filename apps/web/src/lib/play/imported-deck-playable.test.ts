/**
 * A DECK WITH IMPORTED CARDS MUST BE PLAYABLE.
 *
 * The app imports a card, compiles it, shows it in the browser, lets you put it in
 * a deck, and reports the deck healthy — and then every play path refused to start,
 * because `hotseatPool()` was the CURATED pool alone. A 60-card scanned deck failed
 * with `unknown card "<uuid>" (not in the pool by id or name)` and `deck size 52 is
 * below the minimum of 60`, the missing eight being two imported cards that silently
 * did not resolve.
 *
 * `importedDefinitions()` was written FOR this — its own doc says "for
 * `loadCardPool({ extraCards })`" — and nothing passed it. So the invariant worth
 * pinning is not "this one card works" but: **anything the store calls playable is
 * playable by the local play paths.**
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { CardDefinition } from '@jonny-boi/core';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import {
  clearImportedCards,
  importedDefinitions,
  registerImportedCards,
} from '../decklist/importedCards.js';
import {
  hotseatPool,
  invalidateHotseatPool,
  validateChoice,
  validateChoiceForOnline,
} from './setup.js';
import type { Deck as WebDeck } from '../deck.js';

/** A card that is NOT in the curated pool, standing in for a scanned import. */
const IMPORTED_ID = 'test-imported-0000-0000-000000000001';
const IMPORTED_DEF: CardDefinition = {
  id: IMPORTED_ID,
  name: 'Imported Test Bear',
  types: ['creature'],
  cost: { generic: 1, G: 1 },
  power: 2,
  toughness: 2,
};
const IMPORTED_RECORD = {
  id: IMPORTED_ID,
  name: 'Imported Test Bear',
  typeLine: 'Creature — Bear',
  manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
} as unknown as NormalizedCard;

/** A basic land from the curated pool, to pad the deck to legal size. */
const FOREST_NAME = 'Forest';

/**
 * A legal 60-card deck: `importedCount` copies of the import, the rest basic
 * Forest. Capped at the 4-of limit — an earlier version of this fixture asked for
 * eight and failed on the copy limit rather than on what it meant to test, which
 * is the same class of self-inflicted fixture bug §3.42 recorded.
 */
function deckWith(importedCount: number): WebDeck {
  return {
    id: 'deck-under-test',
    name: 'Scanned deck',
    updatedAt: new Date(0).toISOString(),
    cards: [
      { cardId: IMPORTED_ID, count: importedCount },
      { cardId: FOREST_NAME, count: 60 - importedCount },
    ],
  } as unknown as WebDeck;
}

describe('a deck holding imported cards', () => {
  beforeEach(() => {
    clearImportedCards();
    invalidateHotseatPool();
  });

  it('is REJECTED when the card was never imported — the id resolves to nothing', () => {
    // The control. Without this the test below could pass for the wrong reason
    // (e.g. the validator quietly ignoring unknown ids).
    const problems = validateChoice({ source: 'saved', deck: deckWith(4) });
    // Refused through the ONE support funnel now (deckHealth), not by the sim's
    // raw 'unknown card <uuid>': the id resolves to nothing, so the deck is not
    // playable — and it says so in words rather than echoing the uuid.
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toMatch(/can’t be played or tested/);
  });

  it('is PLAYABLE once the card is in the imported store', () => {
    registerImportedCards([{ card: IMPORTED_RECORD, definition: IMPORTED_DEF }]);
    invalidateHotseatPool();
    expect(validateChoice({ source: 'saved', deck: deckWith(4) })).toEqual([]);
  });

  it('puts every playable imported definition in the pool — the general invariant', () => {
    registerImportedCards([{ card: IMPORTED_RECORD, definition: IMPORTED_DEF }]);
    invalidateHotseatPool();
    const pool = hotseatPool();
    for (const def of importedDefinitions()) {
      expect(pool.get(def.id), def.name + ' is playable but missing from the play pool').toBeDefined();
    }
  });

  it('does NOT admit an import that failed to compile', () => {
    // The honesty line: an unplayable card must never reach a simulation.
    registerImportedCards([{ card: IMPORTED_RECORD, missing: [] }]);
    invalidateHotseatPool();
    expect(hotseatPool().get(IMPORTED_ID)).toBeUndefined();
    const said = validateChoice({ source: 'saved', deck: deckWith(4) }).join(' ');
    expect(said).toMatch(/can’t be played or tested/);
    expect(said, 'the failed import is named, not its uuid').toContain('Imported Test Bear');
  });

  it('never lets an import shadow a curated card of the same id', () => {
    const forest = hotseatPool().cards.find((c) => c.name === FOREST_NAME);
    expect(forest).toBeDefined();
    const impostor: CardDefinition = { ...IMPORTED_DEF, id: forest!.id, name: 'Not A Forest' };
    registerImportedCards([{ card: { ...IMPORTED_RECORD, id: forest!.id }, definition: impostor }]);
    invalidateHotseatPool();
    expect(hotseatPool().get(forest!.id)?.name, 'the curated definition must win').toBe(FOREST_NAME);
  });

  it('is still REFUSED for ONLINE play, by name and with a reason', () => {
    // The server rebuilds decks from its OWN curated pool and the wire format
    // carries no definitions, so passing this locally would be a false green:
    // the lobby would say ready and the server would then reject the deck.
    registerImportedCards([{ card: IMPORTED_RECORD, definition: IMPORTED_DEF }]);
    invalidateHotseatPool();
    const local = validateChoice({ source: 'saved', deck: deckWith(4) });
    const online = validateChoiceForOnline({ source: 'saved', deck: deckWith(4) });
    expect(local, 'local play accepts it').toEqual([]);
    expect(online.length, 'online play must not').toBeGreaterThan(0);
    expect(online.join(' '), 'name the card, never echo a bare uuid').toContain('Imported Test Bear');
    expect(online.join(' ')).not.toContain(IMPORTED_ID);
  });

  it('sees a card imported AFTER the pool was first built', () => {
    // The memo bug: importing mid-session must not require a page reload.
    hotseatPool(); // build and memoize with an empty store
    registerImportedCards([{ card: IMPORTED_RECORD, definition: IMPORTED_DEF }]);
    expect(hotseatPool().get(IMPORTED_ID), 'the store change must invalidate the memo').toBeDefined();
  });
});
