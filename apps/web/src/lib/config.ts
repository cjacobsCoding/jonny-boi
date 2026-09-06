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
 * localStorage key for "always let me choose which mana pays" (§3.60). A player
 * PREFERENCE, not game state: it outlives any one game and applies to the next
 * one, which is why it is not in the resume record.
 */
export const MANA_CHOICE_STORAGE_KEY = 'jonny-boi.play.chooseMana.v1';

/**
 * localStorage key for AI CO-PILOT mode (§3.67) — "show me what the AI would do
 * on my turn". A player PREFERENCE like the mana one: it outlives a game and is
 * not part of the game's state, so it is deliberately not in the resume record
 * (a saved game must replay the same whether the hints were on or off).
 */
export const COPILOT_STORAGE_KEY = 'jonny-boi.play.copilot.v1';

/**
 * localStorage key for the PRIORITY STOPS (§3.119) — which steps the game
 * pauses in when the player holds an instant-speed play, whether an opponent's
 * spell on the stack stops for a response, and the "full control" override. A
 * player PREFERENCE exactly like the two above: it outlives a game and is not
 * part of the game's state, so a saved game replays the same whatever the
 * stops were set to.
 */
export const PRIORITY_STOPS_STORAGE_KEY = 'jonny-boi.play.priorityStops.v1';

/**
 * localStorage key for the game-audio preference (§3.130 — the procedural SFX
 * engine): whether sound is on, and the master volume. A player setting that
 * outlives a game, like the mana and stops prefs above.
 */
export const SOUND_STORAGE_KEY = 'jonny-boi.play.sound.v1';

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
 * localStorage key for the GAME LIBRARY (§3.66): every game played, finished or
 * not, so any of them can be reviewed, scrubbed, forked or resumed. Separate
 * from {@link PLAY_RESUME_STORAGE_KEY}, which stays the pointer to the ONE game
 * currently open — losing the library must never cost you the game in front of
 * you, and a corrupt library must not be able to stop that game resuming.
 */
export const PLAY_HISTORY_STORAGE_KEY = 'jonny-boi.play.history.v1';

/**
 * How many games the library keeps. Pruning drops the oldest FINISHED games
 * only — an unfinished game is one you could still return to, and the library
 * must not decide to forget that for you.
 */
export const PLAY_HISTORY_LIMIT = 50;

/**
 * The library's own size cap, larger than one record's because it holds many.
 * Same discipline as {@link PLAY_PERSIST_MAX_CHARS}: reads refuse a blob this
 * big, and writes shed old finished games rather than storing what a read would
 * then refuse.
 */
export const PLAY_HISTORY_MAX_CHARS = 4_000_000;

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
