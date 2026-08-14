/**
 * Golgari Midrange — strip it, kill it, out-grind it (BG).
 *
 * **Game plan.** Take their best card with Thoughtseize, answer the first real
 * threat with one-mana removal, and then win the long game on card quality: every
 * creature after the mana dork replaces itself or comes back, so the deck is still
 * drawing live in a topdeck war that nobody else in the gauntlet survives. Llanowar
 * Elves accelerates the disruption a turn earlier and makes the four-card top end
 * (Craw Wurm, Pelakka Wurm) a realistic plan rather than a hope.
 *
 * **Why BG and not mono-black.** The pool's black creatures are thin; the green
 * half supplies the resilient, recursion-friendly bodies (Finks' persist, Witness'
 * regrowth) that make attrition an actual plan rather than a pile of removal.
 *
 * **What changed in the retune.** Dark Ritual is gone: it converts a card into
 * mana that empties at the end of the step, which for a deck with no single
 * explosive payoff is simply a card spent on nothing. The freed slots became real
 * threats (Kalonian Tusker, the Wurms), which is what the old list was missing — it
 * could answer everything and then not close.
 *
 * Then it was trimmed again, because the first pass overshot: twelve pieces of
 * interaction plus Vampire Nighthawk made it the best deck in the gauntlet at 65%,
 * beating six of seven opponents. Removal is down to eight and the Nighthawks moved
 * out entirely — a 2/3 flying deathtouch lifelink is the single card most likely to
 * make a matchup unloseable, and it is now Orzhov Lifegain's signature rather than
 * a card two decks share.
 *
 * **Faithfulness note.** Thoughtseize is no longer approximated: the caster reads
 * the victim's hand and takes the *best* nonland card, and the two life is paid.
 * Eternal Witness likewise returns the best card in the yard rather than a
 * placeholder. Both are stronger than the versions this deck used to be tuned
 * against, which is part of why it needed re-tuning at all.
 *
 * Identity: the attrition pillar — the deck that beats you on cards, not on tempo.
 */

import type { Deck } from '../../src/deck.js';

export const MONO_BLACK_MIDRANGE: Deck = {
  name: 'Golgari Midrange',
  archetype: 'Midrange (disruption + removal)',
  cards: [
    // Hand disruption — take the card the rest of the deck cannot answer.
    { cardId: 'Thoughtseize', count: 4 }, // they reveal; we take their best, lose 2
    // Efficient removal.
    { cardId: 'Fatal Push', count: 4 }, // destroy a creature of mana value <= 2
    { cardId: 'Doom Blade', count: 4 }, // destroy a nonblack creature
    // Acceleration — the disruption lands a turn early and the top end is reachable.
    { cardId: 'Llanowar Elves', count: 4 },
    // The grind engine: bodies that come back or bring something with them.
    { cardId: 'Elvish Visionary', count: 4 }, // 1/1, ETB draw a card
    { cardId: 'Kitchen Finks', count: 4 }, // 3/2, ETB gain 2, persist
    { cardId: 'Eternal Witness', count: 4 }, // 2/1, ETB return our best dead card
    { cardId: 'Kalonian Tusker', count: 4 }, // 3/3 for two
    { cardId: 'Craw Wurm', count: 2 }, // 6/4
    { cardId: 'Pelakka Wurm', count: 2 }, // 7/7 trample, gain 7, draws when it dies
    // Two-colour mana, both halves double-pip-hungry, so eight duals back the basics.
    { cardId: 'Golgari Guildgate', count: 4 },
    { cardId: 'Jungle Hollow', count: 4 },
    { cardId: 'Swamp', count: 8 },
    { cardId: 'Forest', count: 8 },
  ],
};
