/**
 * Turning a resolved import plan into a saved deck.
 *
 * Two things happen together and must not drift apart: the deck records which
 * cards it holds, and the imported-card store gains the display record + engine
 * definition for every card that came from outside the curated pool. If the
 * store were skipped, the deck would reference cards the app could neither draw
 * nor play — so both are done here, in one place.
 *
 * Only MAINDECK cards are put in the deck: the deck model has no sideboard, and
 * silently folding a sideboard into the 60 would produce a deck the user never
 * built. The counts returned say exactly what was left out.
 */

import { createDeck, type Deck, type DeckEntry } from '../deck.js';
import { registerImportedCards, type ImportedCard } from './importedCards.js';
import { isPlayable, type ImportPlan, type ResolvedLine } from './resolve.js';

/** What a build produced, for an honest post-import summary. */
export interface BuildResult {
  readonly deck: Deck;
  /** Copies actually placed in the deck. */
  readonly imported: number;
  /** Copies skipped because the engine cannot play them yet. */
  readonly skippedBlocked: number;
  /** Copies skipped because Scryfall had no such card. */
  readonly skippedNotFound: number;
  /** Copies skipped because they were in the sideboard/maybeboard. */
  readonly skippedSideboard: number;
  /** Cards added to the app's pool by this import (new to the user). */
  readonly newCards: number;
}

/** Default name when a list carries none. */
const FALLBACK_DECK_NAME = 'Imported Deck';

/** Merge duplicate lines of the same card into single deck entries. */
function toEntries(lines: readonly ResolvedLine[]): DeckEntry[] {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const id = line.card?.id;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + line.qty);
  }
  return [...counts.entries()].map(([cardId, count]) => ({ cardId, count }));
}

/**
 * Build a deck from an import plan and register any newly imported cards.
 *
 * @param plan The resolved plan (see `./resolve.ts`).
 * @param name Deck name; falls back to the list's own name, then a default.
 */
export function buildDeckFromPlan(plan: ImportPlan, name?: string): BuildResult {
  const playableMain = plan.lines.filter((line) => line.section === 'main' && isPlayable(line));

  // Cards that came from outside the curated pool need their display record and
  // compiled definition stored before the deck can render or play them.
  const newCards: ImportedCard[] = [];
  for (const line of plan.lines) {
    if (line.status !== 'compiled' || !line.card || !line.definition) continue;
    if (newCards.some((entry) => entry.card.id === line.card!.id)) continue;
    newCards.push({ card: line.card, definition: line.definition });
  }
  registerImportedCards(newCards);

  const deck: Deck = {
    ...createDeck(name?.trim() || plan.deckName?.trim() || FALLBACK_DECK_NAME),
    cards: toEntries(playableMain),
  };

  let skippedSideboard = 0;
  for (const line of plan.lines) {
    if (line.section !== 'main' && isPlayable(line)) skippedSideboard += line.qty;
  }

  return {
    deck,
    imported: playableMain.reduce((sum, line) => sum + line.qty, 0),
    skippedBlocked: plan.counts.blocked,
    skippedNotFound: plan.counts.notFound,
    skippedSideboard,
    newCards: newCards.length,
  };
}
