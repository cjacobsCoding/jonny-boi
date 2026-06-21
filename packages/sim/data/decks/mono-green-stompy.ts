/**
 * Mono-Green Ramp Midrange — accelerate, then grind on creature quality.
 *
 * Game plan: turn-1 mana dork (Llanowar Elves / Birds of Paradise) or Sol Ring
 * ramps into resilient, value-laden bodies a turn ahead of schedule. Kitchen Finks
 * (3/2, gain 2, persist) and Eternal Witness (recur a spent spell) generate
 * attrition advantage; Giant Growth wins combat and pushes the last points of
 * damage or ambushes an attacker. Out-sizes aggro with lifegain + bodies, and
 * out-values control by sticking threats faster than it can answer them.
 *
 * Every card here is fully supported under engine-v2: the dorks tap for mana,
 * Kitchen Finks' ETB lifegain + persist return both fire, Eternal Witness recurs,
 * and Giant Growth's pump wears off at cleanup. We deliberately DROP the prior
 * list's Tarmogoyf (dynamic P/T) and Sakura-Tribe Elder (sac/land-search) because
 * those mechanics are still stubbed — this deck is built only on cards that play
 * fully. Identity: the grindy, resilient midrange pillar.
 */

import type { Deck } from '../../src/deck.js';

export const MONO_GREEN_STOMPY: Deck = {
  name: 'Mono-Green Ramp',
  archetype: 'Midrange (ramp + creatures)',
  cards: [
    // Mana acceleration — into threats a turn early.
    { cardId: 'Llanowar Elves', count: 4 }, // 1/1, taps for G
    { cardId: 'Birds of Paradise', count: 4 }, // 0/1 flyer, any color
    { cardId: 'Sol Ring', count: 4 }, // {T}: add {C}{C}
    // Value bodies — resilient, advantage-generating.
    { cardId: 'Kitchen Finks', count: 4 }, // 3/2, ETB gain 2, persist
    { cardId: 'Eternal Witness', count: 4 }, // 2/1, ETB recur a spell
    // Combat trick / reach.
    { cardId: 'Giant Growth', count: 4 }, // +3/+3 until end of turn
    { cardId: 'Forest', count: 36 },
  ],
};
