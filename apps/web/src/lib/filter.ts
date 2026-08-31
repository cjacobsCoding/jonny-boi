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

/**
 * The token `parseTypeLine` leaves behind where a combined type line joins its
 * two halves ("Instant // Sorcery" parses to `['Instant', '//', 'Sorcery']`). It
 * is a separator, not a card type, so it must never be matchable.
 */
const FACE_SEPARATOR_TOKEN = '//';

/**
 * Every card type this card can be filtered by — its own type line PLUS each
 * face's, minus the `//` separator token.
 *
 * A one-face card's answer is just its own types. A multi-face card's is the
 * union, and that union is the whole point: `parseTypeLine` reads a *combined*
 * type line, and only the FIRST face's types survive it intact. Whether a back
 * face's type is visible at all comes down to whether the front face happens to
 * have a subtype dash —
 *
 *   "Sorcery // Land"              → types ['Sorcery', '//', 'Land']  ✔ Land
 *   "Creature — Elephant // Land"  → types ['Creature']               ✘ Land
 *
 * — so `Bala Ged Recovery` answered the Land chip and `Kazandu Mammoth`, the
 * same kind of card, did not. Twenty of the pool's fifty multi-face cards had a
 * face no chip could reach, and the three `Battle — Siege // …` Invasions
 * matched no chip at all. Reading the faces makes the answer depend on the card
 * instead of on its punctuation.
 *
 * Exported so the pool's own coverage is directly testable, not inferred from
 * the browser's result count.
 */
export function filterableTypes(card: NormalizedCard): ReadonlySet<string> {
  const types = new Set<string>();
  const collect = (list: readonly string[] | undefined): void => {
    for (const type of list ?? []) {
      if (type !== FACE_SEPARATOR_TOKEN) types.add(type);
    }
  };
  collect(card.typeLine.types);
  for (const face of card.faces ?? []) collect(face.typeLine?.types);
  return types;
}

/** True when the card satisfies the type filter (any face carries any type). */
function matchesTypes(card: NormalizedCard, types: ReadonlySet<string>): boolean {
  if (types.size === 0) return true;
  const own = filterableTypes(card);
  for (const type of types) {
    if (own.has(type)) return true;
  }
  return false;
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
