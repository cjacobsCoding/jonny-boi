/**
 * Mono-Green Ramp — accelerate, then be bigger than everything (G).
 *
 * **Game plan.** A turn-one mana dork means a three-drop on turn two and a
 * five-drop on turn four; from there the deck simply plays creatures that win
 * every fight on the ground. Deadly Recluse and Giant Spider hold the sky and trade
 * with anything (reach + deathtouch), Eternal Witness rebuys whatever died, and the
 * Craw Wurm / Pelakka Wurm top end ends the game outright.
 *
 * **What changed in the retune.** The old list was four dorks, four Sol Rings and
 * a three-drop — it ramped hard into nothing, so its curve peaked lower than the
 * midrange decks it was supposed to out-size. It now has an actual top end and
 * twelve accelerants to reach it. Sol Ring came out: a colourless rock in a
 * mono-green deck was doing the mana dorks' job while contributing nothing to the
 * board, and it belongs to no archetype in particular.
 *
 * **Faithfulness.** Every card plays in full under engine-v2 — the dorks tap for
 * mana, Recluse's deathtouch and Spider's reach are honoured in combat, Witness'
 * ETB regrowth chooses the best card, and Pelakka Wurm's ETB lifegain and
 * dies-trigger draw both fire. Tarmogoyf (whose star P/T box is implemented now)
 * is still deliberately
 * excluded: its mechanic is unimplemented, so it would play as something other
 * than what it prints. (Sakura-Tribe Elder plays in full now — sacrifice-self
 * cost + basic-land search — it just hasn't been tuned into this list.)
 *
 * Identity: the "biggest creatures" pillar. Beats decks that try to win on the
 * ground; loses to exile removal, evasion and sweepers.
 */

import type { Deck } from '../../src/deck.js';

export const MONO_GREEN_STOMPY: Deck = {
  name: 'Mono-Green Ramp',
  archetype: 'Midrange (ramp + creatures)',
  cards: [
    // Twelve turn-one accelerants — the whole curve moves up a turn.
    { cardId: 'Llanowar Elves', count: 4 },
    { cardId: 'Elvish Mystic', count: 4 },
    { cardId: 'Birds of Paradise', count: 4 }, // also fixes nothing here, but blocks fliers
    // Defence that trades up: walls, reach and deathtouch answer anything, cheaply,
    // and buy the turns the top end needs.
    { cardId: 'Wall of Blossoms', count: 4 }, // 0/4 defender, ETB draw a card
    { cardId: 'Deadly Recluse', count: 4 }, // 1/2 reach, deathtouch
    { cardId: 'Giant Spider', count: 4 }, // 2/4 reach
    { cardId: 'Eternal Witness', count: 4 }, // 2/1, ETB return our best dead card
    // The bodies the ramp is actually for.
    { cardId: 'Craw Wurm', count: 4 }, // 6/4
    { cardId: 'Pelakka Wurm', count: 4 }, // 7/7 trample, gain 7, draws when it dies
    { cardId: 'Forest', count: 24 },
  ],
};
