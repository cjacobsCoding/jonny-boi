/**
 * BOROS PRISON — Sphere of Safety behind a wall of cheap enchantments.
 *
 * Photographed 2026-09-21 and transcribed by hand. The deck taxes attackers by
 * the number of enchantments its controller has out, so the cheap removal auras
 * do two jobs at once: they answer a creature AND raise the tax. Curse of
 * Exhaustion stops the rebuild, Possibility Storm scrambles the draws, and
 * Assemble the Legion wins unattended while the board is locked.
 *
 * ⚠️ THE COUNTS HERE WERE READ BY A HUMAN EYE, AND THAT IS NOT THE SAME AS
 * KNOWN. Every card NAME in the photo is legible and certain. The counts come
 * from counting fanned title bars, which is +/-1 per pile and, over fourteen
 * piles, a list somewhere between 55 and 70 cards. The two basic-land piles are
 * the deepest and therefore the least certain.
 *
 * It was read by eye because the app's OWN SCANNER COULD NOT READ THE PHOTO:
 * `detectStacks` returns zero piles for it at every orientation and every scale
 * from 800px to 2000px, while reading the earlier deck photo correctly as 16
 * piles in 2 rows x 8 columns (DESIGN §3.182). Seeding a transcription whose
 * provenance is a guess would be fine if it were silent about it; it is not
 * silent about it.
 *
 * Because seeding is add-only and once per profile, a correction to these counts
 * after he has been seeded must be a REVISION and not an edit to this list —
 * see `revisions.ts`. Editing here only changes what a NEW profile receives.
 *
 * SOURCE OF TRUTH: `docs/decks/boros-prison.txt`. `owner-decks.test.ts` re-reads
 * that file and fails if this list drifts from it (CLAUDE.md rule 12).
 */

import type { Deck } from '../../src/deck.js';

export const BOROS_PRISON: Deck = {
  name: 'Boros Prison',
  archetype: 'Boros enchantment prison',
  cards: [
    // Lands (22) — the two basics are the least certain counts in the deck.
    { cardId: 'Plains', count: 7 },
    { cardId: 'Mountain', count: 7 },
    { cardId: 'Clifftop Retreat', count: 4 },
    { cardId: 'Sacred Foundry', count: 4 },

    // The wall (28). Every one of these also raises Sphere of Safety's tax.
    { cardId: 'Sphere of Safety', count: 4 },
    { cardId: 'Assemble the Legion', count: 4 },
    { cardId: 'Possibility Storm', count: 4 },
    { cardId: 'Curse of Exhaustion', count: 4 },
    { cardId: 'Oblivion Ring', count: 4 },
    { cardId: 'Pacifism', count: 4 },
    { cardId: 'Burden of Guilt', count: 4 },

    // The rest (12).
    { cardId: 'Terminus', count: 4 },
    { cardId: 'Wild Guess', count: 4 },
    { cardId: 'Tibalt, the Fiend-Blooded', count: 4 },
  ],
};
