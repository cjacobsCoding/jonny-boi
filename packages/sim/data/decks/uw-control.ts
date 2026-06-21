/**
 * UW Control — answer everything, win late with a flier.
 *
 * Game plan: trade one-for-one with efficient white exile removal (Swords /
 * Path), reset the board against go-wide draws with Wrath of God, and hold up
 * Counterspell / Cryptic Command for the threats that slip through. Brainstorm and
 * Ponder smooth draws and find the right answer; Sol Ring powers out a Wrath or
 * Cryptic ahead of curve. Once the opponent is out of gas, Serra Angel (4/4
 * flying vigilance) closes while still defending, with a small Snapcaster-body
 * package to pressure and trade earlier. The deck stays low on must-answer
 * permanents so its own Wraths stay one-sided.
 *
 * All cards are pool cards. Note (honesty per DESIGN §3.8): the heuristic pilot
 * recognises burn as removal but treats exile/counter spells as generic — they
 * still RESOLVE correctly in the engine (exile removes, Counterspell counters,
 * Wrath sweeps), so the control plan functions; the AI just doesn't always
 * sequence them optimally. Identity: the reactive, card-advantage pillar.
 */

import type { Deck } from '../../src/deck.js';

export const UW_CONTROL: Deck = {
  name: 'UW Control',
  archetype: 'Control (removal + counters)',
  cards: [
    // Efficient spot removal — exile the opponent's best threat.
    { cardId: 'Swords to Plowshares', count: 4 },
    { cardId: 'Path to Exile', count: 4 },
    // Sweeper against go-wide / aggro.
    { cardId: 'Wrath of God', count: 4 },
    // Countermagic.
    { cardId: 'Counterspell', count: 4 },
    { cardId: 'Cryptic Command', count: 2 }, // counter + draw (1UUU — a light top-end)
    // Card advantage / selection.
    { cardId: 'Brainstorm', count: 4 },
    { cardId: 'Ponder', count: 4 },
    // Acceleration into the haymakers.
    { cardId: 'Sol Ring', count: 4 }, // {T}: add {C}{C}
    // Bodies — a flying finisher plus a cheap blocker/clock. Snapcaster Mage's
    // flash/flashback is stubbed (see STUBBED_MECHANICS), so it is included ONLY as
    // its fully-correct vanilla 2/1 body — a proactive play that gives the control
    // deck a board presence to defend with and a secondary clock, not as a core
    // engine piece. Kept minimal and honest per DESIGN §3.8.
    { cardId: 'Serra Angel', count: 4 }, // 4/4 flying, vigilance
    { cardId: 'Snapcaster Mage', count: 4 }, // vanilla 2/1 (flash/flashback stubbed)
    // Two-color manabase.
    { cardId: 'Plains', count: 11 },
    { cardId: 'Island', count: 11 },
  ],
};
