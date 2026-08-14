/**
 * Rakdos Goblins — two bodies per card, then more of them (BR). *(New in the retune.)*
 *
 * **Game plan.** Almost every spell puts *two or three* creatures on the board:
 * Dragon Fodder and Krenko's Command make a pair for two mana, Goblin Instigator
 * brings a friend, Beetleback Chief brings two, and Young Pyromancer turns the
 * removal suite into yet more Elementals. The board goes wide faster than
 * one-for-one removal can answer it, and Terminate and Lightning Bolt clear the
 * single big blocker holding the swarm back.
 *
 * **Why the gauntlet needed it.** Going wide is the one axis the old six-deck meta
 * did not have, and its absence quietly distorted everything else: Wrath of God had
 * nothing to punish, so UW Control's sweeper was a slow Doom Blade, and spot
 * removal was never embarrassed. Rakdos is the deck that makes both of those cards
 * mean what they are supposed to mean.
 *
 * **Matchups it is built for.** Excellent against decks whose answers are
 * one-for-one (the removal-based midrange decks simply run out), and against decks
 * that need a turn or two to set up. Structurally weak to Wrath of God — one card
 * for six — and to any deck whose blockers are bigger than 1/1, which is why the
 * burn and Terminate are here rather than more tokens.
 *
 * Every card plays as printed: `makeToken` puts real, summoning-sick permanents
 * onto the battlefield through the same entry path as any creature, so the ETB and
 * cast triggers all fire.
 */

import type { Deck } from '../../src/deck.js';

export const RAKDOS_GOBLINS: Deck = {
  name: 'Rakdos Goblins',
  archetype: 'Aggro (go wide)',
  cards: [
    // Two bodies for two mana, twelve times over.
    { cardId: 'Dragon Fodder', count: 4 }, // two 1/1s
    { cardId: "Krenko's Command", count: 4 }, // two 1/1s
    { cardId: 'Goblin Instigator', count: 4 }, // 1/1 that brings a 1/1
    // The payoff for a deck made of cheap noncreature spells.
    { cardId: 'Young Pyromancer', count: 4 }, // 2/1, a 1/1 per noncreature spell
    // Three bodies for four mana — the card that ends a stalled board.
    { cardId: 'Beetleback Chief', count: 4 }, // 2/2 plus two 1/1s
    // Answers for the blockers that stop a swarm — and, in a deck this full of
    // cheap noncreature spells, four more triggers for Young Pyromancer. A wall
    // of 1/1s is worthless against a single 0/4, so the removal is not a splash
    // here: it is what makes the tokens able to attack at all.
    { cardId: 'Lightning Bolt', count: 4 },
    { cardId: 'Terminate', count: 4 }, // destroy any creature for {B}{R}
    { cardId: 'Doom Blade', count: 4 }, // destroy a nonblack creature
    { cardId: 'Searing Spear', count: 4 },
    // Two-colour mana; the swarm is cheap enough to afford eight tapped lands.
    { cardId: 'Rakdos Guildgate', count: 4 },
    { cardId: 'Bloodfell Caves', count: 4 },
    { cardId: 'Mountain', count: 8 },
    { cardId: 'Swamp', count: 8 },
  ],
};
