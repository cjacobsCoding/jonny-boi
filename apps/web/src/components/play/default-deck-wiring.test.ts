/**
 * THE DECK PICKERS OPEN ON A DECK THAT CAN START — at the component, not only
 * in the helper.
 *
 * `deckMenu.test.ts` proves `defaultSeatKeys` / `firstStartableKey` pick right.
 * That is not the feature. The feature is that the Solo setup and the online
 * lobby CALL them, and a sabotage that put either screen back on `menu[0]`
 * turned no test red — the helper was green and the screen was wrong, which is
 * how `main` sat un-startable for a day. So this renders the real components
 * (the `jail-tile.test.ts` static-markup idiom) and reads which `<option>` each
 * `<select>` actually has selected.
 *
 * The menu is built so the three pickers must answer DIFFERENTLY:
 *   - a short deck        → illegal everywhere (56 cards)
 *   - an imported-bear deck → legal LOCALLY (the import compiled), refused ONLINE
 *                            (the server knows only the curated pool)
 *   - an all-Forest deck  → legal everywhere
 * Solo must open A on the bear deck and B on the Forests; the lobby must skip
 * the bear deck and open on the Forests. A picker that read `menu[0]` lands on
 * the short deck in both, and a lobby that used the LOCAL predicate would land
 * on the bear deck — each wrong in its own detectable way.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CardDefinition } from '@jonny-boi/core';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { SetupScreen } from './SetupScreen.js';
import { LobbyScreen } from '../online/OnlinePlay.js';
import { buildDeckMenu } from '../../lib/decklist/deckMenu.js';
import { clearImportedCards, registerImportedCards } from '../../lib/decklist/importedCards.js';
import { invalidateHotseatPool } from '../../lib/play/setup.js';
import type { Deck } from '../../lib/deck.js';
import type { DecksApi } from '../../lib/useDecks.js';

const BEAR_ID = 'test-wiring-bear-0000-0000-000000000001';
const BEAR_DEF: CardDefinition = {
  id: BEAR_ID,
  name: 'Wiring Test Bear',
  types: ['creature'],
  cost: { generic: 1, G: 1 },
  power: 2,
  toughness: 2,
};
const BEAR_RECORD = {
  id: BEAR_ID,
  name: 'Wiring Test Bear',
  typeLine: 'Creature — Bear',
  manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
} as unknown as NormalizedCard;

function deck(id: string, name: string, cards: Deck['cards']): Deck {
  return { id, name, cards, updatedAt: '2026-01-01T00:00:00.000Z' } as Deck;
}
const SHORT = deck('short', 'Short Deck', [{ cardId: 'Forest', count: 56 }]);
const BEAR = deck('bear', 'Bear Deck', [
  { cardId: BEAR_ID, count: 4 },
  { cardId: 'Forest', count: 56 },
]);
const FORESTS = deck('forests', 'All Forests', [{ cardId: 'Forest', count: 60 }]);

/** A DecksApi with exactly these decks, in this order; nothing else is read by the pickers. */
function api(decks: readonly Deck[]): DecksApi {
  return { decks: [...decks] } as unknown as DecksApi;
}

/** The `value` of the selected `<option>` inside the `<select>` with this aria-label. */
function selectedOption(markup: string, ariaLabel: string): string | undefined {
  const start = markup.indexOf(`aria-label="${ariaLabel}"`);
  if (start < 0) return undefined;
  const end = markup.indexOf('</select>', start);
  const select = markup.slice(start, end);
  const m = /<option[^>]*\bselected=""[^>]*\bvalue="([^"]*)"|<option[^>]*\bvalue="([^"]*)"[^>]*\bselected=""/.exec(select);
  return m ? (m[1] ?? m[2]) : undefined;
}

beforeEach(() => {
  clearImportedCards();
  registerImportedCards([{ card: BEAR_RECORD, definition: BEAR_DEF }]);
  invalidateHotseatPool();
});

describe('the Solo setup', () => {
  it('opens seat A on the first LOCALLY legal deck and seat B on the next, skipping the short one', () => {
    const markup = renderToStaticMarkup(
      createElement(SetupScreen, { decks: api([SHORT, BEAR, FORESTS]), onStart: () => {}, aiSeat: 'B' }),
    );
    expect(selectedOption(markup, 'Seat A deck'), 'seat A').toBe('saved:bear');
    expect(selectedOption(markup, 'Seat B deck'), 'seat B').toBe('saved:forests');
    expect(markup, 'both seats legal ⇒ no "Not ready" list on screen').not.toContain('Not ready:');
  });
});

describe('the online lobby', () => {
  it("opens on the first deck the SERVER would accept — past the short deck AND the import it cannot play", () => {
    const menu = buildDeckMenu(api([SHORT, BEAR, FORESTS]));
    const online = {
      state: { yourSeat: 'A', lobbyPlayers: [], code: 'TEST', startingPlayer: undefined, deckChosen: false, ready: false },
      chooseDeck: () => {},
      setReady: () => {},
      leave: () => {},
    } as unknown as Parameters<typeof LobbyScreen>[0]['online'];
    const markup = renderToStaticMarkup(createElement(LobbyScreen, { online, menu }));
    expect(selectedOption(markup, 'Your deck'), 'the lobby pick').toBe('saved:forests');
    expect(markup, 'an online-legal default ⇒ no "Not ready" list').not.toContain('Not ready:');
  });
});
