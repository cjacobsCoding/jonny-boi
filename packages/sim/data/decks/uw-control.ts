/**
 * UW Control — efficient white removal + a Wrath sweeper + blue countermagic and
 * card draw, closing with Serra Angel. Trades one-for-one, then takes over late.
 */

import type { Deck } from '../../src/deck.js';

export const UW_CONTROL: Deck = {
  name: 'UW Control',
  archetype: 'Control (removal + counters)',
  cards: [
    // Spot removal — exile the opponent's best threat.
    { cardId: 'Swords to Plowshares', count: 4 },
    { cardId: 'Path to Exile', count: 4 },
    // Sweeper.
    { cardId: 'Wrath of God', count: 4 },
    // Countermagic.
    { cardId: 'Counterspell', count: 4 },
    { cardId: 'Cryptic Command', count: 4 },
    // Card advantage / selection.
    { cardId: 'Brainstorm', count: 4 },
    // Finisher.
    { cardId: 'Serra Angel', count: 4 }, // 4/4 flyer, vigilance
    // Mana base — a two-color split.
    { cardId: 'Plains', count: 16 },
    { cardId: 'Island', count: 16 },
  ],
};
