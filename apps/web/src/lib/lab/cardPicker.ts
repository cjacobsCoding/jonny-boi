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
 *
 * ## §3.181 — and an APPROXIMATE pass, when the caller asks for one
 *
 * The four tiers above are all SUBSTRING tiers. Measured plainly: a typo or a
 * half-remembered name found nothing here, which made this — the surface a user
 * is most likely to be hunting one specific card on — the least capable of the
 * app's three card searches at an approximate name. The deck builder had
 * Scryfall's fuzzy endpoint and the scan dialog had `matchCardName`; the Lab had
 * `startsWith`.
 *
 * So an optional approximate pass APPENDS near-misses below the exact hits,
 * reading the app's one fuzzy matcher (`scan/match.ts`'s `matchOneQuery`)
 * rather than adding a fourth implementation. It is strictly additive — see
 * {@link fuzzyExtras} — and it is offered only above
 * {@link CARD_PICKER_FUZZY_MIN_OPTIONS}, which is Caleb's ">10 options" rule.
 */
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { queryCards, type CardQuery } from '../filter.js';
import { buildNameIndex, matchOneQuery, normalizeForMatch, type NameIndex } from '../scan/match.js';

/* -------------------------------------------------------------------------- */
/* §3.181 — the two rules Caleb asked for, as named constants                  */
/* -------------------------------------------------------------------------- */

/**
 * How long a pointer must REST on an option, or an arrow key leave the
 * selection on it, before the card itself is raised.
 *
 * > "each option in the list must be hoverable to show the specific card if you
 * > pause over an item for a couple seconds without clicking"
 *
 * "A couple of seconds" is taken literally rather than tuned down to something
 * that feels snappier in a demo: the whole point is that running the pointer
 * down a list must NOT flash twenty card images, so the delay has to be long
 * enough to read as a deliberate pause. It is a constant because it is a feel
 * decision, and the test that proves the dwell works reads THIS — a test with
 * `2000` written in it stops testing anything the moment the feel changes.
 */
export const CARD_PREVIEW_DWELL_MS = 2000;

/**
 * Above how many options a picker OFFERS fuzzy matching.
 *
 * > "all such dropdowns should show a text-typable filter that optionally
 * > allows for fuzzy search if there are more than 10 options in the list"
 *
 * Strictly "more than", so a list of exactly this many does not offer it — the
 * boundary is the thing a test has to pin, and reading it from here is what
 * makes that test honest.
 */
export const CARD_PICKER_FUZZY_MIN_OPTIONS = 10;

/**
 * The similarity floor for the picker's approximate pass.
 *
 * Deliberately NOT scan's `MIN_MATCH_SCORE`: that one is tuned for a camera's
 * mistakes, and a picker that inherited it would be tuned by accident (see
 * `matchOneQuery`). A typist's errors are fewer and more local than OCR's, so
 * the bar is set higher — a loose floor over a 7k-card pool returns confident
 * nonsense, which is worse than returning nothing.
 */
export const CARD_PICKER_FUZZY_MIN_SCORE = 0.62;

/**
 * Shortest typed term the approximate pass will run on. One or two characters
 * are within an edit or two of hundreds of names, so fuzzy on a short term is
 * noise that buries the substring matches the user is actually watching.
 */
export const CARD_PICKER_FUZZY_MIN_TERM = 3;

/** How many approximate matches may be appended. They follow every exact hit. */
export const CARD_PICKER_FUZZY_MAX_EXTRAS = 10;

/** Does a list this long offer the fuzzy toggle at all? (Caleb's ">10" rule.) */
export function offersFuzzy(optionCount: number): boolean {
  return optionCount > CARD_PICKER_FUZZY_MIN_OPTIONS;
}

/**
 * The name vocabulary the approximate pass searches, built once per option set.
 *
 * Built over EVERY candidate rather than the currently-filtered subset so the
 * caller can memoise it on `options` alone; the filters are applied to the
 * RESULT instead (see {@link listPickableCards}). Rebuilding a 7k-name index on
 * every keystroke was the alternative, and it is the one that would have shown
 * up as the picker feeling broken.
 */
export function buildFuzzyIndex(candidates: readonly NormalizedCard[]): NameIndex {
  return buildNameIndex(candidates.map((card) => card.name));
}

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
  /**
   * How many of `rows`, counted from the END, are APPROXIMATE matches that the
   * exact pass missed. Zero whenever fuzzy is off or added nothing. The picker
   * labels them, because "Lighming Bolt matched Lightning Bolt" is only helpful
   * if the user can see WHICH rows are guesses.
   */
  readonly fuzzy: number;
}

/** The approximate pass's inputs: the prepared vocabulary, and whether it runs. */
export interface FuzzySearch {
  readonly index: NameIndex;
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
 * Approximate matches for `term` that the exact pass did not already return.
 *
 * STRICTLY ADDITIVE, and that is a deliberate semantic: turning fuzzy on may
 * only ever ADD rows below the exact ones, never reorder or remove them. A user
 * who has typed enough to see the card they want must not watch it move because
 * a checkbox is on — and it means the toggle can never make the picker worse,
 * which is why it is safe to offer rather than something to warn about.
 *
 * The colour/type/mana filters still rule: the vocabulary is indexed over every
 * candidate (so the index memoises), and anything the live filters exclude is
 * dropped from the RESULT here. Otherwise ticking "red" and typing a typo would
 * surface a blue card, and the filter would look broken rather than the search
 * clever.
 */
function fuzzyExtras(
  term: string,
  allowed: readonly NormalizedCard[],
  already: readonly NormalizedCard[],
  fuzzy: FuzzySearch,
): NormalizedCard[] {
  const query = normalizeForMatch(term);
  if (query.length < CARD_PICKER_FUZZY_MIN_TERM) return [];

  const have = new Set(already.map((card) => card.id));
  const byName = new Map<string, NormalizedCard>();
  for (const card of allowed) if (!byName.has(card.name)) byName.set(card.name, card);

  const extras: NormalizedCard[] = [];
  const matches = [...matchOneQuery(query, fuzzy.index, CARD_PICKER_FUZZY_MIN_SCORE)].sort(
    (a, b) => b.score - a.score || a.name.localeCompare(b.name),
  );
  for (const match of matches) {
    const card = byName.get(match.name);
    if (card === undefined || have.has(card.id)) continue;
    extras.push(card);
    if (extras.length >= CARD_PICKER_FUZZY_MAX_EXTRAS) break;
  }
  return extras;
}

/**
 * The rows the picker should list for `query` over `candidates`, ranked and
 * capped. `queryCards` does the filtering (the browser's one implementation);
 * the ranking is this module's. Pass `fuzzy` to append approximate matches.
 */
export function listPickableCards(
  candidates: readonly NormalizedCard[],
  query: CardQuery,
  fuzzy?: FuzzySearch,
): CardPickerListing {
  const matched = queryCards(candidates, query);
  const ranked = rankForTerm(matched, query.search);
  // What the filters alone allow — the ceiling the approximate pass may pick
  // from, so fuzzy can never smuggle a card past an active colour/type chip.
  const extras =
    fuzzy === undefined
      ? []
      : fuzzyExtras(query.search, queryCards(candidates, { ...query, search: '' }), ranked, fuzzy);
  const all = extras.length === 0 ? ranked : [...ranked, ...extras];
  const rows = all.slice(0, CARD_PICKER_MAX_ROWS);
  // Only the approximate rows that SURVIVED the cap are labelled as such.
  const fuzzyShown = Math.max(0, rows.length - ranked.length);
  return { rows, omitted: all.length - rows.length, total: all.length, fuzzy: fuzzyShown };
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
  fuzzy?: FuzzySearch,
): CardPickerListing {
  const inRange =
    bounds.min === undefined && bounds.max === undefined
      ? candidates
      : candidates.filter((card) => withinManaValue(card, bounds));
  return listPickableCards(inRange, query, fuzzy);
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
