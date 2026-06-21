/**
 * Mono-Blue Tempo — cheap threats (Delver, Snapcaster) backed by counters and
 * cantrips, racing while disrupting. Lean and interactive.
 */

import type { Deck } from '../../src/deck.js';

export const MONO_BLUE_TEMPO: Deck = {
  name: 'Mono-Blue Tempo',
  archetype: 'Tempo (threats + counters)',
  cards: [
    // Threats.
    { cardId: 'Delver of Secrets', count: 4 }, // 1/1 (front face)
    { cardId: 'Snapcaster Mage', count: 4 }, // 2/1
    // Counters.
    { cardId: 'Counterspell', count: 4 },
    { cardId: 'Cryptic Command', count: 4 },
    // Cantrips / selection — keep the gas flowing.
    { cardId: 'Brainstorm', count: 4 },
    { cardId: 'Ponder', count: 4 },
    { cardId: 'Island', count: 36 },
  ],
};
