/**
 * Mono-Red Aggro (Burn) — the fastest clock in the gauntlet.
 *
 * Game plan: drop a one-drop hasty creature on turn 1, keep adding pressure, and
 * point Lightning Bolt at whatever blocker stands in the way — then at the
 * opponent's face to close.
 *
 * All four red nonlands are fully-supported pool cards (Goblin Guide's attack
 * trigger, Swiftspear's prowess, and Young Pyromancer's token triggers all resolve
 * under engine-v2). The curated pool is shallow in red nonlands — four playable
 * cards — so a legal mono-red 60 is necessarily land-heavy; we keep it pure red
 * (no colorless ramp) so the archetype stays the clean low-curve beatdown control
 * point of the gauntlet, and so it remains the canonical swap-in target the
 * suggestion engine tunes against. Identity: hyper-aggressive, reach via Bolt.
 */

import type { Deck } from '../../src/deck.js';

export const MONO_RED_AGGRO: Deck = {
  name: 'Mono-Red Aggro',
  archetype: 'Aggro (burn)',
  cards: [
    // One-drop hasty pressure.
    { cardId: 'Goblin Guide', count: 4 }, // 2/2 haste
    { cardId: 'Monastery Swiftspear', count: 4 }, // 1/2 haste, prowess
    // Two-drop token engine + Bolt fuel.
    { cardId: 'Young Pyromancer', count: 4 }, // 2/1, makes 1/1s off spells
    // Removal that doubles as reach to the face.
    { cardId: 'Lightning Bolt', count: 4 }, // 3 damage
    { cardId: 'Mountain', count: 44 },
  ],
};
