/**
 * Mono-Red Aggro — cheap hasty creatures + Lightning Bolt to the face. The
 * fastest clock the 32-card pool supports.
 *
 * Pool-depth note: the curated pool offers only four playable red nonland cards,
 * so a legal 60 is necessarily land-heavy (16 spells + 44 Mountains). These are
 * *provisional* gauntlet decks; §3.8 replaces them with deeper, tuned meta decks
 * once the pool grows. The archetype's identity (one-drops + burn) is intact.
 */

import type { Deck } from '../../src/deck.js';

export const MONO_RED_AGGRO: Deck = {
  name: 'Mono-Red Aggro',
  archetype: 'Aggro (burn)',
  cards: [
    { cardId: 'Goblin Guide', count: 4 }, // 2/2 haste
    { cardId: 'Monastery Swiftspear', count: 4 }, // 1/2 haste
    { cardId: 'Young Pyromancer', count: 4 }, // 2/1
    { cardId: 'Lightning Bolt', count: 4 }, // removal + reach
    { cardId: 'Mountain', count: 44 },
  ],
};
