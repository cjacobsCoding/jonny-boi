/**
 * The deck model + loader (DESIGN §3.5). A deck is PURE DATA — a name and a list
 * of `{ cardId, count }` entries referencing the curated pool. Adding a deck is a
 * file under `data/decks/`, never a code change (DESIGN §1.1).
 *
 * The loader resolves every entry against `@jonny-boi/cards`'s pool, validates
 * legality (size + 4-of rule, basics exempt), and expands the deck into the flat
 * `CardDefinition[]` library the core engine shuffles. A reference to a stubbed
 * mechanic still loads and plays (the engine no-ops unsupported effects — DESIGN
 * §3.9); only an *unknown id* or an *illegal count* is rejected, with a clear
 * reason and never a thrown stack trace.
 */

import type { CardDefinition } from '@jonny-boi/core';
import type { CardPool } from '@jonny-boi/cards';
import { DEFAULT_DECK_RULES, type DeckRules } from './config.js';

/** One line of a decklist: a pool card id (or name) and how many copies. */
export interface DeckEntry {
  /** Scryfall id (preferred) OR exact card name — the loader resolves either. */
  readonly cardId: string;
  /** Copies of this card in the deck (≥ 1). */
  readonly count: number;
}

/** A deck as authored in data: a name, an archetype label, and its entries. */
export interface Deck {
  /** Unique, human-facing deck name (also the CLI selector). */
  readonly name: string;
  /** A short archetype tag for display/grouping (e.g. "Mono-Red Aggro"). */
  readonly archetype: string;
  /** The decklist entries. */
  readonly cards: readonly DeckEntry[];
}

/** A deck whose every entry has been resolved + validated against the pool. */
export interface LoadedDeck {
  readonly name: string;
  readonly archetype: string;
  /** The flat library (one `CardDefinition` per physical card), pre-shuffle. */
  readonly library: readonly CardDefinition[];
  /** Total cards in the library. */
  readonly size: number;
}

/** A structured load failure (never thrown — returned, then surfaced cleanly). */
export class DeckLoadError extends Error {
  constructor(
    public readonly deckName: string,
    public readonly reasons: readonly string[],
  ) {
    super(`deck "${deckName}" is invalid:\n  - ${reasons.join('\n  - ')}`);
    this.name = 'DeckLoadError';
  }
}

/** Resolve a deck entry's card by id first, then by exact name. */
function resolveCard(pool: CardPool, ref: string): CardDefinition | undefined {
  return pool.get(ref) ?? pool.getByName(ref);
}

/**
 * Validate and expand a `Deck` into a `LoadedDeck`. Collects ALL problems before
 * failing so the author sees every issue at once. Throws `DeckLoadError` only
 * when invalid; callers in the CLI catch it and print the reasons.
 */
export function loadDeck(deck: Deck, pool: CardPool, rules: DeckRules = DEFAULT_DECK_RULES): LoadedDeck {
  const reasons: string[] = [];
  const library: CardDefinition[] = [];
  // Copies are counted per CARD, not per decklist line. The same card may appear
  // on several lines (by id on one and by name on another, or because a swap split
  // a line in two), and checking each line in isolation would wave a 6-of through
  // as two legal 3-ofs — an illegal deck silently simulated as if it were legal.
  const copiesByCard = new Map<string, { readonly def: CardDefinition; count: number }>();

  if (deck.cards.length === 0) {
    reasons.push('the deck has no cards');
  }

  for (const entry of deck.cards) {
    if (!Number.isInteger(entry.count) || entry.count < 1) {
      reasons.push(`entry "${entry.cardId}" has an invalid count (${entry.count})`);
      continue;
    }
    const def = resolveCard(pool, entry.cardId);
    if (!def) {
      reasons.push(`unknown card "${entry.cardId}" (not in the pool by id or name)`);
      continue;
    }
    const tally = copiesByCard.get(def.id);
    if (tally) tally.count += entry.count;
    else copiesByCard.set(def.id, { def, count: entry.count });
    for (let i = 0; i < entry.count; i++) library.push(def);
  }

  for (const { def, count } of copiesByCard.values()) {
    if (rules.unlimitedCopies.has(def.name)) continue;
    if (count > rules.maxCopiesNonBasic) {
      reasons.push(`${def.name}: ${count} copies exceeds the ${rules.maxCopiesNonBasic}-of limit`);
    }
  }

  if (library.length < rules.minDeckSize) {
    reasons.push(`deck size ${library.length} is below the minimum of ${rules.minDeckSize}`);
  }

  if (reasons.length > 0) throw new DeckLoadError(deck.name, reasons);

  return { name: deck.name, archetype: deck.archetype, library, size: library.length };
}

/** A non-throwing legality check — returns the problems (empty = legal). */
export function validateDeck(deck: Deck, pool: CardPool, rules: DeckRules = DEFAULT_DECK_RULES): string[] {
  try {
    loadDeck(deck, pool, rules);
    return [];
  } catch (err) {
    if (err instanceof DeckLoadError) return [...err.reasons];
    return [String(err)];
  }
}
