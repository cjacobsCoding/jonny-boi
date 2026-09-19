/**
 * A REVISION to one of the owner's decks — cards he asked to have added after
 * the deck was transcribed and seeded.
 *
 * ## Why a revision and not an edit to the list
 *
 * Seeding is add-only and once per profile (`apps/web/src/lib/decklist/
 * paperDecks.ts`): after the first mint, his copy is the deck and the registry
 * never reaches back into it. So editing `THUNES_LIFE` would change what a NEW
 * profile receives and leave the deck he actually has untouched — the request
 * "add 2 of them to Thune's Life deck" would be honoured on a machine he does
 * not use and ignored on the one he does.
 *
 * A revision is the same request as data: dated, add-only, keyed by a stable
 * id, and settled once per profile in the same ledger that settles a seed. The
 * web seeder applies it to his copy of the deck (found by its stable seed id, or
 * by name when he transcribed the deck himself) and records a note on the deck
 * so the addition is VISIBLE in the deck builder rather than silently present.
 * A fresh profile mints the deck with every revision already in, and settles
 * them all at once. A deck he has deleted stays deleted — a revision never
 * resurrects one.
 *
 * ## Add-only, by construction
 *
 * {@link applyDeckRevisions} can only raise a count or append a name. It has no
 * path that lowers a count, drops a name or reorders his list, and the guard
 * test asserts that over every registered revision. The 4-of rule is NOT
 * enforced here: a revision that would take a name past four is reported by
 * `validateDeck` in the app exactly like any other illegal deck, never silently
 * capped — the same choice `reconcileUnresolved` makes.
 *
 * ## The source of truth is still the `.txt`
 *
 * A revision is written in `docs/decks/<deck>.txt` as a `// revision <id> —
 * <note>` header followed by `+N Card Name` lines; the data here mirrors it and
 * `owner-decks.test.ts` re-reads the file and fails on any drift, exactly as it
 * does for the base list (CLAUDE.md rule 12).
 */

import type { Deck, DeckEntry } from '../../src/deck.js';

export interface DeckRevision {
  /** Stable key, settled once per profile: `<date>-<slug>`. Never reused. */
  readonly id: string;
  /** ISO date he asked for it. */
  readonly date: string;
  /** What the app shows him on the deck, in his own terms. */
  readonly note: string;
  /** The additions — counts are ADDED to whatever his copy already holds. */
  readonly adds: readonly DeckEntry[];
}

/**
 * The deck with `revisions` applied, in order. Counts for a name already in the
 * deck are summed; a new name is appended in revision order. The input is not
 * mutated, and nothing is ever removed.
 */
export function applyDeckRevisions(deck: Deck, revisions: readonly DeckRevision[]): Deck {
  if (revisions.length === 0) return deck;
  // Entries are readonly data: a raised count is a NEW entry in the old slot.
  const cards: DeckEntry[] = [...deck.cards];
  for (const revision of revisions) {
    for (const add of revision.adds) {
      const at = cards.findIndex((entry) => entry.cardId === add.cardId);
      if (at >= 0) cards[at] = { ...cards[at]!, count: cards[at]!.count + add.count };
      else cards.push({ ...add });
    }
  }
  return { ...deck, cards };
}
