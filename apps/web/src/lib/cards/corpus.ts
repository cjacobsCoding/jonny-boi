/**
 * THE CORPUS TIER (§3.167) — every card Scryfall knows that the engine pool
 * does not, so the app can show the whole of Magic and say, card by card,
 * which ones it cannot play yet.
 *
 * > "work on adding all the cards from scryfall, regardless of whether we have
 * > mechanics for them yet"
 *
 * The POOL index (`data/card-index.json`) is bundled: it is what the engine
 * plays and the shell must work offline. This tier is ~3.5× as many cards and
 * is FETCHED, once, from a content-hashed asset Vite emits from data-tools'
 * `corpus-index.json` (imported here with `?url`, so there is one copy in the
 * repo and the browser's cache key changes exactly when the data does). The
 * service worker caches it on first use (`vite.config.ts`, CacheFirst), so the
 * second visit is offline-capable; the FIRST offline visit is reported here as
 * `failed`, and the app says so rather than pretending the pool is the world.
 *
 * Every record is expanded by the same `normalizeCard` the pool went through —
 * one normalizer, one card shape (`NormalizedCard`). Expansion of 25k records
 * is chunked across macrotasks so the shell stays responsive while it runs.
 *
 * This module is a plain external store (`subscribeToCorpus` + a version), the
 * same shape as the imported-card store, so views re-render when it arrives.
 */
import { normalizeCard, type CorpusIndex, type NormalizedCard } from '@jonny-boi/data-tools/pure';
import corpusIndexUrl from '../../../../../packages/data-tools/data/corpus-index.json?url';
import { normalizeName } from '../scryfall/collection.js';

/** Where the asset lives in this build — exported so a test can assert it is hashed. */
export const CORPUS_INDEX_URL: string = corpusIndexUrl;

/** How many records to expand per macrotask before yielding to the UI. */
export const CORPUS_EXPAND_CHUNK = 2_000;

export type CorpusState =
  | { readonly state: 'idle' }
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly count: number; readonly corpusSize: number }
  | { readonly state: 'failed'; readonly error: string };

const IDLE: CorpusState = Object.freeze({ state: 'idle' });

let state: CorpusState = IDLE;
let cards: readonly NormalizedCard[] = [];
let byId: ReadonlyMap<string, NormalizedCard> = new Map();
let byName: ReadonlyMap<string, NormalizedCard> = new Map();
let version = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(next: CorpusState): void {
  state = next;
  version += 1;
  for (const listener of listeners) listener();
}

/** The loader's state — what the Cards view says while the list is on its way. */
export function corpusState(): CorpusState {
  return state;
}

/** Bumps on every state change; the `useSyncExternalStore` snapshot. */
export function corpusVersion(): number {
  return version;
}

/** The expanded corpus cards, name-sorted; empty until `ready`. */
export function corpusCards(): readonly NormalizedCard[] {
  return cards;
}

export function corpusCard(id: string): NormalizedCard | undefined {
  return byId.get(id);
}

/** By NORMALIZED name (the `normalizeName` key the rest of the app joins on). */
export function corpusCardByName(name: string): NormalizedCard | undefined {
  return byName.get(normalizeName(name));
}

export function subscribeToCorpus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A macrotask boundary, so a long expansion does not freeze the shell. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Expand the slim records into `NormalizedCard`s, chunked. Exported for the
 * test, which feeds it a small index directly.
 */
export async function expandCorpus(
  index: Pick<CorpusIndex, 'cards'>,
  chunk: number = CORPUS_EXPAND_CHUNK,
): Promise<NormalizedCard[]> {
  const out: NormalizedCard[] = [];
  for (let i = 0; i < index.cards.length; i += chunk) {
    for (const raw of index.cards.slice(i, i + chunk)) out.push(normalizeCard(raw));
    if (i + chunk < index.cards.length) await yieldToUi();
  }
  return out;
}

/**
 * Fetch and expand the corpus once. Idempotent: concurrent callers share one
 * load, and a finished load (ready OR failed) is not repeated — a failed one is
 * retried with `retryCorpus`, which is what the UI's "try again" calls.
 */
export function loadCorpus(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (inflight) return inflight;
  if (state.state === 'ready' || state.state === 'failed') return Promise.resolve();
  inflight = (async () => {
    emit({ state: 'loading' });
    try {
      const response = await fetchImpl(CORPUS_INDEX_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status} fetching the card list`);
      const index = (await response.json()) as CorpusIndex;
      if (!Array.isArray(index.cards)) throw new Error('the card list is not an index');
      const expanded = await expandCorpus(index);
      const idMap = new Map<string, NormalizedCard>();
      const nameMap = new Map<string, NormalizedCard>();
      for (const card of expanded) {
        idMap.set(card.id, card);
        const key = normalizeName(card.name);
        if (!nameMap.has(key)) nameMap.set(key, card);
      }
      cards = expanded;
      byId = idMap;
      byName = nameMap;
      emit({ state: 'ready', count: expanded.length, corpusSize: index.corpusSize });
    } catch (error) {
      emit({ state: 'failed', error: error instanceof Error ? error.message : String(error) });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Forget a failure and load again — the UI's "try again". */
export function retryCorpus(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (state.state === 'failed') emit(IDLE);
  return loadCorpus(fetchImpl);
}

/** Tests only: back to the never-loaded state. */
export function resetCorpusForTests(): void {
  state = IDLE;
  cards = [];
  byId = new Map();
  byName = new Map();
  inflight = null;
  version += 1;
}
