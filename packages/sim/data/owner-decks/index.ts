/**
 * THE OWNER'S REAL DECKS — the physical, sleeved decks that exist on a table,
 * transcribed card by card and bundled with the app so they are simply THERE.
 *
 * ## Why this is a separate registry and not more rows in `SAMPLE_DECKS`
 *
 * `data/decks/index.ts` is not a bag of decks: it **is** the §3.8 meta gauntlet
 * the Lab A/B-tests every verdict against. Its spread of identities was tuned on
 * purpose so each deck is somebody's bad matchup, and a gauntlet matchup is
 * seeded by the opponent's INDEX — that file's own comment records that merely
 * *reordering* it moved a recorded baseline. Adding three personal decks to it
 * would change the field every A/B verdict is measured against, so every number
 * the lab has ever produced would silently mean something else.
 *
 * So: a second registry, same idiom (one data file per deck, this index collects
 * them), surfaced beside the gauntlet decks in the builder and in every deck
 * picker, and never entering the gauntlet. Adding a deck stays a data edit
 * (CLAUDE.md rule 2): drop a file in this directory and add ONE row below.
 *
 * ## These lists are a transcription, and transcriptions are not edited
 *
 * The NAMES are read off the physical cards. The COUNTS are inferred from
 * sleeve-edge depth and the mana bases are the least certain part
 * (`docs/decks/README.md` §Confidence). Two of the three are not 60 cards. They
 * are shipped exactly as transcribed — padding a deck to a legal 60 would mean
 * inventing a card the owner does not own, and the moment that happens this is
 * no longer a record of his deck. What the app does instead is REPORT: the
 * builder names every card the pool cannot supply, and `OWNER_DECK_RULES` makes
 * "legal" mean "all of it is here", not "it reached sixty somehow".
 *
 * ## The source of truth is `docs/decks/`
 *
 * Each list below is derived from a `.txt` in `docs/decks/`, which is where the
 * transcriptions live and where the owner corrects them. `owner-decks.test.ts`
 * re-reads those files and fails on any divergence — name, count or ordering —
 * so the unavoidable second copy cannot answer differently (CLAUDE.md rule 12).
 */

import type { Deck } from '../../src/deck.js';
import type { DeckRules } from '../../src/config.js';
import { DEFAULT_DECK_RULES } from '../../src/config.js';
import { ACIDIC_ANGELS } from './acidic-angels.js';
import { THUNES_LIFE } from './thunes-life.js';
import { TAMIYO_JACE_SURGE } from './tamiyo-jace-surge.js';

/** One owner deck plus the transcription it is derived from. */
export interface OwnerDeckEntry {
  readonly deck: Deck;
  /** Repo-relative path to the `.txt` transcription that is its source of truth. */
  readonly source: string;
}

/**
 * The registry. ONE row per deck — the deck and the file it came from — so the
 * divergence guard needs no table of its own to keep in step with this one.
 */
export const OWNER_DECK_ENTRIES: readonly OwnerDeckEntry[] = Object.freeze([
  Object.freeze({ deck: ACIDIC_ANGELS, source: 'docs/decks/acidic-angels.txt' }),
  Object.freeze({ deck: THUNES_LIFE, source: 'docs/decks/thunes-life.txt' }),
  Object.freeze({ deck: TAMIYO_JACE_SURGE, source: 'docs/decks/tamiyo-jace-surge.txt' }),
]);

/** The owner's decks, in the order they were scanned in. */
export const OWNER_DECKS: readonly Deck[] = Object.freeze(OWNER_DECK_ENTRIES.map((e) => e.deck));

/** Total cards a deck is transcribed as holding, before any pool resolution. */
export function transcribedSize(deck: Deck): number {
  return deck.cards.reduce((total, entry) => total + entry.count, 0);
}

/**
 * The legality rules a PAPER deck is judged by.
 *
 * ⚠️ Read the minimum carefully: it is the deck's OWN transcribed size, not 60.
 * That is not a relaxation, it is a different question. A constructed deck is
 * legal at ≥ 60 cards because that is the floor a player may build to. A paper
 * deck has already been built — it is sitting in a box — so the only thing worth
 * checking is whether the app can actually deal out the thing that exists. A
 * 59-card deck whose 59 cards are all present is complete; a 65-card deck that
 * resolves to 47 is not, and it must refuse rather than shuffle up 47 cards and
 * call it his deck. *"A deck that resolves to a handful of lands is not a deck."*
 *
 * Deliberately derived per deck rather than stored: a count corrected in
 * `docs/decks/` flows straight through, with nothing to keep in step by hand.
 *
 * The 4-of limit and the basic-land exemption are UNCHANGED — a transcription
 * that somehow holds five Thragtusk is a transcription error, and that is
 * exactly the sort of thing this should still catch.
 */
export function ownerDeckRules(deck: Deck): DeckRules {
  return Object.freeze({
    ...DEFAULT_DECK_RULES,
    minDeckSize: transcribedSize(deck),
  });
}

export { ACIDIC_ANGELS, THUNES_LIFE, TAMIYO_JACE_SURGE };
