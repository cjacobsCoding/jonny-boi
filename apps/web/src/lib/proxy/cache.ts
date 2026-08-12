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

import { PROXY_CACHE_STORAGE_KEY } from './config.js';
import { normalizeName, type ResolvedProxyCard } from './scryfall.js';

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

/** Add resolved cards to the cache under their normalized names. */
export function putResolved(cache: ProxyCache, resolved: readonly ResolvedProxyCard[]): void {
  for (const card of resolved) cache.set(normalizeName(card.name), card);
}

/** Look up a resolved card by (raw) name. */
export function getResolved(cache: ProxyCache, name: string): ResolvedProxyCard | undefined {
  return cache.get(normalizeName(name));
}
