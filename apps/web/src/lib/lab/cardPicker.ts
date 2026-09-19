/**
 * THE CARD PICKER'S MODEL — pure, DOM-free (DESIGN §3.165).
 *
 * > "the dropdowns in Lab -> A/B Test are awful to use. Anytime we have a card
 * > selector dropdown like this in the app, we must make it one where you can
 * > type to filter, and expose advanced settings to filter further too - to
 * > help you find the one card."
 *
 * A native `<select>` over a 7,000-card pool is a scroll wheel with no search.
 * This module is what the picker shows for a given text and filter state: it
 * reuses the card browser's own {@link CardQuery} (search, colour chips, type
 * chips) so a filter means exactly one thing across the app, and adds the
 * ranking a PICKER needs that a BROWSER does not — an exact name, then a typed
 * prefix, then a word inside the name, then a substring — and the list is
 * capped so the dropdown never tries to render the pool. Which cards are
 * candidates at all is the caller's call (the hero's cards for "cut", the whole
 * pool for "add"); this module never widens or narrows that set.
 */
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { queryCards, type CardQuery } from '../filter.js';

/** One pickable card, with how many copies the deck holds when it came from one. */
export interface PickableCard {
  readonly cardId: string;
  readonly name: string;
  readonly count?: number;
}

/** How many rows the dropdown lists before it says "keep typing". */
export const CARD_PICKER_MAX_ROWS = 40;

/** What the picker lists: the matches in rank order, and how many it left out. */
export interface CardPickerListing {
  readonly rows: readonly NormalizedCard[];
  readonly omitted: number;
  readonly total: number;
}

/**
 * Rank matches for a typed term: an exact name first, then names that START
 * with the term, then the rest — each tier alphabetical. A picker is a search
 * for ONE card, and "Soul" should put Soul Warden above Restless Soul.
 */
function rankForTerm(cards: readonly NormalizedCard[], term: string): NormalizedCard[] {
  const t = term.trim().toLowerCase();
  if (t.length === 0) return [...cards];
  const tier = (card: NormalizedCard): number => {
    const name = card.name.toLowerCase();
    if (name === t) return 0;
    if (name.startsWith(t)) return 1;
    // A word boundary inside the name ("of Thune") beats a mid-word hit.
    if (name.includes(` ${t}`)) return 2;
    return 3;
  };
  return [...cards].sort((a, b) => tier(a) - tier(b) || a.name.localeCompare(b.name));
}

/**
 * The rows the picker should list for `query` over `candidates`, ranked and
 * capped. `queryCards` does the filtering (the browser's one implementation);
 * the ranking is this module's.
 */
export function listPickableCards(candidates: readonly NormalizedCard[], query: CardQuery): CardPickerListing {
  const matched = queryCards(candidates, query);
  const ranked = rankForTerm(matched, query.search);
  const rows = ranked.slice(0, CARD_PICKER_MAX_ROWS);
  return { rows, omitted: ranked.length - rows.length, total: ranked.length };
}

/**
 * Mana value bounds are the one "advanced" filter the browser's query does not
 * carry (the browser sorts by it instead). Applied on top of {@link queryCards}
 * so the rest of the vocabulary stays the browser's.
 */
export interface ManaValueBounds {
  readonly min?: number;
  readonly max?: number;
}

export function withinManaValue(card: NormalizedCard, bounds: ManaValueBounds): boolean {
  if (bounds.min !== undefined && card.cmc < bounds.min) return false;
  if (bounds.max !== undefined && card.cmc > bounds.max) return false;
  return true;
}

/** {@link listPickableCards} with the mana-value bounds applied first. */
export function listPickableCardsWithin(
  candidates: readonly NormalizedCard[],
  query: CardQuery,
  bounds: ManaValueBounds,
): CardPickerListing {
  const inRange =
    bounds.min === undefined && bounds.max === undefined
      ? candidates
      : candidates.filter((card) => withinManaValue(card, bounds));
  return listPickableCards(inRange, query);
}

/** The picker's whole filter state — the browser query plus the bounds. */
export interface CardPickerFilters {
  readonly query: CardQuery;
  readonly manaValue: ManaValueBounds;
}

/** True when any filter beyond the typed text is active — what the "Filters" toggle reports. */
export function hasAdvancedFilters(filters: CardPickerFilters): boolean {
  return (
    filters.query.colors.size > 0 ||
    filters.query.types.size > 0 ||
    filters.manaValue.min !== undefined ||
    filters.manaValue.max !== undefined
  );
}
