/**
 * Izzet Prowess — cheap spells, growing threats, tempo (UR).
 *
 * **Game plan.** Stick one of twelve cheap spell-payoff creatures, then chain
 * one-mana spells at it. Every noncreature spell pumps Monastery Swiftspear
 * (prowess), swings Kiln Fiend for +3/+0, and spawns a 1/1 off Young Pyromancer —
 * so a hand of cantrips and burn is a hand of damage. Counterspell protects the
 * threat or answers theirs; Brainstorm and Ponder keep the chain going.
 *
 * **How it differs from Mono-Red.** Mono-Red wins with bodies and burn to the
 * face. Izzet wins with *one* threat that got enormous, backed by interaction — it
 * plays a real blue game, holding mana up and casting on the opponent's turn.
 *
 * **What changed in the retune.** Two things. Four Sol Rings came out: they were
 * the deck's best card and had nothing to do with its plan, since colourless mana
 * neither triggers prowess nor makes an Elemental, and a two-colour tempo deck
 * cannot afford a source that casts neither {U}{U} nor {R}. And the all-prowess
 * creature base came out, because it did not work: every ground payoff in the pool
 * is a 1/2 or a 2/1, so the deck spent its spells growing a creature the defender
 * blocked for free and finished at 26% overall. Half the threats are fliers now —
 * prowess *and* evasion, which is what makes the spells convert into a clock.
 *
 * **Faithfulness note.** Brainstorm was cut for a different reason: it is no
 * longer a free "draw three". It draws three and puts two back on top, so it is a
 * real +1, and this deck would rather have a burn spell.
 *
 * Identity: the tempo pillar. Punishes slow starts and clunky draws; folds to
 * cheap removal and to any deck that stabilises above its reach.
 */

import type { Deck } from '../../src/deck.js';

export const MONO_BLUE_TEMPO: Deck = {
  name: 'Izzet Prowess',
  archetype: 'Tempo (spell payoffs)',
  cards: [
    // Payoffs — the more noncreature spells we cast, the bigger and wider they get.
    { cardId: 'Monastery Swiftspear', count: 4 }, // 1/2 haste, prowess
    { cardId: 'Young Pyromancer', count: 4 }, // 2/1, a 1/1 per noncreature spell
    // Evasion: the half of the deck that finishes what prowess started. A prowess
    // creature the defender can simply block is not a clock, and every ground
    // payoff in the pool is a 1/2 or a 2/1 that dies to anything.
    { cardId: 'Wind Drake', count: 4 }, // 2/2 flying
    { cardId: 'Cloudkin Seer', count: 4 }, // 2/1 flying, ETB draw a card
    { cardId: 'Air Elemental', count: 2 }, // 4/4 flying — the finisher
    // Burn: removal that clears the blocker, and reach that finishes.
    { cardId: 'Lightning Bolt', count: 4 },
    { cardId: 'Searing Spear', count: 4 },
    { cardId: 'Shock', count: 2 },
    // Digging — cheap, and each one is a prowess/token trigger in its own right.
    { cardId: 'Ponder', count: 4 },
    // Interaction — protect the threat, or take their best turn away.
    { cardId: 'Counterspell', count: 4 },
    // Two-colour mana; only eight of the twenty-four enter tapped.
    { cardId: 'Izzet Guildgate', count: 4 },
    { cardId: 'Swiftwater Cliffs', count: 4 },
    { cardId: 'Island', count: 8 },
    { cardId: 'Mountain', count: 8 },
  ],
};
