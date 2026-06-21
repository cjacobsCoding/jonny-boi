/**
 * Named configuration for the web app. Every behavior/feel constant lives here
 * (DESIGN.md §1: data-driven, no magic numbers). Components and logic read these
 * named tokens instead of inlining literals.
 */

/** Maximum copies of any one non-basic card allowed in a deck (MTG 4-of rule). */
export const MAX_COPIES_PER_CARD = 4;

/** A standard Constructed deck targets at least this many cards. */
export const MIN_DECK_SIZE = 60;

/** localStorage key under which the saved decks are persisted. */
export const DECKS_STORAGE_KEY = 'jonny-boi.decks.v1';

/** localStorage key for the id of the currently-open deck. */
export const ACTIVE_DECK_STORAGE_KEY = 'jonny-boi.activeDeckId.v1';

/** Default name for a freshly-created deck. */
export const DEFAULT_DECK_NAME = 'New Deck';

/**
 * The mana-value (CMC) buckets shown on the mana-curve chart. The last bucket is
 * inclusive of everything at-or-above its value (e.g. "7+").
 */
export const MANA_CURVE_BUCKETS = [0, 1, 2, 3, 4, 5, 6, 7] as const;

/** The highest explicit bucket (everything >= this is folded into the top bar). */
export const MANA_CURVE_MAX_BUCKET = 7;

/** WUBRG color filter options, in canonical Magic order, plus colorless. */
export const COLOR_FILTERS = [
  { code: 'W', label: 'White' },
  { code: 'U', label: 'Blue' },
  { code: 'B', label: 'Black' },
  { code: 'R', label: 'Red' },
  { code: 'G', label: 'Green' },
  { code: 'C', label: 'Colorless' },
] as const;

/** Card types we offer as filters (covers the curated pool's type lines). */
export const TYPE_FILTERS = [
  'Creature',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
  'Planeswalker',
  'Land',
] as const;

/** Sort options for the card browser. */
export const SORT_OPTIONS = [
  { id: 'name', label: 'Name' },
  { id: 'cmc-asc', label: 'Mana value ↑' },
  { id: 'cmc-desc', label: 'Mana value ↓' },
] as const;

export type SortId = (typeof SORT_OPTIONS)[number]['id'];
