/**
 * React hook that fetches a card's alternate printings on demand for the
 * "change printing" picker. Serves from the TTL localStorage cache first (no
 * network on a repeat open), and only hits Scryfall on a miss — reusing the
 * shared rate-limit + User-Agent etiquette via {@link ProxyPrintsClient}. One
 * card's picker is open at a time, so the hook tracks a single active lookup.
 */

import { useCallback, useRef, useState } from 'react';
import { getCachedPrints, putCachedPrints } from './cache.js';
import { ProxyPrintsClient, type PrintOption } from './prints.js';
import type { FetchLike } from './scryfall.js';

/** Status of a printings lookup. */
export type PrintsStatus = 'idle' | 'loading' | 'done' | 'error';

/** State the hook exposes to the override panel. */
export interface PrintsState {
  /** The card name currently loaded/loading, if any. */
  activeName: string | null;
  status: PrintsStatus;
  prints: PrintOption[];
  /** Fetch printings for a card (cache-first); pass the same name again to close. */
  load: (name: string) => Promise<void>;
  /** Close the picker (clear the active lookup). */
  clear: () => void;
}

/** Adapt the browser `fetch` to the client's {@link FetchLike} seam. */
const browserFetch: FetchLike = (url, init) => fetch(url, init);

export function usePrints(): PrintsState {
  const [activeName, setActiveName] = useState<string | null>(null);
  const [status, setStatus] = useState<PrintsStatus>('idle');
  const [prints, setPrints] = useState<PrintOption[]>([]);
  const clientRef = useRef<ProxyPrintsClient | null>(null);
  // Guards a stale fetch from overwriting a newer selection's results.
  const loadIdRef = useRef(0);

  const clear = useCallback(() => {
    loadIdRef.current += 1;
    setActiveName(null);
    setStatus('idle');
    setPrints([]);
  }, []);

  const load = useCallback(async (name: string) => {
    const loadId = (loadIdRef.current += 1);
    setActiveName(name);
    setPrints([]);

    // Cache-first: a warm printings list opens instantly with no network.
    const cached = getCachedPrints(name);
    if (cached) {
      setPrints(cached);
      setStatus('done');
      return;
    }

    setStatus('loading');
    try {
      if (!clientRef.current) clientRef.current = new ProxyPrintsClient(browserFetch);
      const result = await clientRef.current.fetchPrints(name);
      if (loadIdRef.current !== loadId) return; // Superseded by a newer open.
      if (result.length > 0) putCachedPrints(name, result);
      setPrints(result);
      setStatus('done');
    } catch {
      if (loadIdRef.current !== loadId) return;
      setStatus('error');
    }
  }, []);

  return { activeName, status, prints, load, clear };
}
