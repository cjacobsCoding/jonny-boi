/**
 * Per-deck-entry alternate printings: "this slot in THIS deck uses that art".
 *
 * ── Why the art URL is stored on the entry, not looked up ─────────────────────
 * The bundled card index (`data/card-index.json`) carries exactly ONE printing
 * per card — the compiler needs one canonical record per card id, and mirroring
 * every printing of six hundred cards would balloon the build for a purely
 * cosmetic choice. So the alternate printings are NOT local data: they are
 * fetched on demand from Scryfall (`lib/proxy/prints.ts`), memoised in a TTL
 * localStorage cache, and — exactly as the Proxies overrides already do — the
 * chosen printing's image URL is written down on the selection. That keeps a
 * chosen printing renderable after a reload with no network, and means this
 * module needs no fetch of its own.
 *
 * A deck ENTRY is one stack of identical cards, so a printing chosen here
 * applies to every copy in that stack. That is the granularity the deck model
 * has, and the granularity the request asked for.
 *
 * Pure and dependency-free (no DOM, no network) so all of it is unit-testable.
 */

import type { Deck, DeckEntry } from '../deck.js';
import type { PrintingOverride } from '../proxy/overrides.js';
import type { PrintOption } from '../proxy/prints.js';

/**
 * The Scryfall printing chosen for one deck slot.
 *
 * Deliberately a self-contained record rather than a bare Scryfall id: an id
 * alone is not renderable offline, and the whole point of picking art is that
 * you see it.
 */
export interface EntryPrinting {
  /** Scryfall id of the chosen printing — the stable identity of the choice. */
  scryfallId: string;
  /** Front-face image URL for the chosen printing. */
  imageUrl: string;
  /** Back-face image URL, when the chosen printing is double-faced. */
  backImageUrl?: string;
  /** Set code, for the badge (e.g. "MH2"). */
  set?: string;
  /** Human label for the badge/tooltip, e.g. "MH2 · #123 · Ron Spencer". */
  label?: string;
}

/** Narrow a persisted/imported value to a well-formed {@link EntryPrinting}. */
export function isEntryPrinting(value: unknown): value is EntryPrinting {
  if (!value || typeof value !== 'object') return false;
  const printing = value as Record<string, unknown>;
  return (
    typeof printing.scryfallId === 'string' &&
    printing.scryfallId.length > 0 &&
    typeof printing.imageUrl === 'string' &&
    printing.imageUrl.length > 0
  );
}

/**
 * Build an {@link EntryPrinting} from a picker option. Optional fields are
 * omitted rather than set to `undefined` so a deck round-trips through JSON
 * unchanged — `JSON.stringify` drops `undefined`, and an export that differs
 * from what was saved is a diff nobody can explain.
 */
export function printingFromOption(option: PrintOption, label: string): EntryPrinting {
  const printing: EntryPrinting = {
    scryfallId: option.scryfallId,
    imageUrl: option.imageUrl,
  };
  if (option.backImageUrl !== undefined) printing.backImageUrl = option.backImageUrl;
  if (option.set !== undefined) printing.set = option.set;
  if (label) printing.label = label;
  return printing;
}

/** The printing chosen for a card in this deck, or `undefined` for the default. */
export function entryPrintingOf(deck: Deck, cardId: string): EntryPrinting | undefined {
  return deck.cards.find((entry) => entry.cardId === cardId)?.printing;
}

/** True when this printing is the one the entry is already using. */
export function isChosenPrinting(
  printing: EntryPrinting | undefined,
  scryfallId: string,
): boolean {
  return printing?.scryfallId === scryfallId;
}

/**
 * Return a NEW deck with `cardId`'s entry using `printing` (immutable update).
 * A card that is not in the deck is left alone — choosing art for a slot that
 * does not exist is a no-op, not a new slot.
 */
export function withEntryPrinting(
  deck: Deck,
  cardId: string,
  printing: EntryPrinting,
): Deck {
  return mapEntry(deck, cardId, (entry) => ({ ...entry, printing }));
}

/** Return a NEW deck with `cardId`'s entry back on its default printing. */
export function withoutEntryPrinting(deck: Deck, cardId: string): Deck {
  return mapEntry(deck, cardId, (entry) => {
    // Delete rather than set to `undefined`: see `printingFromOption`.
    const { printing: _dropped, ...rest } = entry;
    return rest;
  });
}

/** How many entries in this deck have a non-default printing chosen. */
export function customPrintingCount(deck: Deck): number {
  return deck.cards.filter((entry) => entry.printing !== undefined).length;
}

/**
 * The Proxies art overrides a deck's chosen printings imply, as `[name,
 * override]` pairs ready to fold into that view's override map.
 *
 * Choosing art you cannot print would be a joke of a feature, and Proxies is
 * where art actually matters — so loading a deck there carries its choices over.
 * The two models stay separate on purpose, though, and this is the seam rather
 * than a shared store: a deck entry is keyed by card ID and belongs to ONE deck,
 * while a Proxies override is keyed by name and applies to whatever list is
 * pasted in. Merging them would make editing a proxy sheet quietly rewrite the
 * deck.
 *
 * `nameOf` is injected so this stays pure — the caller owns pool lookup. An
 * entry whose card no longer resolves is skipped rather than guessed at.
 */
export function deckPrintingOverrides(
  deck: Deck,
  nameOf: (cardId: string) => string | undefined,
): Array<readonly [string, PrintingOverride]> {
  const pairs: Array<readonly [string, PrintingOverride]> = [];
  for (const entry of deck.cards) {
    if (!entry.printing) continue;
    const name = nameOf(entry.cardId);
    if (name === undefined) continue;
    const override: PrintingOverride = {
      kind: 'printing',
      scryfallId: entry.printing.scryfallId,
      imageUrl: entry.printing.imageUrl,
    };
    if (entry.printing.backImageUrl !== undefined) {
      override.backImageUrl = entry.printing.backImageUrl;
    }
    if (entry.printing.set !== undefined) override.set = entry.printing.set;
    if (entry.printing.label !== undefined) override.label = entry.printing.label;
    pairs.push([name, override] as const);
  }
  return pairs;
}

/** Apply `change` to the entry for `cardId`, returning a new deck (or the same). */
function mapEntry(
  deck: Deck,
  cardId: string,
  change: (entry: DeckEntry) => DeckEntry,
): Deck {
  if (!deck.cards.some((entry) => entry.cardId === cardId)) return deck;
  return {
    ...deck,
    cards: deck.cards.map((entry) => (entry.cardId === cardId ? change(entry) : entry)),
    updatedAt: new Date().toISOString(),
  };
}
