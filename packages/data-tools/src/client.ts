/**
 * Typed Scryfall client. The actual `fetch` is isolated behind a small
 * injectable {@link HttpClient} interface so the batching / rate-limiting /
 * retry logic is unit-testable WITHOUT touching the network.
 */

import {
  ACCEPT_JSON,
  COLLECTION_BATCH_SIZE,
  MAX_RETRY_ATTEMPTS,
  MIN_REQUEST_INTERVAL_MS,
  RETRY_BACKOFF_BASE_MS,
  RETRYABLE_STATUS,
  SCRYFALL_API_BASE,
  SCRYFALL_COLLECTION_PATH,
  USER_AGENT,
} from './constants.js';
import type { FetchResult, RawScryfallCard } from './types.js';

/** A minimal, injectable HTTP response (a structural subset of `fetch`'s). */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Minimal request options the client passes through. */
export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * The single seam between this package and the outside world. The real
 * implementation wraps global `fetch`; tests inject a mock so the suite is
 * offline and deterministic.
 */
export interface HttpClient {
  request(url: string, options?: HttpRequest): Promise<HttpResponse>;
}

/** Pause for `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A response from Scryfall's collection endpoint. */
interface CollectionResponse {
  data?: RawScryfallCard[];
  not_found?: Array<{ name?: string }>;
}

/** Identifier shape we POST to the collection endpoint. */
interface NameIdentifier {
  name: string;
}

/**
 * The default {@link HttpClient}, wrapping global `fetch`. Kept thin: it only
 * adapts the response shape — all policy (headers, retry, rate limit) lives in
 * {@link ScryfallClient}.
 */
export function createFetchHttpClient(): HttpClient {
  return {
    async request(url, options) {
      const response = await fetch(url, options);
      return {
        ok: response.ok,
        status: response.status,
        json: () => response.json() as Promise<unknown>,
        arrayBuffer: () => response.arrayBuffer(),
      };
    },
  };
}

/** Split an array into chunks of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunk size must be positive, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * The Scryfall client. Enforces Scryfall etiquette (User-Agent, ≥100ms between
 * requests), batches name lookups through the bulk collection endpoint, and
 * retries transient (429/5xx) failures with exponential backoff.
 */
export class ScryfallClient {
  private readonly http: HttpClient;
  private readonly minIntervalMs: number;
  private readonly batchSize: number;
  /** Wall-clock time of the last outbound request, for rate-limiting. */
  private lastRequestAt = 0;

  constructor(
    http: HttpClient,
    options: { minIntervalMs?: number; batchSize?: number } = {},
  ) {
    this.http = http;
    this.minIntervalMs = options.minIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
    this.batchSize = options.batchSize ?? COLLECTION_BATCH_SIZE;
  }

  /** Block until at least `minIntervalMs` has elapsed since the last request. */
  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minIntervalMs) {
      await delay(this.minIntervalMs - elapsed);
    }
    this.lastRequestAt = Date.now();
  }

  /**
   * Perform a single rate-limited, retrying request. Retries only on transient
   * statuses ({@link RETRYABLE_STATUS}) and thrown network errors; a 404 (e.g.
   * a genuine miss) is returned to the caller, not retried.
   */
  private async send(url: string, options?: HttpRequest): Promise<HttpResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
      await this.throttle();
      try {
        const response = await this.http.request(url, options);
        if (response.ok || !RETRYABLE_STATUS.has(response.status)) {
          return response;
        }
        lastError = new Error(`Scryfall responded ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      // Exponential backoff before the next attempt (if any remain).
      if (attempt < MAX_RETRY_ATTEMPTS - 1) {
        await delay(RETRY_BACKOFF_BASE_MS * 2 ** attempt);
      }
    }
    throw lastError ?? new Error(`Request to ${url} failed after retries`);
  }

  /** Build the headers Scryfall etiquette requires on every request. */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'User-Agent': USER_AGENT, Accept: ACCEPT_JSON, ...extra };
  }

  /**
   * Resolve a list of card names to raw Scryfall card objects. Batches names
   * into ≤{@link COLLECTION_BATCH_SIZE} per request via the collection
   * endpoint, deduplicates, and collects names Scryfall couldn't find.
   *
   * Never throws on a partial failure: a batch that errors out is logged and
   * its names recorded as unresolved so the run continues.
   */
  async fetchCardsByNames(names: readonly string[]): Promise<FetchResult> {
    const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    const cards: RawScryfallCard[] = [];
    const unresolved: string[] = [];

    for (const batch of chunk(unique, this.batchSize)) {
      const identifiers: NameIdentifier[] = batch.map((name) => ({ name }));
      try {
        const response = await this.send(`${SCRYFALL_API_BASE}${SCRYFALL_COLLECTION_PATH}`, {
          method: 'POST',
          headers: this.headers({ 'Content-Type': ACCEPT_JSON }),
          body: JSON.stringify({ identifiers }),
        });
        if (!response.ok) {
          // Whole batch failed (and exhausted retries) — record + continue.
          unresolved.push(...batch);
          console.warn(`[scryfall] batch failed (HTTP ${response.status}); ${batch.length} names unresolved`);
          continue;
        }
        const payload = (await response.json()) as CollectionResponse;
        cards.push(...(payload.data ?? []));
        for (const miss of payload.not_found ?? []) {
          if (miss.name) unresolved.push(miss.name);
        }
      } catch (error) {
        unresolved.push(...batch);
        console.warn(`[scryfall] batch threw; ${batch.length} names unresolved:`, error);
      }
    }

    return { cards, unresolved };
  }

  /**
   * Download raw image bytes from a (Scryfall-hosted) URL, rate-limited and
   * retrying. Returns the bytes, or `null` on a non-ok / failed response so the
   * caller can skip that image without aborting the whole download pass.
   */
  async fetchImageBytes(url: string): Promise<Uint8Array | null> {
    try {
      const response = await this.send(url, { headers: this.headers() });
      if (!response.ok) {
        console.warn(`[scryfall] image fetch ${url} → HTTP ${response.status}`);
        return null;
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      console.warn(`[scryfall] image fetch ${url} failed:`, error);
      return null;
    }
  }
}
