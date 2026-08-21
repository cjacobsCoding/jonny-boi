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
import { getCardDefinition, type UnsupportedClause } from '@jonny-boi/cards';
import type { NormalizedCard } from '@jonny-boi/data-tools/pure';

/**
 * One imported card: what to show, and — when the engine can play it — what to
 * play.
 *
 * `definition` is deliberately OPTIONAL. A deck is a list of cards, and a
 * decklist the user pasted is a real deck whether or not our rules engine has
 * caught up with every card in it. Dropping the cards we cannot yet play would
 * hand back a 47-card husk of the deck they asked for. So we keep the card, show
 * it everywhere a card is shown, and record in {@link missing} exactly which
 * engine systems its text needs.
 *
 * The honesty line moves from IMPORT to SIMULATION: a card with no `definition`
 * never reaches `importedDefinitions()`, so it can never sneak into a sim and
 * skew an A/B verdict — the Lab refuses the deck by name instead.
 */
export interface ImportedCard {
  readonly card: NormalizedCard;
  /** The engine definition. Present exactly when the card is playable. */
  readonly definition?: CardDefinition;
  /** Why it is not playable yet. Present exactly when `definition` is absent. */
  readonly missing?: readonly UnsupportedClause[];
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
      // A display record is the minimum an entry needs to be useful; the engine
      // definition is optional (an unsupported card is still a real card).
      if (entry?.card?.id) store.set(entry.card.id, entry);
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
 * Add cards to the store. Pass both playable cards (with a `definition`) and
 * unsupported ones (with `missing`) — the store is the set of cards the user has
 * imported, and only `importedDefinitions()` narrows that to what can be played.
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

/**
 * Every imported engine definition, for `loadCardPool({ extraCards })`.
 *
 * Unsupported cards are filtered out here — this is the chokepoint that keeps a
 * card the engine cannot faithfully play from ever entering a simulation.
 */
export function importedDefinitions(): readonly CardDefinition[] {
  ensureLoaded();
  const definitions: CardDefinition[] = [];
  for (const entry of store.values()) {
    if (entry.definition) definitions.push(entry.definition);
  }
  return definitions;
}

/**
 * Why a card cannot be played yet, or `undefined` when it is playable (or not an
 * imported card at all). Callers use this to explain a card by NAME instead of
 * leaving the user to guess which of their 60 cards is the problem.
 *
 * ⚠️ **THE CURATED POOL WINS.** This module's header promises it is "deliberately
 * additive: nothing here can shadow a curated card", and `deckHealth.ts` states
 * the same contract from the other side — but the lookup used to consult only
 * this store, so a card that is BOTH imported and curated was judged by the
 * import.
 *
 * That is not a corner case, it is the normal one: a user imports a real
 * decklist, some of those cards are already in the pool, and any that failed to
 * compile at IMPORT time were then reported unplayable forever — even though the
 * engine ships a hand-verified definition for them and plays them perfectly. It
 * was reported with a deck flagging `Thragtusk`, `Cloudshift` and
 * `Conjurer's Closet`: all three curated, all three playable, all three named as
 * broken.
 *
 * The store is also a CACHE of a compile verdict taken when the card was
 * imported, so it goes stale the moment the compiler learns a new template —
 * Cloudshift's entry still said "needs a filtered-targeting template" after the
 * rule that compiles it had shipped. Deferring to the pool fixes that for every
 * curated card; a genuinely-uncurated card still carries its import-time verdict
 * until it is re-imported.
 */
export function unsupportedReason(id: string): readonly UnsupportedClause[] | undefined {
  // Asked FIRST, and cheaply: the pool is a frozen map built at module load.
  if (getCardDefinition(id) !== undefined) return undefined;
  ensureLoaded();
  const entry = store.get(id);
  if (!entry || entry.definition) return undefined;
  return entry.missing ?? [];
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
