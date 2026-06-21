/**
 * Pure search / filter / sort logic for the card browser. Kept dependency-free
 * and DOM-free so it is straightforward to unit-test (DESIGN.md §1.4).
 */
import type { NormalizedCard } from '@jonny-boi/data-tools';
import type { SortId } from './config.js';
import { primaryType } from './cards.js';

/** A description of the active browser query: text + color/type filters + sort. */
export interface CardQuery {
  /** Free-text search against the card name (case-insensitive, substring). */
  search: string;
  /** Selected color codes (WUBRG / C). Empty = no color constraint. */
  colors: ReadonlySet<string>;
  /** Selected type names. Empty = no type constraint. */
  types: ReadonlySet<string>;
  /** Sort order to apply to the result. */
  sort: SortId;
}

/** An empty query that matches everything, sorted by name. */
export const EMPTY_QUERY: CardQuery = {
  search: '',
  colors: new Set(),
  types: new Set(),
  sort: 'name',
};

/** True when the card matches the free-text name search. */
function matchesSearch(card: NormalizedCard, search: string): boolean {
  const term = search.trim().toLowerCase();
  if (term.length === 0) return true;
  return card.name.toLowerCase().includes(term);
}

/** True when the card satisfies the color filter (any selected color present). */
function matchesColors(card: NormalizedCard, colors: ReadonlySet<string>): boolean {
  if (colors.size === 0) return true;
  // "C" (colorless) matches cards with no colors; otherwise match by overlap.
  for (const code of colors) {
    if (code === 'C') {
      if (card.colors.length === 0) return true;
    } else if (card.colors.includes(code)) {
      return true;
    }
  }
  return false;
}

/** True when the card satisfies the type filter (its type line includes any). */
function matchesTypes(card: NormalizedCard, types: ReadonlySet<string>): boolean {
  if (types.size === 0) return true;
  return card.typeLine.types.some((type) => types.has(type));
}

/** Comparison helper for the active sort order. */
function compareCards(a: NormalizedCard, b: NormalizedCard, sort: SortId): number {
  switch (sort) {
    case 'cmc-asc':
      return a.cmc - b.cmc || a.name.localeCompare(b.name);
    case 'cmc-desc':
      return b.cmc - a.cmc || a.name.localeCompare(b.name);
    case 'name':
    default:
      return a.name.localeCompare(b.name);
  }
}

/**
 * Apply a {@link CardQuery} to a card list: filter by search/color/type, then
 * sort. Returns a new array; never mutates the input.
 */
export function queryCards(
  cards: readonly NormalizedCard[],
  query: CardQuery,
): NormalizedCard[] {
  const filtered = cards.filter(
    (card) =>
      matchesSearch(card, query.search) &&
      matchesColors(card, query.colors) &&
      matchesTypes(card, query.types),
  );
  return filtered.sort((a, b) => compareCards(a, b, query.sort));
}

/** Re-export for callers that group results by their primary type. */
export { primaryType };
