/**
 * Mono-Green Stompy — mana dorks into efficient creatures, Giant Growth to push
 * damage and win combat. Creature-centric, grindy beatdown.
 */

import type { Deck } from '../../src/deck.js';

export const MONO_GREEN_STOMPY: Deck = {
  name: 'Mono-Green Stompy',
  archetype: 'Aggro/Midrange (creatures)',
  cards: [
    // Mana dorks — accelerate into the threats.
    { cardId: 'Llanowar Elves', count: 4 }, // 1/1, taps for G
    { cardId: 'Birds of Paradise', count: 4 }, // 0/1 flyer, any color
    // Bodies — the pool's green/colorless beaters.
    { cardId: 'Tarmogoyf', count: 4 }, // 2/3 baseline
    { cardId: 'Kitchen Finks', count: 4 }, // 3/2, ETB gain 2
    { cardId: 'Eternal Witness', count: 4 }, // 2/1, ETB recur
    { cardId: 'Sakura-Tribe Elder', count: 4 }, // 1/1
    // Combat trick / reach.
    { cardId: 'Giant Growth', count: 4 }, // +3/+3
    { cardId: 'Forest', count: 32 },
  ],
};
