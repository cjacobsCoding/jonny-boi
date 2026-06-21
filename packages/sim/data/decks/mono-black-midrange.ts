/**
 * Golgari Midrange — disrupt, remove, grind (BG).
 *
 * Game plan: strip the opponent's best card with Thoughtseize, then trade
 * efficiently — Doom Blade and Fatal Push kill creatures, while resilient green
 * bodies (Kitchen Finks' persist, Eternal Witness recurring a spent removal
 * spell) win the long attrition war. Mana dorks + Dark Ritual accelerate the curve
 * so the disruption comes down early and the threats stick. Out-grinds aggro on
 * card-for-card trades and lifegain; pressures control by emptying its hand and
 * deploying must-answer bodies.
 *
 * Why BG and not mono-black: the supported pool has essentially no mono-black
 * creatures, so a pure-black build would be a pile of spells with no clock. The
 * green splash supplies fully-supported, recursion-friendly bodies (Finks,
 * Witness) and ramp (Llanowar/Birds) — giving the deck a real, distinct
 * attrition-midrange identity built entirely on cards that play in full.
 *
 * Honesty note (DESIGN §3.8): Thoughtseize models its discard + 2 life loss; the
 * "reveal + opponent chooses" step is the documented stub but the card still does
 * its job. Fatal Push uses its base (≤2 MV) mode. No fully-stubbed card is a core.
 */

import type { Deck } from '../../src/deck.js';

export const MONO_BLACK_MIDRANGE: Deck = {
  name: 'Golgari Midrange',
  archetype: 'Midrange (disruption + removal)',
  cards: [
    // Hand disruption.
    { cardId: 'Thoughtseize', count: 4 }, // discard + lose 2
    // Efficient removal.
    { cardId: 'Doom Blade', count: 4 }, // destroy nonblack creature
    { cardId: 'Fatal Push', count: 4 }, // destroy MV ≤ 2 creature
    // Acceleration — ritual + dorks to deploy disruption early.
    { cardId: 'Dark Ritual', count: 4 }, // B -> BBB
    { cardId: 'Llanowar Elves', count: 4 }, // 1/1, taps for G
    { cardId: 'Birds of Paradise', count: 4 }, // 0/1 flyer, any color (fixes B and G)
    // Resilient, recursion-friendly green bodies — the grind engine + clock.
    { cardId: 'Kitchen Finks', count: 4 }, // 3/2, ETB gain 2, persist
    { cardId: 'Eternal Witness', count: 4 }, // 2/1, recur a removal spell
    // Two-color manabase (Birds/Witness lean green; disruption leans black).
    // Ramp-heavy, so a slightly higher land count rarely floods.
    { cardId: 'Swamp', count: 16 },
    { cardId: 'Forest', count: 12 },
  ],
};
