/**
 * Boros Aggro — aggressive RW midrange with reach and a flying top-end.
 *
 * Game plan: open on hasty red one-drops, then back the assault with the best
 * removal in the gauntlet — Lightning Bolt for reach/blockers and white exile
 * (Swords / Path) to clear anything that out-sizes the team. Young Pyromancer
 * widens the board off the burn/removal, and Serra Angel (4/4 flying vigilance)
 * is a resilient top-end that pressures and defends — a finisher pure mono-red
 * lacks. More midrange-grindy and removal-dense than Mono-Red Aggro, but faster
 * and more proactive than UW Control: it occupies the middle of the gauntlet.
 *
 * Every card is a fully-supported pool card (haste, prowess, attack and token
 * triggers, exile/destroy removal all resolve under engine-v2). Identity: the
 * removal-backed beatdown pillar.
 */

import type { Deck } from '../../src/deck.js';

export const BOROS_AGGRO: Deck = {
  name: 'Boros Aggro',
  archetype: 'Aggro-midrange (creatures + removal)',
  cards: [
    // Hasty one-drop pressure (a touch lighter than Mono-Red's — this is the
    // removal-backed midrange of the two aggressive red decks, not the max-speed one).
    { cardId: 'Goblin Guide', count: 4 }, // 2/2 haste
    { cardId: 'Monastery Swiftspear', count: 3 }, // 1/2 haste, prowess
    // Token engine off the removal suite.
    { cardId: 'Young Pyromancer', count: 4 }, // 2/1
    // Removal — reach + exile a key blocker (a lighter package than UW's, so the
    // deck stays an aggressive beatdown rather than a removal-pile that out-values
    // every archetype).
    { cardId: 'Lightning Bolt', count: 4 },
    { cardId: 'Swords to Plowshares', count: 3 },
    { cardId: 'Path to Exile', count: 2 },
    // Flying, vigilant top-end — a few copies to close, not a bomb-heavy curve.
    { cardId: 'Serra Angel', count: 3 }, // 4/4 flying, vigilance
    // Two-color manabase.
    { cardId: 'Mountain', count: 19 },
    { cardId: 'Plains', count: 18 },
  ],
};
