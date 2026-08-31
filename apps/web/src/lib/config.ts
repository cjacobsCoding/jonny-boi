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
 * localStorage key under which the ONE in-progress local/solo game is persisted
 * (see `lib/play/persist.ts`). Versioned in the key so a future incompatible
 * record shape can move to `.v2` and leave stale `.v1` blobs unread rather than
 * misread; the record ALSO carries a `version` field checked on decode.
 */
export const PLAY_RESUME_STORAGE_KEY = 'jonny-boi.play.inProgress.v1';

/**
 * sessionStorage key for the "this reload was triggered by an app UPDATE" flag
 * (see `lib/update/updater.ts`). Written immediately before an update-triggered
 * reload — never by user navigation — and consumed (removed) on the next boot,
 * so the app returns to the screen/scroll/game the update interrupted exactly
 * once. sessionStorage on purpose: it is per-tab and survives a reload, so a
 * second tab or a next-day launch cannot replay a stale restore.
 */
export const UPDATE_RESUME_FLAG_KEY = 'jonny-boi.update.resume.v1';

/**
 * How long after the last game change the in-progress record is written, in ms.
 * Debounced because a single user gesture (auto-tap + cast, an AI turn) commits
 * several actions back-to-back; one write per burst is plenty. Kept short so a
 * surprise tab kill loses at most a beat — and force-flushed (bypassing the
 * debounce) before any update-triggered reload and on page hide.
 */
export const PLAY_PERSIST_DEBOUNCE_MS = 250;

/**
 * How often a long-lived session re-checks the server for a new build, in ms.
 * Registration already checks on every launch; this catches the marathon
 * session that never reloads. Half an hour keeps update latency low without
 * meaningfully spamming the host.
 */
export const SW_UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Refuse to LOAD a persisted game record larger than this many characters.
 * A record this size is not a game this app produced (a full game's action log
 * is tens of KB); treating it as corrupt keeps a poisoned or bloated blob from
 * stalling boot with a multi-second parse+replay. Writes are capped by the same
 * limit so we can never store what we would then refuse to read.
 */
export const PLAY_PERSIST_MAX_CHARS = 2_000_000;

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
