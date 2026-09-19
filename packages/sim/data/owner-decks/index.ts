/**
 * THE OWNER'S REAL DECKS — the physical, sleeved decks that exist on a table,
 * transcribed card by card so the app can put them into his collection.
 *
 * ## What these are, and what they are NOT
 *
 * They are a SEED. On a profile that has never been given one, the web app
 * mints each of these as an ordinary saved deck the owner owns outright — one
 * he can rename, edit, add to, and delete like any deck he built by hand. After
 * that first mint this registry is not consulted for that deck again: his copy
 * is the deck, and nothing here can reach back into it.
 *
 * They are NOT a separate kind of deck with its own region, its own badge or its
 * own legality rules. That is what they were for one revision, and Caleb's
 * verdict on it was immediate: *"why is there a 'your paper decks' and 'your
 * decks' - this is dumb. I just want one collection of decks and I must be able
 * to edit all of them, regardless of whether scanned in."* A transcription is
 * how a deck GOT here; it is not a different noun once it has arrived. See
 * `apps/web/src/lib/decklist/paperDecks.ts` for the seeding rules, which are
 * add-only by construction.
 *
 * ## Why this is a separate registry and not more rows in `SAMPLE_DECKS`
 *
 * `data/decks/index.ts` is not a bag of decks: it **is** the §3.8 meta gauntlet
 * the Lab A/B-tests every verdict against. Its spread of identities was tuned on
 * purpose so each deck is somebody's bad matchup, and a gauntlet matchup is
 * seeded by the opponent's INDEX — that file's own comment records that merely
 * *reordering* it moved a recorded baseline. Adding personal decks to it would
 * change the field every A/B verdict is measured against, so every number the
 * lab has ever produced would silently mean something else. The gauntlet stays
 * the meta field; these stay his. That line is the one thing about the previous
 * revision that was right, and it is not blurred here.
 *
 * Adding a deck stays a data edit (CLAUDE.md rule 2): drop a file in this
 * directory and add ONE row below.
 *
 * ## These lists are a transcription, and a transcription is not padded
 *
 * The NAMES are read off the physical cards. The COUNTS are inferred from
 * sleeve-edge depth and the mana bases are the least certain part
 * (`docs/decks/README.md` §Confidence). Tamiyo + Jace Surge is 49 cards, which
 * is short of a legal 60, and it is seeded at 49 anyway — padding it would mean
 * inventing cards the owner does not own, and the moment that happens this stops
 * being a record of his deck.
 *
 * ⚠️ **There is no special legality rule for a seeded deck, and there must not
 * be one again.** An earlier revision shipped `ownerDeckRules`, which set the
 * minimum deck size to the deck's own transcribed count so that a 59-card list
 * could report itself "legal". It existed for exactly one deck — a 59-card
 * *Acidic Angels* that Caleb already owned a correct 60-card version of, and
 * which should never have been seeded at all. Both are gone. A seeded deck is
 * judged by `DEFAULT_DECK_RULES` like every other deck, and a short one is
 * REPORTED as short in its row, where he can now simply fix it.
 *
 * ## The source of truth is `docs/decks/`
 *
 * Each list below is derived from a `.txt` in `docs/decks/`, which is where the
 * transcriptions live and where the owner corrects them. `owner-decks.test.ts`
 * re-reads those files and fails on any divergence — name, count or ordering —
 * so the unavoidable second copy cannot answer differently (CLAUDE.md rule 12).
 */

import type { Deck } from '../../src/deck.js';
import { THUNES_LIFE, THUNES_LIFE_REVISIONS } from './thunes-life.js';
import { TAMIYO_JACE_SURGE } from './tamiyo-jace-surge.js';
import { applyDeckRevisions, type DeckRevision } from './revisions.js';

/** One owner deck plus the transcription it is derived from. */
export interface OwnerDeckEntry {
  /** The deck AS TRANSCRIBED — what the `.txt`'s plain lines say. */
  readonly deck: Deck;
  /** Repo-relative path to the `.txt` transcription that is its source of truth. */
  readonly source: string;
  /**
   * Dated, add-only additions he asked for after the transcription — the
   * `// revision` blocks of the same `.txt`, in order. Empty for a deck he has
   * not asked to change. See {@link applyDeckRevisions} and `revisions.ts`.
   */
  readonly revisions: readonly DeckRevision[];
}

/**
 * The registry. ONE row per deck — the deck and the file it came from — so the
 * divergence guard needs no table of its own to keep in step with this one.
 *
 * ⚠️ **`Acidic Angels` is deliberately absent and must not be re-added.** It was
 * here for one revision as a 59-card transcription; the owner already had a
 * correct 60-card *Acidic Angels* of his own in the app, made by copying the
 * built-in *Selesnya Blink* and renaming it (the rename that surfaced the
 * built-in-fork bug, DESIGN §3.35). Seeding a second, worse copy of a deck he
 * already owned is the defect, not the 59th card. `owner-decks.test.ts` fails if
 * the name comes back.
 */
export const OWNER_DECK_ENTRIES: readonly OwnerDeckEntry[] = Object.freeze([
  Object.freeze({ deck: THUNES_LIFE, source: 'docs/decks/thunes-life.txt', revisions: THUNES_LIFE_REVISIONS }),
  Object.freeze({ deck: TAMIYO_JACE_SURGE, source: 'docs/decks/tamiyo-jace-surge.txt', revisions: [] }),
]);

/** The owner's decks AS TRANSCRIBED, in the order they were scanned in. */
export const OWNER_DECKS: readonly Deck[] = Object.freeze(OWNER_DECK_ENTRIES.map((e) => e.deck));

/**
 * An owner deck as it stands TODAY — the transcription with every revision he
 * has asked for applied. What a fresh profile mints, and what the CLI plays.
 */
export function currentOwnerDeck(entry: OwnerDeckEntry): Deck {
  return applyDeckRevisions(entry.deck, entry.revisions);
}

/** Total cards a deck is transcribed as holding, before any pool resolution. */
export function transcribedSize(deck: Deck): number {
  return deck.cards.reduce((total, entry) => total + entry.count, 0);
}

export { THUNES_LIFE, THUNES_LIFE_REVISIONS, TAMIYO_JACE_SURGE };
export { applyDeckRevisions } from './revisions.js';
export type { DeckRevision } from './revisions.js';
