/**
 * THE DECK PICKER EVERY PLAY SURFACE USES — a deck that is not in here cannot be
 * played at all, whatever the engine can do with it.
 *
 * This is the last link in a long chain: a mechanic gets a primitive, a compiler
 * rule turns printed text into that primitive, the cards enter the pool, a deck
 * is built from them, and only then can two people actually sit down and play
 * it. Every earlier link has its own test; this one pins the end of the chain,
 * because "the deck exists in `SAMPLE_DECKS`" and "a player can choose it in the
 * lobby" are different claims and only the second is the feature.
 *
 * It moved here from `lib/online/` when the hotseat setup's private copy of the
 * builder was deleted: there is now ONE menu, so there is one test for it.
 */

import { describe, expect, it } from 'vitest';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { buildDeckMenu, defaultSeatKeys, menuItemsOfOrigin, type DeckMenuItem } from './deckMenu.js';
import { validateChoice } from '../play/setup.js';
import { DECK_ORIGINS } from './deckOrigin.js';
import type { Deck } from '../deck.js';

/** A `DecksApi` with no saved decks — the lobby a first-time player sees. */
const NO_SAVED_DECKS = { decks: [] } as unknown as Parameters<typeof buildDeckMenu>[0];

/** One deck of the user's own, non-empty so the menu keeps it. */
const MY_DECK: Deck = {
  id: 'local-1',
  name: 'Acidic Angels',
  cards: [{ cardId: 'card-1', count: 60 }],
  updatedAt: '2026-01-01T00:00:00.000Z',
  copiedFrom: 'Selesnya Blink',
};

const WITH_MY_DECK = { decks: [MY_DECK] } as unknown as Parameters<typeof buildDeckMenu>[0];

describe('the deck picker', () => {
  it('offers every sample deck, so shipping a deck ships it online', () => {
    const menu = buildDeckMenu(NO_SAVED_DECKS);
    for (const deck of SAMPLE_DECKS) {
      expect(
        menu.some((item) => item.choice.source === 'sample' && item.choice.deck.name === deck.name),
        `${deck.name} is in SAMPLE_DECKS but not offered in the lobby`,
      ).toBe(true);
    }
  });

  it('offers Selesnya Blink specifically (DESIGN §3.35)', () => {
    // Named rather than left to the loop above: this deck is the reason blink was
    // built, and "the blink deck is playable online" is the requirement it has to
    // keep meeting. A rename or a dropped registry entry fails here by name.
    const menu = buildDeckMenu(NO_SAVED_DECKS);
    const blink = menu.find((item: DeckMenuItem) => item.label.startsWith('Selesnya Blink'));
    expect(blink, 'Selesnya Blink must be selectable in the online lobby').toBeDefined();
    // The label now NAMES it as built-in. It used to read "· sample", which told
    // a player nothing about whose deck it was — see deckOrigin.ts.
    expect(blink?.label).toBe(`Selesnya Blink · ${DECK_ORIGINS.builtin.labelSuffix}`);
    expect(blink?.origin).toBe('builtin');
  });

  it('a built-in deck stays PLAYABLE — identity, not access', () => {
    // The whole fix is about labelling. If it ever starts removing or disabling
    // built-in choices, that is a regression of a deliberate feature.
    const builtins = menuItemsOfOrigin(buildDeckMenu(WITH_MY_DECK), 'builtin');
    expect(builtins).toHaveLength(SAMPLE_DECKS.length);
    for (const item of builtins) expect(item.choice.source).toBe('sample');
  });

  it("marks the user's own deck as theirs and the bundled ones as built-in", () => {
    const menu = buildDeckMenu(WITH_MY_DECK);
    const mine = menu.find((item) => item.choice.source === 'saved');
    expect(mine?.origin).toBe('mine');
    expect(menuItemsOfOrigin(menu, 'mine')).toHaveLength(1);
  });

  it('a renamed copy is never confused with the deck it came from', () => {
    // The reported defect, at the menu level: "Acidic Angels" is a copy of
    // Selesnya Blink, so both appear — and they must land in DIFFERENT groups
    // with different origins, not as two adjacent look-alike rows.
    const menu = buildDeckMenu(WITH_MY_DECK);
    const copy = menu.find((item) => item.label.startsWith('Acidic Angels'));
    const original = menu.find((item) => item.label.startsWith('Selesnya Blink'));
    expect(copy?.origin).toBe('mine');
    expect(original?.origin).toBe('builtin');
    expect(copy?.origin).not.toBe(original?.origin);
  });
});

/**
 * A short deck of his own: transcribed from paper, 56 cards, listed WHOLE on
 * purpose (its row says why it cannot start). Two of these led the menu the day
 * main went red.
 */
function shortDeck(id: string, name: string): Deck {
  return {
    id,
    name,
    cards: [{ cardId: 'Forest', count: 56 }],
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A full, legal deck of his own — 60 basic Forests, which the engine plays. */
const LEGAL_MINE: Deck = {
  id: 'local-legal',
  name: 'All Forests',
  cards: [{ cardId: 'Forest', count: 60 }],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function api(decks: readonly Deck[]): Parameters<typeof buildDeckMenu>[0] {
  return { decks } as unknown as Parameters<typeof buildDeckMenu>[0];
}

describe('where the two seats start (defaultSeatKeys)', () => {
  it('THE RED MAIN: illegal decks lead the menu, and the seats skip past them', () => {
    // The shape that broke the board-fits harness, made worse: his transcribed
    // decks lead the menu and one of them cannot start (49 cards, five of them
    // unsupported), so a seat defaulted to it and Start was disabled before
    // anyone touched anything. Here BOTH leading decks are illegal, so a fix
    // that skipped only one row would still fail.
    const menu = buildDeckMenu(api([shortDeck('p1', 'Tamiyo + Jace Surge'), shortDeck('p2', "Thune's Life")]));
    expect(menu[0]?.origin, 'the fixture must put his decks first, like the real menu').toBe('mine');
    const { a, b } = defaultSeatKeys(menu);
    const seatA = menu.find((m) => m.key === a)!;
    const seatB = menu.find((m) => m.key === b)!;
    expect(validateChoice(seatA.choice), 'seat A must open on a deck that can start').toEqual([]);
    expect(validateChoice(seatB.choice), 'seat B must open on a deck that can start').toEqual([]);
    expect(a, 'two legal decks exist, so the seats must differ').not.toBe(b);
  });

  it('prefers his own legal deck to a built-in, in menu order', () => {
    const { a, b } = defaultSeatKeys(buildDeckMenu(api([shortDeck('p1', 'Short'), LEGAL_MINE])));
    expect(a).toBe('saved:local-legal');
    expect(b.startsWith('sample:'), 'seat B takes the first built-in rather than repeating A').toBe(true);
  });

  it('with nothing legal at all, still points at the first row so the message can explain', () => {
    const menu = buildDeckMenu(api([shortDeck('p1', 'Only')])).slice(0, 1);
    const { a, b } = defaultSeatKeys(menu);
    expect(a).toBe('saved:p1');
    expect(b).toBe('saved:p1');
  });
});
