/**
 * **Thune's Life** — the owner's green/white lifegain deck, transcribed from a
 * phone photo on 2026-09-14.
 *
 * Soul Warden and Healer of the Pride turn every creature into life, Rhox
 * Faithmender doubles it, and Archangel of Thune turns the whole pile into a
 * board that grows every time you gain any. Its tell is Archangel of Thune +
 * Soul Warden + Rhox Faithmender.
 *
 * ⚠️ This deck spent a day filed under the name **Acidic Angels**, which made
 * "Acidic Angels is complete" an answer about the wrong deck. They are different
 * decks. Acidic Angels is the blink deck; this one gains life.
 *
 * SOURCE OF TRUTH: `docs/decks/thunes-life.txt`. `owner-decks.test.ts` re-reads
 * that file and fails if this list drifts from it (CLAUDE.md rule 12).
 *
 * 65 cards — over the 60-card minimum, so its legality turns entirely on how
 * many of its names the compiled pool carries. That number moves as the
 * all-cards campaign lands families; the app REPORTS it rather than assuming it.
 */

import type { Deck } from '../../src/deck.js';
import type { DeckRevision } from './revisions.js';

export const THUNES_LIFE: Deck = {
  name: "Thune's Life",
  archetype: 'Selesnya lifegain',
  cards: [
    { cardId: "Avacyn's Pilgrim", count: 4 },
    { cardId: 'Arbor Elf', count: 4 },
    { cardId: 'Soul Warden', count: 4 },
    { cardId: 'Cathedral Sanctifier', count: 3 },
    { cardId: 'Healer of the Pride', count: 3 },
    { cardId: 'Fiendslayer Paladin', count: 3 },
    { cardId: 'Rhox Faithmender', count: 3 },
    { cardId: 'Scavenging Ooze', count: 2 },
    { cardId: "Trostani, Selesnya's Voice", count: 2 },
    { cardId: 'Archangel of Thune', count: 2 },
    { cardId: 'Avacyn, Angel of Hope', count: 1 },

    { cardId: 'Selesnya Charm', count: 3 },
    { cardId: 'Giant Growth', count: 2 },
    { cardId: 'Oblivion Ring', count: 2 },
    { cardId: 'Luminarch Ascension', count: 2 },
    { cardId: "Cathars' Crusade", count: 2 },
    { cardId: 'Collective Blessing', count: 1 },
    { cardId: "Akroma's Memorial", count: 1 },

    { cardId: 'Sunpetal Grove', count: 4 },
    { cardId: 'Temple Garden', count: 4 },
    { cardId: 'Forest', count: 7 },
    { cardId: 'Plains', count: 6 },
  ],
};

/**
 * The cards he asked to have ADDED to Thune's Life after it was transcribed —
 * six names, two copies each, in the order he asked for them (2026-09-18):
 *
 * > "Add the card Skyclave Apparition and the mechanics to make it work then
 * > add 2 of them to Thune's Life deck" — "And Tyvar's Stand" — "And Spike
 * > Feeder" — "And Voice of the Blessed" — "Also add Heliod, Sun-Crowned and
 * > all required mechanics" — "And Selvala, Explorer Returned"
 *
 * A REVISION rather than an edit to the list above, because the list above has
 * already been seeded into his collection and seeding never reaches back into
 * a deck he owns: the web seeder applies each revision once, to his copy, and
 * a fresh profile mints the deck with it already in. Each name the pool cannot
 * supply yet rides the deck as its `unresolved` wish-list and is folded in
 * the moment the compiler learns it — the same funnel as the base list.
 *
 * SOURCE OF TRUTH: the `// revision` block in `docs/decks/thunes-life.txt`;
 * `owner-decks.test.ts` re-reads it and fails on any drift.
 */
export const THUNES_LIFE_REVISIONS: readonly DeckRevision[] = Object.freeze([
  Object.freeze({
    id: '2026-09-18-his-six',
    date: '2026-09-18',
    note: 'Added at your request: Skyclave Apparition, Tyvar\'s Stand, Spike Feeder, Voice of the Blessed, Heliod, Sun-Crowned and Selvala, Explorer Returned — two of each.',
    adds: Object.freeze([
      { cardId: 'Skyclave Apparition', count: 2 },
      { cardId: "Tyvar's Stand", count: 2 },
      { cardId: 'Spike Feeder', count: 2 },
      { cardId: 'Voice of the Blessed', count: 2 },
      { cardId: 'Heliod, Sun-Crowned', count: 2 },
      { cardId: 'Selvala, Explorer Returned', count: 2 },
    ]),
  }),
]);
