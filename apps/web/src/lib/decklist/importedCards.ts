/**
 * The IMPORTED-CARD STORE — the runtime extension of the card pool.
 *
 * The app ships a small curated pool bundled into the build. Deck import adds to
 * it at runtime: every card the Oracle compiler judged complete is kept here
 * with both halves it needs to be a first-class citizen —
 *
 *   - `card`       the normalized Scryfall record the UI displays (art, cost,
 *                  type line, Oracle text);
 *   - `definition` the compiled engine definition the rules engine plays.
 *
 * Persisted to localStorage so an imported deck still works offline and after a
 * reload (the PWA promise), and deliberately additive: nothing here can shadow a
 * curated card, and clearing it only ever costs you imported cards.
 *
 * Storage is best-effort — a full or unavailable localStorage degrades to an
 * in-memory store for the session rather than breaking the import (DESIGN §1.6).
 */

import type { CardDefinition } from '@jonny-boi/core';
import type { NormalizedCard } from '@jonny-boi/data-tools/pure';

/** One imported card: what to show, and what to play. */
export interface ImportedCard {
  readonly card: NormalizedCard;
  readonly definition: CardDefinition;
}

/** localStorage key holding the imported-card map. */
const STORAGE_KEY = 'jonny-boi:imported-cards:v1';

/** In-memory index, the source of truth during a session. */
let store = new Map<string, ImportedCard>();
let loaded = false;

/** Listeners notified when the store changes (so views re-render). */
const listeners = new Set<() => void>();

/** Read the persisted store once per session; tolerate corrupt/absent data. */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed as ImportedCard[]) {
      if (entry?.card?.id && entry?.definition?.id) store.set(entry.card.id, entry);
    }
  } catch {
    // Corrupt storage: start empty rather than crash the app on boot.
    store = new Map();
  }
}

/** Persist the store; a storage failure is non-fatal for the session. */
function persist(): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...store.values()]));
  } catch {
    // Quota exceeded or storage disabled — keep the in-memory store working.
  }
}

/** Notify subscribers that the imported-card set changed. */
function emitChange(): void {
  for (const listener of listeners) listener();
}

/**
 * Add cards to the store. Only pass cards whose compile status was COMPLETE —
 * this store is the set of cards the engine can genuinely play.
 */
export function registerImportedCards(cards: readonly ImportedCard[]): void {
  ensureLoaded();
  if (cards.length === 0) return;
  for (const entry of cards) store.set(entry.card.id, entry);
  persist();
  emitChange();
}

/** Every imported display record, for the card browser and deck lists. */
export function importedCards(): readonly NormalizedCard[] {
  ensureLoaded();
  return [...store.values()].map((entry) => entry.card);
}

/** Every imported engine definition, for `loadCardPool({ extraCards })`. */
export function importedDefinitions(): readonly CardDefinition[] {
  ensureLoaded();
  return [...store.values()].map((entry) => entry.definition);
}

/** One imported card by Scryfall id. */
export function importedCard(id: string): NormalizedCard | undefined {
  ensureLoaded();
  return store.get(id)?.card;
}

/** How many cards have been imported (for the UI's pool summary). */
export function importedCardCount(): number {
  ensureLoaded();
  return store.size;
}

/** Remove every imported card (leaves the curated pool untouched). */
export function clearImportedCards(): void {
  ensureLoaded();
  store = new Map();
  persist();
  emitChange();
}

/** Subscribe to store changes; returns an unsubscribe function. */
export function subscribeToImportedCards(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
