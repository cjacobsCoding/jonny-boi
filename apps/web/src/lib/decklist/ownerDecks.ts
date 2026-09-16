/**
 * THE OWNER'S REAL DECKS, as things the app can list, open and play.
 *
 * ## What was wrong
 *
 * His three physical decks existed only as `.txt` files in `docs/decks/`. To use
 * one he would have had to find the file, open it, copy it, and paste it into
 * the importer — so he opened the app, looked for his decks, and they were not
 * there. Code that is written, committed and unreachable is not delivered; this
 * module is the reachable end of `packages/sim/data/owner-decks/`.
 *
 * ## Why it resolves through the gauntlet path
 *
 * A bundled sim deck names its cards (`'Acidic Slime'`); a web deck keys on the
 * Scryfall UUID. That translation already exists, once, in `gauntletDecks.ts`,
 * and it already REPORTS the names the pool cannot supply instead of dropping
 * them silently. A second resolver here would be a second answer to one question
 * and the two would eventually disagree (CLAUDE.md rule 12), so this module
 * calls `copyGauntletDeck` and reads its `unresolved` — the copy path and the
 * "is it complete?" readout are the same computation by construction.
 *
 * ## The pool moves under these decks, on purpose
 *
 * A name is unresolved because the compiler does not carry that card YET; the
 * all-cards campaign lands those families one at a time and the number goes up
 * on its own. So nothing here hardcodes what a deck resolves to. The summary is
 * computed from the live pool every time, the UI states it in the deck's own
 * row, and `ownerDecks.test.ts` pins a FLOOR per deck so a drop fails red while
 * growth just... grows.
 */

import { OWNER_DECK_ENTRIES, type Deck as SimDeck } from '@jonny-boi/sim';
import { copyGauntletDeck, type GauntletCopy } from './gauntletDecks.js';
import { deckSize } from '../deck.js';

/** One owner deck, with everything the builder needs to describe it honestly. */
export interface OwnerDeckSummary {
  readonly name: string;
  readonly archetype: string;
  /** Distinct card names in the transcription. */
  readonly names: number;
  /** Of those, how many the pool can actually supply. */
  readonly resolvedNames: number;
  /** Cards in the transcription — the deck as it exists in his box. */
  readonly transcribedSize: number;
  /** Cards the app can actually deal out today. Equal to {@link transcribedSize} when complete. */
  readonly resolvedSize: number;
  /**
   * The names the pool could not supply, each with its count (`'4 Axebane
   * Guardian'`). Empty means the deck is all there. NON-EMPTY MEANS THE UI MUST
   * SAY SO — a deck that resolves to a handful of lands is not a deck.
   */
  readonly missing: readonly string[];
  /** Repo-relative path to the transcription, so the row can cite its source. */
  readonly source: string;
  /** The underlying sim deck — for copying, and for playing directly. */
  readonly deck: SimDeck;
}

/** True when every card in the transcription is in the pool. */
export function isComplete(summary: OwnerDeckSummary): boolean {
  return summary.missing.length === 0;
}

/** Total cards a sim deck is transcribed as holding. */
function simDeckSize(deck: SimDeck): number {
  return deck.cards.reduce((total, entry) => total + entry.count, 0);
}

/**
 * Describe one owner deck against the pool as it stands right now.
 *
 * The count is attached to each missing name because "Axebane Guardian is
 * missing" and "four of the deck's forty-nine cards are missing" are different
 * sizes of problem and the row has to convey the second.
 */
function summarize(deck: SimDeck, source: string): OwnerDeckSummary {
  const copy: GauntletCopy = copyGauntletDeck(deck, '');
  const missingCounts = new Map<string, number>();
  for (const entry of deck.cards) {
    if (copy.unresolved.includes(entry.cardId)) {
      missingCounts.set(entry.cardId, (missingCounts.get(entry.cardId) ?? 0) + entry.count);
    }
  }
  return {
    name: deck.name,
    archetype: deck.archetype,
    names: deck.cards.length,
    resolvedNames: deck.cards.length - missingCounts.size,
    transcribedSize: simDeckSize(deck),
    resolvedSize: deckSize(copy.deck),
    missing: [...missingCounts].map(([name, count]) => `${count} ${name}`),
    source,
    deck,
  };
}

/**
 * Every owner deck, measured against the pool.
 *
 * Computed per call and NOT memoized: the pool grows at runtime when the user
 * imports or scans a card, and a cached "5 cards missing" that survives the
 * import of one of them is the exact shape of lie this module exists to avoid.
 * Three decks over an already-built name index is cheap; the caller memoizes on
 * its own render inputs if it needs to.
 */
export function ownerDeckSummaries(): readonly OwnerDeckSummary[] {
  return OWNER_DECK_ENTRIES.map((entry) => summarize(entry.deck, entry.source));
}

/**
 * The one sentence a short deck says about itself.
 *
 * Empty string when the deck is complete — the caller renders nothing rather
 * than a reassuring "0 missing", which is noise on the decks that are fine.
 */
export function describeShortfall(summary: OwnerDeckSummary): string {
  if (isComplete(summary)) return '';
  const cardsMissing = summary.transcribedSize - summary.resolvedSize;
  return (
    `Incomplete — ${summary.resolvedSize} of ${summary.transcribedSize} cards. ` +
    `${summary.missing.length} of its ${summary.names} cards ${summary.missing.length === 1 ? 'is' : 'are'} ` +
    `not in the card pool yet, which is ${cardsMissing} card${cardsMissing === 1 ? '' : 's'} of the deck: ` +
    `${summary.missing.join(', ')}.`
  );
}

/** The line a COMPLETE deck says about itself — stated, so silence is never the claim. */
export function describeCompleteness(summary: OwnerDeckSummary): string {
  if (!isComplete(summary)) return describeShortfall(summary);
  return `All ${summary.names} cards are in the pool — this deck plays exactly as built.`;
}
