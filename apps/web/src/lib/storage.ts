/**
 * localStorage persistence for saved decks. Data-driven and resilient: corrupt
 * or partial storage never white-screens the app — it logs a warning and falls
 * back to an empty deck set (DESIGN.md §6: graceful fallbacks).
 */
import type { Deck, DeckEntry } from './deck.js';
import { isEntryPrinting } from './printings/entryPrinting.js';
import { DECKS_STORAGE_KEY, ACTIVE_DECK_STORAGE_KEY } from './config.js';

/** Read all saved decks from localStorage, recovering gracefully on bad data. */
export function loadDecks(): Deck[] {
  try {
    const raw = localStorage.getItem(DECKS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Keep only entries that look like decks; tolerate missing fields.
    return parsed.filter(isDeckLike).map(normalizeDeck);
  } catch (error) {
    console.warn('Could not load saved decks; starting fresh.', error);
    return [];
  }
}

/** Persist the full deck list. Swallows quota/serialization errors safely. */
export function saveDecks(decks: Deck[]): void {
  try {
    localStorage.setItem(DECKS_STORAGE_KEY, JSON.stringify(decks));
  } catch (error) {
    console.warn('Could not save decks to localStorage.', error);
  }
}

/** Read the id of the last-active deck, or null if none/unavailable. */
export function loadActiveDeckId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_DECK_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persist the active deck id (or clear it when null). */
export function saveActiveDeckId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_DECK_STORAGE_KEY);
    else localStorage.setItem(ACTIVE_DECK_STORAGE_KEY, id);
  } catch (error) {
    console.warn('Could not persist active deck id.', error);
  }
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
  if (isEntryPrinting(entry.printing)) normalized.printing = entry.printing;
  return [normalized];
}
