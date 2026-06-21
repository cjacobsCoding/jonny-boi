/**
 * Deck model + pure deck logic: add/remove with the 4-of rule, grouping by type,
 * the mana curve, validation, and the JSON export/import shape.
 *
 * The export shape is intentionally `{ name, cards: [{ cardId, count }] }` where
 * `cardId` is the **Scryfall UUID** (`NormalizedCard.id`). This is the contract
 * `packages/sim` will consume decks through, so keep it stable.
 */
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { getCard, isBasicLand, primaryType } from './cards.js';
import {
  MAX_COPIES_PER_CARD,
  MIN_DECK_SIZE,
  MANA_CURVE_BUCKETS,
  MANA_CURVE_MAX_BUCKET,
} from './config.js';

/** One stack of identical cards in a deck. */
export interface DeckEntry {
  /** Scryfall UUID of the card (matches `NormalizedCard.id`). */
  cardId: string;
  /** Number of copies in the deck. */
  count: number;
}

/** A saved deck. `id` is a local UUID; `cardId`s reference the card pool. */
export interface Deck {
  id: string;
  name: string;
  cards: DeckEntry[];
  /** ISO timestamp of the last edit, for sorting the saved-deck list. */
  updatedAt: string;
}

/** The portable export/import shape (sim-compatible — cardId = Scryfall UUID). */
export interface DeckExport {
  name: string;
  cards: Array<{ cardId: string; count: number }>;
}

/** Generate a stable-enough local id for a new deck. */
export function newDeckId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID.
  return `deck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Create an empty deck with the given name. */
export function createDeck(name: string): Deck {
  return { id: newDeckId(), name, cards: [], updatedAt: new Date().toISOString() };
}

/** Total number of cards across all entries. */
export function deckSize(deck: Deck): number {
  return deck.cards.reduce((sum, entry) => sum + entry.count, 0);
}

/** Find the count of a given card in the deck (0 if absent). */
export function countOf(deck: Deck, cardId: string): number {
  return deck.cards.find((entry) => entry.cardId === cardId)?.count ?? 0;
}

/**
 * The maximum copies allowed for a specific card: unlimited (represented as
 * `Infinity`) for basic lands, otherwise {@link MAX_COPIES_PER_CARD}.
 */
export function maxCopiesFor(card: NormalizedCard): number {
  return isBasicLand(card) ? Number.POSITIVE_INFINITY : MAX_COPIES_PER_CARD;
}

/**
 * Add one copy of a card, respecting the per-card copy limit. Returns a new deck
 * (immutable update); returns the same deck unchanged if at the limit or the
 * card is unknown.
 */
export function addCard(deck: Deck, card: NormalizedCard): Deck {
  const limit = maxCopiesFor(card);
  const current = countOf(deck, card.id);
  if (current >= limit) return deck;
  const existing = deck.cards.find((entry) => entry.cardId === card.id);
  const cards = existing
    ? deck.cards.map((entry) =>
        entry.cardId === card.id ? { ...entry, count: entry.count + 1 } : entry,
      )
    : [...deck.cards, { cardId: card.id, count: 1 }];
  return { ...deck, cards, updatedAt: new Date().toISOString() };
}

/**
 * Remove one copy of a card. Returns a new deck; drops the entry entirely when
 * its count hits zero. No-op if the card isn't present.
 */
export function removeCard(deck: Deck, cardId: string): Deck {
  const existing = deck.cards.find((entry) => entry.cardId === cardId);
  if (!existing) return deck;
  const cards =
    existing.count <= 1
      ? deck.cards.filter((entry) => entry.cardId !== cardId)
      : deck.cards.map((entry) =>
          entry.cardId === cardId ? { ...entry, count: entry.count - 1 } : entry,
        );
  return { ...deck, cards, updatedAt: new Date().toISOString() };
}

/** A resolved deck entry paired with its card record (skips unknown ids). */
export interface ResolvedEntry {
  card: NormalizedCard;
  count: number;
}

/** Resolve a deck's entries to card records, dropping ids not in the pool. */
export function resolveEntries(deck: Deck): ResolvedEntry[] {
  const resolved: ResolvedEntry[] = [];
  for (const entry of deck.cards) {
    const card = getCard(entry.cardId);
    if (card) resolved.push({ card, count: entry.count });
  }
  return resolved;
}

/** A named group of resolved entries (e.g. all creatures), for the deck list. */
export interface DeckGroup {
  type: string;
  entries: ResolvedEntry[];
  count: number;
}

/** Order groups are displayed in (anything else falls to the end, alpha). */
const GROUP_ORDER = [
  'Creature',
  'Planeswalker',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
  'Land',
];

/** Group a deck's resolved entries by primary card type, in a stable order. */
export function groupByType(deck: Deck): DeckGroup[] {
  const buckets = new Map<string, ResolvedEntry[]>();
  for (const resolved of resolveEntries(deck)) {
    const type = primaryType(resolved.card);
    const list = buckets.get(type) ?? [];
    list.push(resolved);
    buckets.set(type, list);
  }
  const groups: DeckGroup[] = [];
  for (const [type, entries] of buckets) {
    entries.sort(
      (a, b) => a.card.cmc - b.card.cmc || a.card.name.localeCompare(b.card.name),
    );
    groups.push({
      type,
      entries,
      count: entries.reduce((sum, e) => sum + e.count, 0),
    });
  }
  groups.sort((a, b) => {
    const ai = GROUP_ORDER.indexOf(a.type);
    const bi = GROUP_ORDER.indexOf(b.type);
    const ar = ai === -1 ? GROUP_ORDER.length : ai;
    const br = bi === -1 ? GROUP_ORDER.length : bi;
    return ar - br || a.type.localeCompare(b.type);
  });
  return groups;
}

/** One bar of the mana curve: a CMC bucket and how many cards fall in it. */
export interface ManaCurveBar {
  /** The bucket's mana value (the top bucket folds in everything above it). */
  bucket: number;
  /** Display label, e.g. "7+" for the top bucket. */
  label: string;
  /** Number of (non-land) cards in this bucket, counting copies. */
  count: number;
}

/**
 * Compute the mana curve: a count of non-land cards per CMC bucket. Lands are
 * excluded because their mana value isn't a meaningful curve point. Everything
 * at or above {@link MANA_CURVE_MAX_BUCKET} folds into the top bar.
 */
export function manaCurve(deck: Deck): ManaCurveBar[] {
  const counts = new Map<number, number>(MANA_CURVE_BUCKETS.map((b) => [b, 0]));
  for (const { card, count } of resolveEntries(deck)) {
    if (card.typeLine.types.includes('Land')) continue;
    const bucket = Math.min(Math.floor(card.cmc), MANA_CURVE_MAX_BUCKET);
    counts.set(bucket, (counts.get(bucket) ?? 0) + count);
  }
  return MANA_CURVE_BUCKETS.map((bucket) => ({
    bucket,
    label: bucket === MANA_CURVE_MAX_BUCKET ? `${bucket}+` : String(bucket),
    count: counts.get(bucket) ?? 0,
  }));
}

/** A validation issue: a human-readable message and whether it blocks play. */
export interface DeckIssue {
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Validate a deck against the curated-pool rules: the per-card 4-of limit
 * (basics exempt) and the minimum deck size. Pure; returns a list of issues
 * (empty when the deck is legal).
 */
export function validateDeck(deck: Deck): DeckIssue[] {
  const issues: DeckIssue[] = [];
  for (const entry of deck.cards) {
    const card = getCard(entry.cardId);
    if (!card) {
      issues.push({
        message: `Unknown card in deck (id ${entry.cardId}).`,
        severity: 'warning',
      });
      continue;
    }
    const limit = maxCopiesFor(card);
    if (entry.count > limit) {
      issues.push({
        message: `${card.name}: ${entry.count} copies exceeds the limit of ${limit}.`,
        severity: 'error',
      });
    }
  }
  const size = deckSize(deck);
  if (size < MIN_DECK_SIZE) {
    issues.push({
      message: `Deck has ${size} cards; a Constructed deck needs at least ${MIN_DECK_SIZE}.`,
      severity: 'warning',
    });
  }
  return issues;
}

/** Convert a deck to its portable export shape (sim-compatible). */
export function toExport(deck: Deck): DeckExport {
  return {
    name: deck.name,
    cards: deck.cards.map((entry) => ({ cardId: entry.cardId, count: entry.count })),
  };
}

/**
 * Parse a {@link DeckExport} (e.g. pasted/imported JSON) into a fresh Deck.
 * Robust to malformed input: throws a descriptive error rather than producing a
 * corrupt deck, so callers can show a friendly message instead of white-screening.
 */
export function fromExport(data: unknown): Deck {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Deck JSON must be an object.');
  }
  const record = data as Record<string, unknown>;
  const name = typeof record.name === 'string' && record.name.trim() ? record.name : 'Imported Deck';
  if (!Array.isArray(record.cards)) {
    throw new Error('Deck JSON must have a "cards" array.');
  }
  const cards: DeckEntry[] = [];
  for (const raw of record.cards) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const cardId = entry.cardId;
    const count = entry.count;
    if (typeof cardId === 'string' && typeof count === 'number' && count > 0) {
      cards.push({ cardId, count: Math.floor(count) });
    }
  }
  return { id: newDeckId(), name, cards, updatedAt: new Date().toISOString() };
}
