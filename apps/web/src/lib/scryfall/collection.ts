/**
 * A batched, rate-limited Scryfall **card fetcher** that returns full card
 * objects.
 *
 * The Proxies feature already talks to Scryfall, but it only needs image URLs.
 * Deck import needs the *whole* card — mana cost, type line, Oracle text, P/T,
 * keywords — because those are what the Oracle compiler turns into a real engine
 * definition. This module is that lower-level fetch: identifiers in, raw cards
 * out, with Scryfall's etiquette honored (a descriptive User-Agent, a ≥100 ms
 * request floor, and ≤75 identifiers per `/cards/collection` call).
 *
 * `fetch` is injected as {@link FetchLike}, so the batching, throttling and
 * miss-reporting are all unit-testable with no live network (CLAUDE.md:
 * pure-core + mandatory tests).
 */

import {
  COLLECTION_BATCH_SIZE,
  MIN_REQUEST_INTERVAL_MS,
  SCRYFALL_API_BASE,
  SCRYFALL_COLLECTION_PATH,
  SCRYFALL_USER_AGENT,
} from '../proxy/config.js';

/** A minimal structural subset of the global `fetch` we depend on. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** One card identifier for the collection endpoint. */
export interface CardIdentifier {
  readonly name: string;
  /** Optional set code, to pin a specific printing. */
  readonly set?: string;
}

/** What a collection fetch produced. */
export interface CollectionResult {
  /** Raw Scryfall card objects, in no guaranteed order. */
  readonly cards: readonly unknown[];
  /** Names Scryfall could not find, verbatim as requested. */
  readonly notFound: readonly string[];
  /**
   * Cards that only matched under a different name, as
   * `normalized requested name → the card's canonical Scryfall name`. Callers
   * index results by card name, so they need this to tie the card back to the
   * line the user typed (see {@link recoverAlternateNames}).
   */
  readonly aliases: ReadonlyMap<string, string>;
}

/** Progress reporting while a large list resolves (one call per batch). */
export interface CollectionProgress {
  readonly done: number;
  readonly total: number;
}

/** Options for {@link fetchCardCollection}. */
export interface FetchCollectionOptions {
  readonly minIntervalMs?: number;
  readonly batchSize?: number;
  readonly onProgress?: (progress: CollectionProgress) => void;
}

/** Shape of Scryfall's `/cards/collection` response we read. */
interface CollectionResponse {
  data?: unknown[];
  not_found?: Array<{ name?: string }>;
}

/** Delay helper for the rate-limit floor. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split an array into chunks of at most `size`. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Normalize a name for de-duplication (case- and space-insensitive). */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** How exporters join the two halves of a split / double-faced / adventure card. */
const FACE_SEPARATOR = ' // ';

/**
 * The name to actually ask Scryfall for.
 *
 * `/cards/collection` matches a **face** name, unlike `/cards/named`, which also
 * accepts the combined one: asking the collection endpoint for "Wear // Tear"
 * comes back as a miss, while "Wear" returns the whole card. Exporters write
 * both forms (Arena writes the front face, Moxfield and MTGO often write the
 * pair), so we always query the front face and map the answer back to whatever
 * the user typed.
 */
export function collectionQueryName(name: string): string {
  const front = name.split(FACE_SEPARATOR)[0]?.trim();
  return front && front.length > 0 ? front : name.trim();
}

/** Scryfall's search endpoint, used only for the second-chance lookup below. */
const SCRYFALL_SEARCH_PATH = '/cards/search';

/** Shape of Scryfall's `/cards/search` response we read. */
interface SearchResponse {
  data?: Array<{ name?: string }>;
}

/**
 * Second-chance lookup for names `/cards/collection` could not match.
 *
 * A Universes Beyond printing carries its Magic-universe name in `printed_name`
 * while Scryfall files the card under the licensed one, so a decklist line
 * reading "Kavaero, Mind-Bitten" has to end up at "Superior Spider-Man". The
 * collection endpoint never matches those names; search does, but only with
 * `include_multilingual` (the same field also carries non-English printings).
 *
 * The query is anchored with Scryfall's `!"…"` exact-name operator, so this
 * recovers alternate *names* without degrading into fuzzy matching that could
 * silently import the wrong card for a typo.
 *
 * Costs one request per miss, so a list that resolves cleanly pays nothing.
 */
async function recoverAlternateNames(
  missing: readonly string[],
  fetchImpl: FetchLike,
  throttle: () => Promise<void>,
): Promise<{ cards: unknown[]; aliases: Map<string, string>; stillMissing: string[] }> {
  const cards: unknown[] = [];
  const aliases = new Map<string, string>();
  const stillMissing: string[] = [];

  for (const name of missing) {
    try {
      await throttle();
      const query = encodeURIComponent(`!"${name.replace(/"/g, '')}"`);
      const response = await fetchImpl(
        `${SCRYFALL_API_BASE}${SCRYFALL_SEARCH_PATH}?include_multilingual=true&unique=cards&q=${query}`,
        { method: 'GET', headers: { 'User-Agent': SCRYFALL_USER_AGENT, Accept: 'application/json' } },
      );
      if (!response.ok) {
        stillMissing.push(name);
        continue;
      }
      const payload = (await response.json()) as SearchResponse;
      const card = payload.data?.[0];
      if (!card?.name) {
        stillMissing.push(name);
        continue;
      }
      cards.push(card);
      aliases.set(normalizeName(name), card.name);
    } catch {
      stillMissing.push(name);
    }
  }

  return { cards, aliases, stillMissing };
}

/**
 * Fetch full card objects for the given identifiers.
 *
 * Robust by design: a failed batch records its names as not-found and the run
 * continues, so one bad request never costs you the rest of a 60-card list
 * (DESIGN §1.6). Never throws.
 */
export async function fetchCardCollection(
  identifiers: readonly CardIdentifier[],
  fetchImpl: FetchLike,
  options: FetchCollectionOptions = {},
): Promise<CollectionResult> {
  const minIntervalMs = options.minIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
  const batchSize = options.batchSize ?? COLLECTION_BATCH_SIZE;

  // De-duplicate: a decklist repeats a name once per stack, and the endpoint
  // charges us per identifier, not per copy. Keying on the *queried* name also
  // collapses "Wear" and "Wear // Tear" into the single request they are.
  const unique = new Map<string, CardIdentifier>();
  /** Queried name → the name the user actually typed, for miss reporting. */
  const requestedAs = new Map<string, string>();
  for (const identifier of identifiers) {
    const queryName = collectionQueryName(identifier.name);
    const key = `${normalizeName(queryName)}|${identifier.set ?? ''}`;
    if (unique.has(key)) continue;
    unique.set(key, identifier.set ? { name: queryName, set: identifier.set } : { name: queryName });
    requestedAs.set(normalizeName(queryName), identifier.name);
  }
  const list = [...unique.values()];
  /** Report a miss under the user's own wording, not our rewritten query. */
  const asRequested = (name: string): string => requestedAs.get(normalizeName(name)) ?? name;

  const cards: unknown[] = [];
  const notFound: string[] = [];
  let lastRequestAt = 0;
  let done = 0;

  /** Hold Scryfall's minimum request interval across every call we make. */
  const throttle = async (): Promise<void> => {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < minIntervalMs) await delay(minIntervalMs - elapsed);
    lastRequestAt = Date.now();
  };

  for (const batch of chunk(list, batchSize)) {
    try {
      await throttle();

      const response = await fetchImpl(`${SCRYFALL_API_BASE}${SCRYFALL_COLLECTION_PATH}`, {
        method: 'POST',
        headers: {
          'User-Agent': SCRYFALL_USER_AGENT,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          identifiers: batch.map((id) => (id.set ? { name: id.name, set: id.set } : { name: id.name })),
        }),
      });

      if (!response.ok) {
        notFound.push(...batch.map((id) => asRequested(id.name)));
      } else {
        const payload = (await response.json()) as CollectionResponse;
        cards.push(...(payload.data ?? []));
        for (const miss of payload.not_found ?? []) {
          if (miss.name) notFound.push(asRequested(miss.name));
        }
      }
    } catch {
      notFound.push(...batch.map((id) => asRequested(id.name)));
    }
    done += batch.length;
    options.onProgress?.({ done, total: list.length });
  }

  if (notFound.length === 0) return { cards, notFound, aliases: new Map() };

  // Anything still missing may be a card Scryfall files under another name.
  const recovered = await recoverAlternateNames(notFound, fetchImpl, throttle);
  cards.push(...recovered.cards);
  return { cards, notFound: recovered.stillMissing, aliases: recovered.aliases };
}
