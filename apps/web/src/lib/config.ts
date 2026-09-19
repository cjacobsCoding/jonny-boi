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

/**
 * localStorage key for the ledger of transcriptions already SETTLED into his
 * collection — see `decklist/paperDecks.ts`.
 *
 * ⚠️ Deliberately a key of its own rather than a field inside the decks blob.
 * The decks blob is the one thing in this origin that cannot be rebuilt, and the
 * seeding bookkeeping must not be able to make it bigger, change its shape, or
 * fail its write. Losing this key costs one no-op seeding pass; losing the decks
 * costs his decks.
 */
export const SEEDED_DECKS_STORAGE_KEY = 'jonny-boi.decks.seeded.v1';

/** Default name for a freshly-created deck. */
export const DEFAULT_DECK_NAME = 'New Deck';

/*
 * ── Web-Storage keys owned here on purpose ───────────────────────────────────
 * The four keys below used to be module-private constants next to the code that
 * wrote them. They moved here so `lib/persistence/budget.ts` — the one module
 * that knows how the origin's storage budget divides — can name every area
 * without importing the modules that do the writing, which would make the
 * budget and the write funnel import each other. Their owners import them back
 * from here, so there is still exactly one spelling of each key.
 */

/** localStorage key for cards imported from Scryfall beyond the bundled pool. */
export const IMPORTED_CARDS_STORAGE_KEY = 'jonny-boi:imported-cards:v1';

/** localStorage key for the per-browser queue of engine gaps the user has hit. */
export const UNSUPPORTED_MECHANICS_STORAGE_KEY = 'jonny-boi:unsupported-mechanics:v1';

/**
 * localStorage key PREFIX for the Lab's per-deck, per-pilot tuning memory. A
 * prefix rather than a key: one entry exists per (deck fingerprint, pilot).
 */
export const SUGGESTION_HISTORY_KEY_PREFIX = 'jonny-boi.suggest-history';

/** localStorage key for the online play server address. */
export const SERVER_URL_STORAGE_KEY = 'jb_server_url';

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
 * stalling boot with a multi-second parse+replay.
 *
 * ⚠️ This is the READ ceiling ONLY. The WRITE cap is this area's share of the
 * origin budget in `lib/persistence/budget.ts`, and it is much smaller. The two
 * are deliberately different: a read ceiling lowered to the write budget would
 * make the first load after a budget cut report already-stored data as corrupt
 * and throw it away, which is the exact failure the budget exists to prevent.
 * Writes shed down to the budget; reads accept what is already on disk.
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
 *
 * ⚠️ MOVED. This is now DERIVED from the storage budget by
 * `lib/persistence/budget.ts#historyGameLimit`, because a hard-coded 50 here and
 * a character cap over there were two places answering one question — and they
 * disagreed by a factor of four. Import the function, not a literal.
 */

/**
 * The library's READ ceiling — refuse to decode a blob larger than this.
 *
 * ⚠️ This is no longer the write cap, and the comment that said it was is the
 * reason it is spelled out at length here. Four million characters exceeds the
 * ENTIRE localStorage quota on Safari and several mobile WebViews, so the game
 * library was permitted to starve the saved decks, the in-progress game and the
 * printing caches it shares an origin with — and it did. The write cap is now
 * this area's share of one owned budget in `lib/persistence/budget.ts`. The
 * ceiling stays large so a library written before that change still loads.
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

/**
 * The whole-Scryfall BROWSE index — every card the engine does not yet play,
 * packed (see `data-tools/src/browse-record.ts`) and served as a static asset
 * rather than bundled: 9.3 MB raw / 2.4 MB gzipped is a thing to fetch once and
 * cache, not to put in front of the app shell. `lib/cards/browseIndex.ts` loads
 * it; `vite.config.ts` keeps it out of the precache and caches it at runtime.
 */
export const BROWSE_INDEX_CONFIG = Object.freeze({
  /** Path under the deploy base. The generator writes `apps/web/public/data/browse-index.json`. */
  path: 'data/browse-index.json',
  /** How long after first paint the app starts fetching it on its own (idle work, never on the critical path). */
  idlePrefetchDelayMs: 4_000,
});
