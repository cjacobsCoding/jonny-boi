/**
 * **Acidic Angels** — the FIRST deck the owner scanned into this app.
 *
 * A real, physical, sleeved deck, transcribed pile by pile from the cards
 * themselves (not from OCR). Selesnya blink/value out of 2012–13 Standard:
 * Restoration Angel and Cloudshift re-trigger Acidic Slime, Thragtusk and
 * Angel of Serenity, and Conjurer's Closet does it for free every end step.
 *
 * ⚠️ **NAME HISTORY, because it has cost real time twice.** The owner scanned
 * this deck; the app filed it under the name of the BUILT-IN sample deck it
 * resembles, *"Selesnya Blink (scanned)"*; he renamed it to its real name,
 * **Acidic Angels**, and that rename is what surfaced the built-in-fork bug
 * (DESIGN §3.35). There is exactly ONE Acidic Angels and this is it — it is not
 * a second deck that happens to share a string, and it is not Thune's Life,
 * which is the green/white lifegain deck. Its tell is Acidic Slime + Angel of
 * Serenity.
 *
 * SOURCE OF TRUTH: `docs/decks/acidic-angels.txt`. `owner-decks.test.ts` re-reads
 * that file and fails if this list drifts from it by so much as a count, so the
 * two copies cannot answer differently (CLAUDE.md rule 12).
 *
 * ⚠️ 59 cards, not 60. The names are read off the cards; the COUNTS are inferred
 * from sleeve-edge depth, and the mana base is the least certain part
 * (`docs/decks/README.md` §Confidence). The app does NOT pad it to a legal 60 —
 * inventing a card the owner does not own is how a transcription stops being a
 * transcription. It reports the shortfall instead; see `OWNER_DECK_RULES`.
 */

import type { Deck } from '../../src/deck.js';

export const ACIDIC_ANGELS: Deck = {
  name: 'Acidic Angels',
  archetype: 'Selesnya blink/value',
  cards: [
    { cardId: 'Strionic Resonator', count: 4 },
    { cardId: 'Gatecreeper Vine', count: 4 },
    { cardId: 'Banisher Priest', count: 4 },
    { cardId: 'Acidic Slime', count: 4 },
    { cardId: 'Fiend Hunter', count: 2 },
    { cardId: "Avacyn's Pilgrim", count: 4 },
    { cardId: 'Angel of Serenity', count: 3 },
    { cardId: 'Restoration Angel', count: 3 },
    { cardId: 'Elvish Visionary', count: 4 },
    { cardId: 'Thragtusk', count: 3 },

    { cardId: 'Cloudshift', count: 2 },
    { cardId: "Conjurer's Closet", count: 3 },

    { cardId: 'Temple Garden', count: 4 },
    { cardId: 'Sunpetal Grove', count: 4 },
    { cardId: 'Forest', count: 6 },
    { cardId: 'Plains', count: 5 },
  ],
};
