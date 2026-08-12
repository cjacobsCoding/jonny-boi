/**
 * React hook that resolves a parsed decklist to print images via Scryfall,
 * transparently serving from (and populating) the localStorage cache so tweaks
 * don't re-fetch. Owns the network side-effects; the pure resolve/cache/paginate
 * logic it composes is tested separately.
 */

import { useCallback, useRef, useState } from 'react';
import { getResolved, loadCache, putResolved, saveCache } from './cache.js';
import { ProxyScryfallClient, type FetchLike, type ResolvedProxyCard } from './scryfall.js';
import type { ParsedCard } from './parseDecklist.js';
import { normalizeName } from './scryfall.js';

/** Status of a resolve pass. */
export type ResolveStatus = 'idle' | 'resolving' | 'done' | 'error';

/** State the hook exposes to the view. */
export interface ProxyResolverState {
  status: ResolveStatus;
  resolved: ResolvedProxyCard[];
  unresolved: string[];
  /** A top-level error message (only set when the whole pass failed). */
  error: string | null;
  /** Kick off resolution for the given parsed cards. */
  resolve: (cards: readonly ParsedCard[]) => Promise<void>;
  /** Clear the current results (not the cache). */
  reset: () => void;
}

/** Adapt the browser `fetch` to the client's {@link FetchLike} seam. */
const browserFetch: FetchLike = (url, init) => fetch(url, init);

/**
 * Resolve a decklist to print images. Names already in the cache are served
 * without a network call; only cache-misses are batched to Scryfall, and any new
 * resolutions are written back to the cache.
 */
export function useProxyResolver(): ProxyResolverState {
  const [status, setStatus] = useState<ResolveStatus>('idle');
  const [resolved, setResolved] = useState<ResolvedProxyCard[]>([]);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // A single client instance keeps the rate-limit clock across calls.
  const clientRef = useRef<ProxyScryfallClient | null>(null);

  const resolve = useCallback(async (cards: readonly ParsedCard[]) => {
    setStatus('resolving');
    setError(null);
    setUnresolved([]);

    try {
      const cache = loadCache();

      // Split into cache hits and the names we still need to fetch.
      const cached: ResolvedProxyCard[] = [];
      const toFetch: ParsedCard[] = [];
      const seenCached = new Set<string>();
      for (const card of cards) {
        const hit = getResolved(cache, card.name);
        if (hit) {
          const key = normalizeName(card.name);
          if (!seenCached.has(key)) {
            cached.push(hit);
            seenCached.add(key);
          }
        } else {
          toFetch.push(card);
        }
      }

      let fetched: ResolvedProxyCard[] = [];
      let misses: string[] = [];
      if (toFetch.length > 0) {
        if (!clientRef.current) clientRef.current = new ProxyScryfallClient(browserFetch);
        const result = await clientRef.current.resolve(toFetch);
        fetched = result.resolved;
        misses = result.unresolved;
        if (fetched.length > 0) {
          putResolved(cache, fetched);
          saveCache(cache);
        }
      }

      setResolved([...cached, ...fetched]);
      setUnresolved(misses);
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve cards from Scryfall.');
      setStatus('error');
    }
  }, []);

  const reset = useCallback(() => {
    setStatus('idle');
    setResolved([]);
    setUnresolved([]);
    setError(null);
  }, []);

  return { status, resolved, unresolved, error, resolve, reset };
}
