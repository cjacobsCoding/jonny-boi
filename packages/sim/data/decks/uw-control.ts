/**
 * UW Control — answer everything, win late in the air.
 *
 * **Game plan.** Survive the early turns behind Wall of Omens (a 0/4 that replaces
 * itself), trade one-for-one with white exile removal, and reset the board with
 * Wrath of God when a creature deck commits. Counterspell and Cryptic Command hold
 * up the answers the sorcery-speed suite cannot cover; Ponder and Divination
 * refill. Once the opponent is out of gas, Serra Angel closes while still blocking.
 *
 * **Why it was retuned down.** Two things were carrying it far past a fair share
 * of the meta. Four Sol Rings let a control deck deploy a four-mana sweeper on
 * turn three — the single most powerful card in the gauntlet, in the deck least
 * able to be punished for it. And four Snapcaster Mages were a *vanilla 2/1* here
 * (its flashback-GRANTING ability is still unimplemented — see `STUBBED_MECHANICS`;
 * flash timing and printed flashback costs are real now, but the grant is what
 * Snapcaster IS), so the
 * deck was quietly running four blank bodies and still winning. Both are gone.
 * Removal density came down from twelve pieces to eleven, and the freed slots went
 * into card draw and lands, which is what actually makes a control deck a control
 * deck.
 *
 * **Cryptic Command is a real card now.** It is a genuine "choose two of four",
 * and the pilot scores each mode against the board rather than taking the two
 * printed first — so it counters when there is something worth countering, bounces
 * when there is a real threat to bounce, and otherwise taps their team and draws.
 *
 * Identity: the reactive, card-advantage pillar. Beats decks that commit to the
 * board; vulnerable to being emptied of answers by cheap disruption.
 */

import type { Deck } from '../../src/deck.js';

export const UW_CONTROL: Deck = {
  name: 'UW Control',
  archetype: 'Control (removal + counters)',
  cards: [
    // Efficient spot removal — exile the opponent's best threat.
    { cardId: 'Swords to Plowshares', count: 4 },
    { cardId: 'Path to Exile', count: 3 }, // gives them a tapped basic; a real cost
    // The sweeper the whole plan is built around.
    { cardId: 'Wrath of God', count: 4 },
    // Countermagic — the answers a sorcery-speed suite cannot cover.
    { cardId: 'Counterspell', count: 4 },
    { cardId: 'Cryptic Command', count: 3 }, // choose two of four, chosen for real
    // Surviving the early turns without spending a card to do it.
    { cardId: 'Wall of Omens', count: 4 }, // 0/4 defender, draws a card
    // Card advantage / selection.
    { cardId: 'Ponder', count: 4 },
    { cardId: 'Divination', count: 4 },
    // The win conditions: few enough that our own Wraths stay one-sided.
    { cardId: 'Serra Angel', count: 4 }, // 4/4 flying, vigilance
    { cardId: 'Air Elemental', count: 1 }, // 4/4 flying
    // Twenty-five lands for a curve that tops at five and wants to hit every drop.
    { cardId: 'Azorius Guildgate', count: 4 },
    { cardId: 'Tranquil Cove', count: 3 },
    { cardId: 'Plains', count: 9 },
    { cardId: 'Island', count: 9 },
  ],
};
