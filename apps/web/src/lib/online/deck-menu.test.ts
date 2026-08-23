/**
 * THE ONLINE LOBBY'S DECK PICKER — a deck that is not in here cannot be played
 * online at all, whatever the engine can do with it.
 *
 * This is the last link in a long chain: a mechanic gets a primitive, a compiler
 * rule turns printed text into that primitive, the cards enter the pool, a deck
 * is built from them, and only then can two people actually sit down and play
 * it. Every earlier link has its own test; this one pins the end of the chain,
 * because "the deck exists in `SAMPLE_DECKS`" and "a player can choose it in the
 * lobby" are different claims and only the second is the feature.
 */

import { describe, expect, it } from 'vitest';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { buildDeckMenu } from './deck-menu.js';

/** A `DecksApi` with no saved decks — the lobby a first-time player sees. */
const NO_SAVED_DECKS = { decks: [] } as unknown as Parameters<typeof buildDeckMenu>[0];

describe('the lobby deck picker', () => {
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
    const blink = menu.find((item) => item.label.startsWith('Selesnya Blink'));
    expect(blink, 'Selesnya Blink must be selectable in the online lobby').toBeDefined();
    expect(blink?.label).toBe('Selesnya Blink · sample');
  });
});
