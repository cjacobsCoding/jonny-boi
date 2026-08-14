/**
 * Mono-Red Aggro (Burn) — the fastest clock in the gauntlet.
 *
 * **Game plan.** Land a hasty one-drop on turn one, add a spell-payoff two-drop,
 * and point cheap burn at whatever blocks — then at the face to close. It wins by
 * turn five or it does not win; every card either attacks on the turn it lands or
 * removes the thing stopping the attack.
 *
 * The twelve one-mana burn/damage spells are the deck's *second* creature suite:
 * they clear blockers early and become reach late, and each one grows Monastery
 * Swiftspear (prowess), swings Kiln Fiend for +3, and spawns an Elemental off
 * Young Pyromancer — so the burn is never a "dead" card against a creatureless
 * draw.
 *
 * **Why the list looks like this now.** The old build ran 44 Mountains and four
 * nonland cards, which is not a deck: three of every four draws did nothing. The
 * curated pool was that shallow in red; the ~157-card pool is not. Twenty-four
 * lands and thirty-six spells is the real shape of this archetype.
 *
 * **Deliberately still PURE red, and deliberately still Sol-Ring-free.** It is the
 * clean low-curve control point of the gauntlet — one colour, one plan, no
 * colourless acceleration — and the suggestion-engine fixtures use exactly that
 * property (Sol Ring is the canonical legal swap-IN to test against, so it must
 * not already be here).
 *
 * Excluded on fidelity grounds: Lava Spike and Flame Slash compile without their
 * printed target restrictions (the engine has no "damage to creatures only" /
 * "to players only" parameter), so they would play as strictly better than they
 * print. Everything below plays exactly as written.
 */

import type { Deck } from '../../src/deck.js';

export const MONO_RED_AGGRO: Deck = {
  name: 'Mono-Red Aggro',
  archetype: 'Aggro (burn)',
  cards: [
    // Turn-one pressure: eight hasty one-drops that attack the turn they land.
    { cardId: 'Goblin Guide', count: 4 }, // 2/2 haste
    { cardId: 'Monastery Swiftspear', count: 4 }, // 1/2 haste, prowess
    { cardId: 'Goblin Piker', count: 4 }, // 2/1 — a 1/1 haste is not a clock
    // Two-drop spell payoffs — each burn spell makes these bigger or wider.
    { cardId: 'Young Pyromancer', count: 4 }, // 2/1, a 1/1 per noncreature spell
    { cardId: 'Kiln Fiend', count: 4 }, // 1/2, +3/+0 per instant/sorcery
    // The one card above two mana: three bodies at once, so the deck has a way
    // through a board that has stabilised against one-for-one burn.
    { cardId: 'Beetleback Chief', count: 4 }, // 2/2 plus two 1/1s
    // Burn: removal early, reach late.
    { cardId: 'Lightning Bolt', count: 4 }, // 3 damage, {R}
    { cardId: 'Searing Spear', count: 4 }, // 3 damage, {1}{R}
    { cardId: 'Lightning Strike', count: 4 }, // 3 damage, {1}{R}
    // A one-colour curve that tops out at two needs twenty-four lands, not forty-four.
    { cardId: 'Mountain', count: 24 },
  ],
};
