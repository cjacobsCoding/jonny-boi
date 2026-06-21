/**
 * Izzet Prowess — a spell-velocity go-wide / tempo deck (UR).
 *
 * Game plan: stick a cheap spell-payoff (Young Pyromancer or Monastery
 * Swiftspear), then chain cheap instants/sorceries. Every noncreature spell pumps
 * Swiftspear (prowess) and spawns a 1/1 Elemental off Young Pyromancer, so a
 * handful of one-mana cantrips and burn snowballs into a wide, growing board.
 * Lightning Bolt clears blockers or finishes; Counterspell protects the threat and
 * trades on the opponent's key play.
 *
 * Why this is distinct from Mono-Red Aggro: it wins by GOING WIDE off spell
 * triggers and grinding card advantage (Brainstorm/Ponder keep the chain going),
 * not by raw one-drop beats. Spell density is deliberately high (16 noncreature
 * spells) so the prowess/token engine actually fires — the enabler requirement
 * from DESIGN §3.8. All payoffs + spells are fully-supported pool cards.
 */

import type { Deck } from '../../src/deck.js';

export const MONO_BLUE_TEMPO: Deck = {
  name: 'Izzet Prowess',
  archetype: 'Tempo (spells go-wide)',
  cards: [
    // Spell payoffs — the more noncreature spells we cast, the bigger/wider.
    { cardId: 'Young Pyromancer', count: 4 }, // 2/1, makes 1/1s off instants & sorceries
    { cardId: 'Monastery Swiftspear', count: 4 }, // 1/2 haste, prowess
    // Cheap spell suite — fuel the triggers, find more gas, interact.
    { cardId: 'Lightning Bolt', count: 4 }, // burn / reach
    { cardId: 'Brainstorm', count: 4 }, // dig
    { cardId: 'Ponder', count: 4 }, // dig
    { cardId: 'Counterspell', count: 4 }, // protect the threat / trade
    // Colorless accelerant — also helps cast Counterspell + a spell in one turn.
    { cardId: 'Sol Ring', count: 4 }, // {T}: add {C}{C}
    // Dual-color manabase split for U and R.
    { cardId: 'Island', count: 16 },
    { cardId: 'Mountain', count: 16 },
  ],
};
