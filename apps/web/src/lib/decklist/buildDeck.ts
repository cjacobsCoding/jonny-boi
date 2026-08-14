/**
 * Turning a resolved import plan into a saved deck.
 *
 * Two things happen together and must not drift apart: the deck records which
 * cards it holds, and the imported-card store gains the display record (plus the
 * engine definition, when there is one) for every card that came from outside
 * the curated pool. If the store were skipped, the deck would reference cards
 * the app could neither draw nor show — so both are done here, in one place.
 *
 * WHAT GOES IN THE DECK: every card Scryfall could identify, including the ones
 * the engine cannot play yet. You asked to import a deck, so you get the deck.
 * A card whose rules text needs an engine system we lack is carried as a real
 * card — visible, countable, proxy-printable — and flagged so the Lab can refuse
 * to simulate the deck BY NAME. The alternative, silently dropping it, hands
 * back a crippled list and tells you nothing about what happened to it.
 *
 * Only MAINDECK cards are put in the deck: the deck model has no sideboard, and
 * silently folding a sideboard into the 60 would produce a deck the user never
 * built. The counts returned say exactly what was left out.
 */

import { createDeck, type Deck, type DeckEntry } from '../deck.js';
import { registerImportedCards, type ImportedCard } from './importedCards.js';
import { isPlayable, type ImportPlan, type ResolvedLine } from './resolve.js';

/** A card that landed in the deck but cannot be simulated yet. */
export interface UnsupportedImport {
  readonly name: string;
  readonly qty: number;
  /** The engine systems its text needs, deduplicated, for a one-line reason. */
  readonly systems: readonly string[];
}

/** What a build produced, for an honest post-import summary. */
export interface BuildResult {
  readonly deck: Deck;
  /** Copies actually placed in the deck (playable + unsupported). */
  readonly imported: number;
  /** Copies in the deck that the engine cannot play yet. */
  readonly unsupported: number;
  /** Which cards those were, by name — never just a count. */
  readonly unsupportedCards: readonly UnsupportedImport[];
  /** Copies left out because Scryfall had no such card. */
  readonly skippedNotFound: number;
  /** Which names Scryfall did not recognize — so a typo is fixable. */
  readonly notFoundNames: readonly string[];
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
  // Everything Scryfall identified goes in the deck — playable or not. Only a
  // name Scryfall could not resolve has no card to put anywhere.
  const inDeck = plan.lines.filter((line) => line.section === 'main' && line.card);

  // Cards from outside the curated pool need their display record stored (plus
  // their definition when they have one) before the deck can render them.
  const newCards: ImportedCard[] = [];
  for (const line of plan.lines) {
    if (!line.card) continue;
    if (line.status !== 'compiled' && line.status !== 'blocked') continue;
    if (newCards.some((entry) => entry.card.id === line.card!.id)) continue;
    newCards.push(
      line.definition
        ? { card: line.card, definition: line.definition }
        : { card: line.card, missing: line.missing ?? [] },
    );
  }
  registerImportedCards(newCards);

  const deck: Deck = {
    ...createDeck(name?.trim() || plan.deckName?.trim() || FALLBACK_DECK_NAME),
    cards: toEntries(inDeck),
  };

  let skippedSideboard = 0;
  for (const line of plan.lines) {
    if (line.section !== 'main' && isPlayable(line)) skippedSideboard += line.qty;
  }

  return {
    deck,
    imported: inDeck.reduce((sum, line) => sum + line.qty, 0),
    unsupported: plan.counts.blocked,
    unsupportedCards: summarizeUnsupported(inDeck),
    skippedNotFound: plan.counts.notFound,
    notFoundNames: notFoundNames(plan),
    skippedSideboard,
    newCards: newCards.length,
  };
}

/** The unsupported cards that landed in the deck, merged by name. */
function summarizeUnsupported(lines: readonly ResolvedLine[]): UnsupportedImport[] {
  const byName = new Map<string, { qty: number; systems: Set<string> }>();
  for (const line of lines) {
    if (isPlayable(line)) continue;
    const entry = byName.get(line.name) ?? { qty: 0, systems: new Set<string>() };
    entry.qty += line.qty;
    for (const gap of line.missing ?? []) entry.systems.add(gap.missingEngineSystem);
    byName.set(line.name, entry);
  }
  return [...byName.entries()]
    .map(([name, entry]) => ({ name, qty: entry.qty, systems: [...entry.systems].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Distinct names Scryfall could not find, in list order. */
function notFoundNames(plan: ImportPlan): string[] {
  const names: string[] = [];
  for (const line of plan.lines) {
    if (line.status === 'notFound' && !names.includes(line.name)) names.push(line.name);
  }
  return names;
}
