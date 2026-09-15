/**
 * localStorage persistence for saved decks.
 *
 * ## The bug this module was rewritten for
 *
 * `saveDecks` used to be `try { setItem } catch { console.warn }`. A deck lives
 * in React state as soon as it is imported, so a quota failure looked EXACTLY
 * like a success for the rest of the session and the deck was simply gone on the
 * next load. Caleb lost two imported decks that way and had no way to find out
 * why. Every write here now goes through `lib/persistence/write.ts`, which
 * returns a result and reports the failure to the user itself.
 *
 * The READS still degrade gracefully — corrupt or partial storage must never
 * white-screen the app (DESIGN.md §6) — with one exception, which is the other
 * half of the same defect: an unreadable deck blob is REPORTED and flagged
 * `corrupt`, because the caller's next move would otherwise be to overwrite it
 * with a fresh empty list and destroy any chance of getting it back.
 */
import type { Deck, DeckEntry } from './deck.js';
import { getCard } from './cards.js';
import { isEntryPrinting } from './printings/entryPrinting.js';
import { DECKS_STORAGE_KEY, ACTIVE_DECK_STORAGE_KEY } from './config.js';
import { reportStorageNotice, severityOf } from './persistence/failures.js';
import { removeStorage, storageLabel, writeStorage, type StorageWriteResult } from './persistence/write.js';

/** What a read of the saved decks found. */
export interface DeckReadResult {
  /** The decks that were readable. Empty is a valid answer. */
  readonly decks: Deck[];
  /**
   * True when something WAS stored and could not be parsed.
   *
   * Distinguished from "nothing stored" on purpose: the two look identical
   * (`decks: []`) and call for opposite behaviour. Nothing stored means write a
   * starter deck; corrupt means do NOT write anything over it.
   */
  readonly corrupt: boolean;
}

/** Read all saved decks, distinguishing "none saved" from "saved but unreadable". */
export function loadDecks(): DeckReadResult {
  let raw: string | null;
  try {
    raw = localStorage.getItem(DECKS_STORAGE_KEY);
  } catch {
    // No storage at all (private mode). Nothing is stored, so nothing is at risk
    // of being overwritten — this is the empty case, not the corrupt one.
    return { decks: [], corrupt: false };
  }
  if (!raw) return { decks: [], corrupt: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return corruptRead();
    // Keep only entries that look like decks; tolerate missing fields.
    return { decks: parsed.filter(isDeckLike).map(normalizeDeck), corrupt: false };
  } catch (error) {
    console.warn('Saved decks could not be parsed.', error);
    return corruptRead();
  }
}

function corruptRead(): DeckReadResult {
  reportStorageNotice({
    areaId: 'decks',
    label: storageLabel('decks'),
    reason: 'unreadable',
    severity: severityOf('unreadable'),
    chars: 0,
    at: Date.now(),
  });
  return { decks: [], corrupt: true };
}

/**
 * Persist the full deck list.
 *
 * Returns the write's result — a caller that ignores it is visible; a caller
 * that never had one was not. The user-facing notice is raised by the funnel,
 * so a new caller gets it without having to remember.
 */
export function saveDecks(decks: Deck[]): StorageWriteResult {
  return writeStorage('decks', DECKS_STORAGE_KEY, JSON.stringify(decks));
}

/** Read the id of the last-active deck, or null if none/unavailable. */
export function loadActiveDeckId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_DECK_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Persist the active deck id (or clear it when null).
 *
 * `quiet` on purpose: this is which deck the builder re-opens on. Failing to
 * store it costs the user one click, and it would otherwise raise a SECOND
 * banner next to the deck-save one it always fails alongside — burying the
 * message that actually matters under a duplicate of itself.
 */
export function saveActiveDeckId(id: string | null): StorageWriteResult | null {
  if (id === null) {
    removeStorage('active-deck', ACTIVE_DECK_STORAGE_KEY);
    return null;
  }
  return writeStorage('active-deck', ACTIVE_DECK_STORAGE_KEY, id, { quiet: true });
}

/** Loose structural check that a stored value resembles a Deck. */
function isDeckLike(value: unknown): value is Partial<Deck> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    Array.isArray((value as Record<string, unknown>).cards)
  );
}

/** Fill in any missing fields on a loaded deck with safe defaults. */
function normalizeDeck(value: Partial<Deck>): Deck {
  return {
    id: value.id ?? `deck-${Date.now().toString(36)}`,
    name: typeof value.name === 'string' && value.name.trim() ? value.name : 'Untitled Deck',
    cards: Array.isArray(value.cards) ? value.cards.flatMap(normalizeEntry) : [],
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  };
}

/**
 * Rebuild one stored entry, or drop it if it is not an entry at all.
 *
 * Rebuilt field by field rather than passed through, so what comes out of
 * storage is exactly a {@link DeckEntry} and nothing else: the old version
 * filtered the raw objects and returned them as-is, which typed away whatever
 * else was on them. A chosen printing is kept only when it is well-formed —
 * a corrupt one costs you the art, never the card.
 */
function normalizeEntry(raw: unknown): DeckEntry[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const entry = raw as Record<string, unknown>;
  if (typeof entry.cardId !== 'string' || typeof entry.count !== 'number') return [];
  const normalized: DeckEntry = { cardId: entry.cardId, count: entry.count };
  // Backfill the name from the pool on the way in, so a deck saved before
  // `DeckEntry.name` existed becomes self-describing the moment it is loaded on a
  // build that still has the card — rather than only from its next edit onward,
  // which is far too late to help the deck that has already gone stale.
  const name =
    getCard(entry.cardId)?.name ??
    (typeof entry.name === 'string' && entry.name.trim() ? entry.name : undefined);
  if (name) normalized.name = name;
  if (isEntryPrinting(entry.printing)) normalized.printing = entry.printing;
  return [normalized];
}
