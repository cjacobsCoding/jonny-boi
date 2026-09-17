/**
 * **Tamiyo + Jace Surge** — the owner's blue/green defenders-ramp deck,
 * transcribed from a phone photo on 2026-09-14.
 *
 * Arbor Elf and Axebane Guardian turn a wall of defenders into a great deal of
 * mana; Primal Surge empties the deck onto the battlefield. Its tell is the two
 * planeswalkers it is named for.
 *
 * SOURCE OF TRUTH: `docs/decks/tamiyo-jace-surge.txt`. `owner-decks.test.ts`
 * re-reads that file and fails if this list drifts from it (CLAUDE.md rule 12).
 *
 * ⚠️ **This is the one deck that is knowingly short of its own identity.** Five
 * of its seventeen names are not yet in the compiled pool — Axebane Guardian,
 * Craterhoof Behemoth, Primal Surge, and BOTH planeswalkers the deck is named
 * after. A card whose residue is named and pinned is a fine outcome for a card
 * nobody asked about; it is not a fine outcome for the two cards a deck is named
 * after, which is why `docs/ALL-CARDS-CAMPAIGN.md` §7a holds them.
 *
 * Shipping it anyway, loudly short, is the point: the deck EXISTS in the app and
 * says exactly what it is missing, instead of being absent and unexplained. The
 * count moves on its own as the campaign lands those families —
 * `paperDecks.ts#reconcileUnresolved` folds each name into the seeded deck the
 * moment the pool learns it, and `paperDecks.test.ts` pins that it can only ever
 * move upward.
 *
 * ⚠️ **49 cards as transcribed, which is short of 60 even at full resolution,
 * and it seeds that way on purpose.** The names are read off the physical cards
 * and the counts inferred from sleeve depth; padding to a legal 60 would mean
 * inventing cards the owner does not own, and the moment that happens this stops
 * being a record of his deck. An earlier revision hid the shortfall behind
 * `ownerDeckRules`, a per-deck legality rule that made 49 "legal"; that rule is
 * retired (§3.157). The deck is judged like any deck he builds, its row says it
 * is short, and he can fix it himself because it is his and it is editable.
 */

import type { Deck } from '../../src/deck.js';

export const TAMIYO_JACE_SURGE: Deck = {
  name: 'Tamiyo + Jace Surge',
  archetype: 'Simic defenders ramp',
  cards: [
    { cardId: 'Arbor Elf', count: 4 },
    { cardId: 'Axebane Guardian', count: 4 },
    { cardId: 'Doorkeeper', count: 3 },
    { cardId: "Avacyn's Pilgrim", count: 2 },
    { cardId: 'Fog Bank', count: 2 },
    { cardId: 'Gatecreeper Vine', count: 2 },
    { cardId: 'Soul of the Harvest', count: 2 },
    { cardId: 'Craterhoof Behemoth', count: 2 },

    { cardId: 'Jace, Architect of Thought', count: 3 },
    { cardId: 'Tamiyo, the Moon Sage', count: 2 },
    { cardId: 'Gilded Lotus', count: 2 },
    { cardId: 'Primal Surge', count: 2 },

    { cardId: 'Forest', count: 10 },
    { cardId: 'Hinterland Harbor', count: 4 },
    { cardId: 'Island', count: 3 },
    { cardId: 'Kessig Wolf Run', count: 1 },
    { cardId: 'Izzet Guildgate', count: 1 },
  ],
};
