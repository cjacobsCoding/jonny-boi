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
  init: { method: string; headers: Record<string, string>; body: string },
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
  // charges us per identifier, not per copy.
  const unique = new Map<string, CardIdentifier>();
  for (const identifier of identifiers) {
    const key = `${normalizeName(identifier.name)}|${identifier.set ?? ''}`;
    if (!unique.has(key)) unique.set(key, identifier);
  }
  const list = [...unique.values()];

  const cards: unknown[] = [];
  const notFound: string[] = [];
  let lastRequestAt = 0;
  let done = 0;

  for (const batch of chunk(list, batchSize)) {
    try {
      const elapsed = Date.now() - lastRequestAt;
      if (elapsed < minIntervalMs) await delay(minIntervalMs - elapsed);
      lastRequestAt = Date.now();

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
        notFound.push(...batch.map((id) => id.name));
      } else {
        const payload = (await response.json()) as CollectionResponse;
        cards.push(...(payload.data ?? []));
        for (const miss of payload.not_found ?? []) {
          if (miss.name) notFound.push(miss.name);
        }
      }
    } catch {
      notFound.push(...batch.map((id) => id.name));
    }
    done += batch.length;
    options.onProgress?.({ done, total: list.length });
  }

  return { cards, notFound };
}
