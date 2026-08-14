/**
 * The card-name vocabulary the scanner corrects OCR against.
 *
 * Scryfall publishes every card name as one small JSON array, which is exactly
 * the closed vocabulary that makes imperfect OCR usable. We fetch it once and
 * cache it locally, because a scan should not depend on the network — after the
 * first successful fetch the scanner keeps working offline, which is the whole
 * point of a PWA you take to a kitchen table.
 *
 * The cached copy is used even when stale-and-unrefreshable: an out-of-date
 * vocabulary still recognises the tens of thousands of cards printed before it,
 * which beats refusing to scan (DESIGN §1.6).
 */

import { CARD_NAMES_CATALOG_URL, CATALOG_MAX_AGE_MS, CATALOG_STORAGE_KEY } from './config.js';

/** The `fetch` surface this module needs (a bare GET). */
export type CatalogFetch = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** What we persist: the names plus when we got them. */
interface CachedCatalog {
  readonly fetchedAt: number;
  readonly names: readonly string[];
}

/** Read the cached catalog, or `null` when absent/corrupt. */
export function readCachedCatalog(now: number = Date.now()): {
  names: readonly string[];
  stale: boolean;
} | null {
  try {
    const raw = globalThis.localStorage?.getItem(CATALOG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedCatalog;
    if (!Array.isArray(parsed?.names) || parsed.names.length === 0) return null;
    return { names: parsed.names, stale: now - (parsed.fetchedAt ?? 0) > CATALOG_MAX_AGE_MS };
  } catch {
    return null;
  }
}

/** Persist a freshly fetched catalog; a storage failure is not fatal. */
function writeCachedCatalog(names: readonly string[], now: number): void {
  try {
    const payload: CachedCatalog = { fetchedAt: now, names };
    globalThis.localStorage?.setItem(CATALOG_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota exceeded or storage disabled — the in-memory names still work.
  }
}

/**
 * Get the card-name vocabulary: a fresh cached copy if we have one, otherwise a
 * download, otherwise whatever stale copy we hold. Throws only when there is no
 * cache AND the download fails, which the UI reports as "connect once to enable
 * scanning".
 */
export async function loadCardNames(
  fetchImpl: CatalogFetch,
  now: number = Date.now(),
): Promise<readonly string[]> {
  const cached = readCachedCatalog(now);
  if (cached && !cached.stale) return cached.names;

  try {
    const response = await fetchImpl(CARD_NAMES_CATALOG_URL, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Scryfall returned HTTP ${response.status}`);
    const payload = (await response.json()) as { data?: unknown };
    const names = Array.isArray(payload.data)
      ? payload.data.filter((name): name is string => typeof name === 'string')
      : [];
    if (names.length === 0) throw new Error('the card-name catalog came back empty');
    writeCachedCatalog(names, now);
    return names;
  } catch (error) {
    // A stale vocabulary is far better than none — it still knows every card
    // printed before it was cached.
    if (cached) return cached.names;
    throw error instanceof Error ? error : new Error('could not load the card-name catalog');
  }
}
