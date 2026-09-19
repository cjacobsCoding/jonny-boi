/**
 * THE BROWSE INDEX — every card Scryfall knows that the engine does not yet
 * play, loaded on demand and held beside the bundled pool.
 *
 * "Add all the cards from Scryfall, regardless of whether we have mechanics for
 * them yet." The bundled `card-index.json` is the PLAYABLE pool (~7k, statically
 * imported, precached). This module adds THE REST (~25k, `public/data/
 * browse-index.json`, packed — see `data-tools/src/browse-record.ts`) so the
 * card browser and the deck builder offer everything, while the support gate
 * (§3.158, `decklist/deckHealth.ts`) keeps a deck holding any of them from being
 * played or simulated, by name and with the reason.
 *
 * ## Why it is fetched, not imported
 *
 * 9.3 MB raw / 2.4 MB gzipped is fine to download once and keep, and wrong to
 * put in front of the app shell on every cold start: Play never needs it. So it
 * is a static asset the service worker caches AFTER the first fetch
 * (`StaleWhileRevalidate` in `vite.config.ts`), requested when the app is idle
 * and again on demand by any view that wants it. Until it arrives — or if it
 * never does, offline before the first load — the app is exactly the app it was:
 * the bundled pool, and a status line saying what is missing and why. A
 * fallback that fired without saying so would be a catalogue that looks
 * complete and is not.
 *
 * ## One store, one subscription
 *
 * The three lookups in `lib/cards.ts` (`getCard`, `getCardByName`,
 * `allAvailableCards`) read this store the way they read the import store, with
 * the same precedence: bundled → imported → browse. Views subscribe to
 * {@link subscribeToBrowseIndex} (or, better, to the combined card-pool signal
 * in `cards.ts`) and re-derive their lists when the status changes.
 */
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { unpackBrowseRecord, type BrowseRecord } from '@jonny-boi/data-tools/pure';
import { normalizeName } from '../scryfall/collection.js';
import { BROWSE_INDEX_CONFIG } from '../config.js';

/** Where the loader stands. `failed` carries a human sentence, never a stack. */
export type BrowseIndexStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly cards: number; readonly corpusCards: number }
  | { readonly kind: 'failed'; readonly reason: string };

/** The file's shape on the wire — the generator's `BrowseIndexFile`, read structurally. */
interface BrowseIndexFile {
  readonly attribution?: string;
  readonly generated?: { readonly corpusCards?: number; readonly browseCards?: number };
  readonly cards: readonly BrowseRecord[];
}

let status: BrowseIndexStatus = { kind: 'idle' };
let cards: readonly NormalizedCard[] = [];
let byId: ReadonlyMap<string, NormalizedCard> = new Map();
let byName: ReadonlyMap<string, NormalizedCard> = new Map();
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function setStatus(next: BrowseIndexStatus): void {
  status = next;
  notify();
}

/** Subscribe to status changes (the `useSyncExternalStore` contract). */
export function subscribeToBrowseIndex(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current status — a stable object between changes, so it works as a store snapshot. */
export function browseIndexStatus(): BrowseIndexStatus {
  return status;
}

/** Every browse card, unpacked, name-sorted (the generator's order). Empty until `ready`. */
export function browseCards(): readonly NormalizedCard[] {
  return cards;
}

export function browseCardById(id: string): NormalizedCard | undefined {
  return byId.get(id);
}

/** By normalized name — the same key `lib/cards.ts` uses for the bundled pool. */
export function browseCardByName(name: string): NormalizedCard | undefined {
  return byName.get(normalizeName(name));
}

/** The URL the index is served from, under the app's deploy base. */
export function browseIndexUrl(): string {
  return `${import.meta.env.BASE_URL}${BROWSE_INDEX_CONFIG.path}`;
}

/**
 * Load the index if it has not been loaded (or is not loading) already.
 * Idempotent and safe to call from every view that wants the catalogue: one
 * fetch, one unpack, however many callers. A failure is recorded as `failed`
 * with a reason and can be retried by calling again.
 */
export function ensureBrowseIndex(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (status.kind === 'ready') return Promise.resolve();
  if (inFlight) return inFlight;
  setStatus({ kind: 'loading' });
  inFlight = (async () => {
    try {
      const response = await fetchImpl(browseIndexUrl());
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const file = (await response.json()) as BrowseIndexFile;
      install(file);
    } catch (error) {
      cards = [];
      byId = new Map();
      byName = new Map();
      const detail = error instanceof Error ? error.message : String(error);
      setStatus({
        kind: 'failed',
        reason:
          typeof navigator !== 'undefined' && navigator.onLine === false
            ? 'You are offline and the full catalogue has not been downloaded on this device yet.'
            : `The full catalogue could not be loaded (${detail}).`,
      });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Take a parsed file as the index. Exported for tests, which must not fetch. */
export function install(file: BrowseIndexFile): void {
  const unpacked = file.cards.map(unpackBrowseRecord);
  const idMap = new Map<string, NormalizedCard>();
  const nameMap = new Map<string, NormalizedCard>();
  for (const card of unpacked) {
    idMap.set(card.id, card);
    const key = normalizeName(card.name);
    if (!nameMap.has(key)) nameMap.set(key, card);
  }
  cards = unpacked;
  byId = idMap;
  byName = nameMap;
  setStatus({
    kind: 'ready',
    cards: unpacked.length,
    corpusCards: file.generated?.corpusCards ?? unpacked.length,
  });
}

/** Forget everything — for tests. */
export function resetBrowseIndex(): void {
  cards = [];
  byId = new Map();
  byName = new Map();
  inFlight = null;
  setStatus({ kind: 'idle' });
}

/**
 * The status as one sentence for a status line, or `undefined` when there is
 * nothing to say (idle before anyone asked; ready is shown as a count elsewhere).
 */
export function describeBrowseIndex(current: BrowseIndexStatus = status): string | undefined {
  switch (current.kind) {
    case 'loading':
      return 'Loading the full card catalogue…';
    case 'failed':
      return `${current.reason} Showing the playable pool only.`;
    case 'ready':
    case 'idle':
      return undefined;
  }
}
