/**
 * Single-card Scryfall lookup — "add THIS card", by name, with the guessing done
 * for you.
 *
 * Deck import resolves whole lists through `/cards/collection`, which matches
 * names EXACTLY. That is right for a decklist (60 lines, no guessing wanted) and
 * wrong for a human typing one card: nobody remembers whether it is "Lightning
 * Bolt" or "Lightning bolt", and nobody wants to type "Solemn Simulacrum" without
 * a typo. So this uses Scryfall's FUZZY endpoint, which is built for exactly this
 * — it tolerates misspellings, partial names, and wrong case, and answers with
 * the one card it is confident you meant.
 *
 * Two failure modes are distinct and are reported separately, because the user's
 * next move differs:
 *   - AMBIGUOUS — the guess matched several cards ("bolt"). We fetch the
 *     autocomplete suggestions so the UI can offer them rather than saying "no".
 *   - NOT FOUND — no card is close enough. Usually a real typo.
 *
 * Pure and injectable: the caller passes `fetch`, so every path here is tested
 * against stub responses with no network (DESIGN §2.1).
 */

import {
  MIN_REQUEST_INTERVAL_MS,
  SCRYFALL_API_BASE,
  SCRYFALL_USER_AGENT,
} from '../proxy/config.js';
import type { FetchLike } from './collection.js';

/** Scryfall's fuzzy single-card endpoint. */
const NAMED_PATH = '/cards/named';
/** Scryfall's name-completion endpoint, used to explain an ambiguous guess. */
const AUTOCOMPLETE_PATH = '/cards/autocomplete';

/**
 * How many suggestions to keep when a guess is ambiguous. Scryfall returns up to
 * 20; a short list is a usable prompt, a long one is a wall of text.
 */
export const MAX_NAME_SUGGESTIONS = 8;

/** The outcome of looking up one card by name. */
export type NamedLookup =
  | { readonly kind: 'found'; readonly card: unknown }
  /** Several cards match; `suggestions` are real card names to choose from. */
  | { readonly kind: 'ambiguous'; readonly suggestions: readonly string[] }
  | { readonly kind: 'notFound'; readonly query: string }
  /** The request itself failed (offline, rate-limited, 5xx). Worth retrying. */
  | { readonly kind: 'error'; readonly message: string };

/** Options for {@link lookupCardByName}. */
export interface LookupOptions {
  /** Etiquette floor between requests; defaults to the shared Scryfall interval. */
  readonly minIntervalMs?: number;
}

function headers(): Record<string, string> {
  return { Accept: 'application/json', 'User-Agent': SCRYFALL_USER_AGENT };
}

/** Wait out the etiquette interval (Scryfall asks for ≤10 requests/second). */
async function pace(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask Scryfall for the names that complete `query`. Used only to turn an
 * ambiguous guess into a choice; a failure here is not fatal, it just means the
 * ambiguity is reported without suggestions.
 */
export async function suggestCardNames(
  query: string,
  fetchImpl: FetchLike,
  options: LookupOptions = {},
): Promise<readonly string[]> {
  const url = `${SCRYFALL_API_BASE}${AUTOCOMPLETE_PATH}?q=${encodeURIComponent(query)}`;
  try {
    await pace(options.minIntervalMs ?? MIN_REQUEST_INTERVAL_MS);
    const response = await fetchImpl(url, { method: 'GET', headers: headers() });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return [];
    return body.data.filter((n): n is string => typeof n === 'string').slice(0, MAX_NAME_SUGGESTIONS);
  } catch {
    return [];
  }
}

/**
 * Look up ONE card by an approximate name.
 *
 * Returns the raw Scryfall card object on success — the caller normalizes and
 * compiles it, exactly as deck import does, so an à-la-carte card goes through
 * the same fidelity screening as an imported list.
 */
export async function lookupCardByName(
  query: string,
  fetchImpl: FetchLike,
  options: LookupOptions = {},
): Promise<NamedLookup> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return { kind: 'notFound', query };

  const url = `${SCRYFALL_API_BASE}${NAMED_PATH}?fuzzy=${encodeURIComponent(trimmed)}`;
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    await pace(options.minIntervalMs ?? MIN_REQUEST_INTERVAL_MS);
    response = await fetchImpl(url, { method: 'GET', headers: headers() });
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : 'network request failed' };
  }

  if (response.ok) {
    try {
      return { kind: 'found', card: await response.json() };
    } catch {
      return { kind: 'error', message: 'Scryfall sent a response we could not read.' };
    }
  }

  // Scryfall answers BOTH "no such card" and "your guess matched several cards"
  // with 404 — the body's `details` is what distinguishes them, so we read it
  // rather than treating every 404 as a miss.
  if (response.status === 404) {
    let details = '';
    try {
      const body = (await response.json()) as { details?: unknown };
      if (typeof body.details === 'string') details = body.details;
    } catch {
      // No body to read; fall through to "not found".
    }
    if (/too many cards match|didn't match|did not match/i.test(details) && /too many/i.test(details)) {
      const suggestions = await suggestCardNames(trimmed, fetchImpl, options);
      return { kind: 'ambiguous', suggestions };
    }
    return { kind: 'notFound', query: trimmed };
  }

  return { kind: 'error', message: `Scryfall returned ${response.status}.` };
}
