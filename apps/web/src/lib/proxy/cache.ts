/**
 * localStorage-backed cache of resolved cards (name → best print image), so that
 * tweaking options or re-rendering a decklist doesn't re-hit Scryfall. Respecting
 * their etiquette: cache results, don't hammer the API.
 *
 * The cache stores only resolved image URLs keyed by normalized name — small,
 * durable, and safe to serve stale (Scryfall image URLs are stable). All access
 * is defensive: a corrupt or unavailable store degrades to an empty cache rather
 * than throwing.
 */

import {
  PROXY_CACHE_STORAGE_KEY,
  PROXY_PRINTS_CACHE_STORAGE_KEY,
  PRINTS_CACHE_TTL_MS,
} from './config.js';
import { nameAliases, normalizeName, type ResolvedProxyCard } from './scryfall.js';
import type { PrintOption } from './prints.js';

/** In-memory view of the persisted cache: normalized name → resolved card. */
export type ProxyCache = Map<string, ResolvedProxyCard>;

/** Load the resolved-card cache from localStorage (empty on any failure). */
export function loadCache(): ProxyCache {
  const cache: ProxyCache = new Map();
  try {
    const raw = globalThis.localStorage?.getItem(PROXY_CACHE_STORAGE_KEY);
    if (!raw) return cache;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return cache;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value && typeof value === 'object' && typeof (value as ResolvedProxyCard).imageUrl === 'string') {
        cache.set(key, value as ResolvedProxyCard);
      }
    }
  } catch {
    // Corrupt store → start clean rather than crash.
  }
  return cache;
}

/** Persist the cache to localStorage (best-effort; ignores quota/serialize errors). */
export function saveCache(cache: ProxyCache): void {
  try {
    const obj: Record<string, ResolvedProxyCard> = {};
    for (const [key, value] of cache) obj[key] = value;
    globalThis.localStorage?.setItem(PROXY_CACHE_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // Non-fatal: caching is an optimization, not a correctness requirement.
  }
}

/**
 * Add resolved cards to the cache under every name they answer to — the
 * combined "Front // Back" name and each face — so a decklist that writes a
 * double-faced card by its front face is a cache HIT rather than a re-fetch.
 */
export function putResolved(cache: ProxyCache, resolved: readonly ResolvedProxyCard[]): void {
  for (const card of resolved) {
    for (const alias of nameAliases(card.name)) cache.set(alias, card);
  }
}

/** Look up a resolved card by (raw) name. */
export function getResolved(cache: ProxyCache, name: string): ResolvedProxyCard | undefined {
  return cache.get(normalizeName(name));
}

/* -------------------------------------------------------------------------- */
/* Prints cache — alternate-printings lists, with a freshness TTL.            */
/* -------------------------------------------------------------------------- */

/** A cached printings list plus the epoch-ms it was fetched (for TTL checks). */
interface CachedPrints {
  fetchedAt: number;
  prints: PrintOption[];
}

/**
 * Read a card's cached printings list, or `undefined` when absent, malformed,
 * or older than {@link PRINTS_CACHE_TTL_MS}. Same defensive pattern as the
 * resolved-card cache: any failure degrades to a miss (we'll just re-fetch).
 */
export function getCachedPrints(name: string): PrintOption[] | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(PROXY_PRINTS_CACHE_STORAGE_KEY);
    if (!raw) return undefined;
    const store = JSON.parse(raw) as Record<string, CachedPrints>;
    const entry = store?.[normalizeName(name)];
    if (!entry || !Array.isArray(entry.prints)) return undefined;
    if (Date.now() - entry.fetchedAt > PRINTS_CACHE_TTL_MS) return undefined;
    return entry.prints;
  } catch {
    return undefined;
  }
}

/** Persist a card's printings list under its normalized name (best-effort). */
export function putCachedPrints(name: string, prints: PrintOption[]): void {
  try {
    const raw = globalThis.localStorage?.getItem(PROXY_PRINTS_CACHE_STORAGE_KEY);
    const store: Record<string, CachedPrints> =
      raw ? (JSON.parse(raw) as Record<string, CachedPrints>) : {};
    store[normalizeName(name)] = { fetchedAt: Date.now(), prints };
    globalThis.localStorage?.setItem(
      PROXY_PRINTS_CACHE_STORAGE_KEY,
      JSON.stringify(store),
    );
  } catch {
    // Non-fatal: prints caching is an etiquette optimization, not correctness.
  }
}
