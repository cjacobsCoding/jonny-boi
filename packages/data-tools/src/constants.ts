/**
 * Named constants for the Scryfall pipeline. Per the engineering rules
 * (DESIGN.md §1.3 — no magic numbers), every value that affects fetch behavior,
 * rate-limiting, batching, or where files land is declared here, never inline.
 */

/** Base URL for the public Scryfall REST API (no API key required). */
export const SCRYFALL_API_BASE = 'https://api.scryfall.com';

/** Collection endpoint — resolves up to {@link COLLECTION_BATCH_SIZE} cards per POST. */
export const SCRYFALL_COLLECTION_PATH = '/cards/collection';

/**
 * Scryfall caps the `/cards/collection` endpoint at 75 identifiers per request.
 * We batch our card-name list into chunks of this size.
 */
export const COLLECTION_BATCH_SIZE = 75;

/**
 * Minimum delay between outbound Scryfall requests. Scryfall's API guidelines
 * ask for ~10 requests/sec max (≥100ms apart); we honor that as a hard floor.
 */
export const MIN_REQUEST_INTERVAL_MS = 100;

/** Descriptive User-Agent per Scryfall etiquette (they reject anonymous bots). */
export const USER_AGENT = 'jonny-boi/0.1 (MTG deck-tuning lab; contact via repo)';

/** We only ever consume JSON from the API. */
export const ACCEPT_JSON = 'application/json';

/** HTTP statuses we treat as transient and retry with backoff. */
export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Max attempts (initial try + retries) for a single transient-failing request. */
export const MAX_RETRY_ATTEMPTS = 4;

/** Base backoff delay; doubles each retry (exponential backoff). */
export const RETRY_BACKOFF_BASE_MS = 250;

/**
 * Image sizes we download by default for each card:
 * - `normal`   — full card frame for the card browser.
 * - `art_crop` — tight art-only crop for compact card-art display.
 */
export const DEFAULT_IMAGE_SIZES = ['normal', 'art_crop'] as const;

/** Local (gitignored) cache directory for raw API responses + image bytes. */
export const CACHE_DIR_NAME = 'data-cache';

/** Subdirectory under the cache for raw Scryfall card JSON. */
export const RAW_CACHE_SUBDIR = 'raw';

/** Subdirectory under the cache for downloaded image files. */
export const IMAGE_CACHE_SUBDIR = 'images';

/** Committed output: the normalized card index the engine/UI consume. */
export const DATA_DIR_NAME = 'data';

/** Filename of the committed normalized card index. */
export const CARD_INDEX_FILENAME = 'card-index.json';

/** Filename of the committed curated starter card-name list. */
export const STARTER_CARD_LIST_FILENAME = 'starter-cards.json';
