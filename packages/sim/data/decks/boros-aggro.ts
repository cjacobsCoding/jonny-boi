/**
 * Boros Aggro — white-weenie beatdown in the air, with burn as the finisher (RW).
 *
 * **Game plan.** Curve out with efficient white bodies, take the sky with hasty
 * and vigilant fliers, and use burn to clear the one blocker that matters or to
 * deal the last three. Where Mono-Red wins on raw speed, Boros wins on *board
 * quality*: first strike, flying and lifelink mean its creatures survive combat
 * the red deck's do not, and Lightning Helix's three life buys back a whole turn
 * of the mirror.
 *
 * **Why it was retuned down.** The old build was the best removal suite in the
 * gauntlet (Bolt + Swords + Path) bolted onto an aggro shell, so it out-removed
 * the midrange decks *and* out-raced the control deck — 75% overall, the most
 * dominant list in the meta. The removal is now four Swords and four Helix (which
 * are also a clock and a lifegain plan), and the freed slots went into creatures.
 * It is an aggro deck with reach, not a removal pile that happens to attack.
 *
 * Identity: the beatdown-in-the-air pillar. Weak to sweepers, strong against
 * ground-based midrange and any deck that stumbles on its early turns.
 */

import type { Deck } from '../../src/deck.js';

export const BOROS_AGGRO: Deck = {
  name: 'Boros Aggro',
  archetype: 'Aggro (weenies + burn)',
  cards: [
    // One-drops: a body that trades up, and evasion that gains life.
    { cardId: 'Savannah Lions', count: 4 }, // 2/1
    { cardId: "Healer's Hawk", count: 4 }, // 1/1 flying, lifelink
    { cardId: 'Monastery Swiftspear', count: 4 }, // 1/2 haste, prowess
    // Two- and three-drops that win combat rather than just showing up.
    { cardId: 'Youthful Knight', count: 4 }, // 2/1 first strike
    { cardId: 'Skyknight Legionnaire', count: 4 }, // 2/2 flying haste
    { cardId: 'Aerial Responder', count: 4 }, // 2/3 flying, vigilance, lifelink
    // Reach + the answer to the single blocker that stops the curve.
    { cardId: 'Lightning Helix', count: 4 }, // 3 damage + 3 life
    { cardId: 'Lightning Bolt', count: 4 },
    { cardId: 'Swords to Plowshares', count: 4 },
    // Two-colour mana. The Guildgates enter tapped, which is a real cost for an
    // aggro deck, so only four of them back up twenty basics.
    { cardId: 'Boros Guildgate', count: 4 },
    { cardId: 'Plains', count: 10 },
    { cardId: 'Mountain', count: 10 },
  ],
};
