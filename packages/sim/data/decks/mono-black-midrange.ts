/**
 * Mono-Black Midrange — hand disruption (Thoughtseize) + efficient removal
 * (Doom Blade, Fatal Push) + a planeswalker and grindy bodies. Attrition.
 */

import type { Deck } from '../../src/deck.js';

export const MONO_BLACK_MIDRANGE: Deck = {
  name: 'Mono-Black Midrange',
  archetype: 'Midrange (disruption + removal)',
  cards: [
    // Disruption.
    { cardId: 'Thoughtseize', count: 4 },
    // Removal.
    { cardId: 'Doom Blade', count: 4 },
    { cardId: 'Fatal Push', count: 4 },
    // Ramp / ritual into the top end.
    { cardId: 'Dark Ritual', count: 4 },
    // Threats / value.
    { cardId: 'Kitchen Finks', count: 4 }, // 3/2, ETB gain 2 (generic cost — black-castable)
    { cardId: 'Liliana of the Veil', count: 4 }, // planeswalker (enters; abilities stubbed)
    { cardId: 'Swamp', count: 36 },
  ],
};
