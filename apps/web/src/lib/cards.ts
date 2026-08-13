/**
 * Single source of truth for card data in the web app.
 *
 * We bundle the committed `card-index.json` (32 real MTG cards, normalized by
 * `@jonny-boi/data-tools`) directly into the app via a static import rather than
 * fetching it at runtime. Rationale: it is tiny (~60 KB of text), it guarantees
 * the card list is available offline (a PWA requirement — no fetch race, no
 * network dependency for the shell), and it removes a class of "blank screen on
 * a bad fetch path" failures. Card *art* still loads from remote Scryfall URLs
 * (see {@link cardImage}); that needs network, which is acceptable per scope.
 *
 * The file is a copy owned by `apps/web`; the canonical generator lives in
 * `packages/data-tools`. We import only the TYPES from that package so there is
 * one definition of the card shape (no duplicated interfaces here).
 */
import type { CardIndex, NormalizedCard, ManaCost } from '@jonny-boi/data-tools';
import rawIndex from '../data/card-index.json';
import { importedCard, importedCards } from './decklist/importedCards.js';

/** The bundled, normalized card index. */
export const cardIndex: CardIndex = rawIndex as CardIndex;

/** Scryfall attribution string to display in the UI (Scryfall etiquette). */
export const attribution: string = cardIndex.attribution;

/**
 * The CURATED cards bundled with the build, sorted by name. Deck import adds
 * more at runtime — use {@link allAvailableCards} when you want everything the
 * user can actually put in a deck.
 */
export const allCards: readonly NormalizedCard[] = cardIndex.cards;

/** Look up a card by its stable Scryfall id. */
const cardsById: ReadonlyMap<string, NormalizedCard> = new Map(
  cardIndex.cards.map((card) => [card.id, card]),
);

/**
 * Resolve a card by id, or `undefined` if it is in neither the curated pool nor
 * the user's imported cards. Every display path (deck lists, curves, validation)
 * goes through here, so an imported card renders exactly like a curated one.
 */
export function getCard(id: string): NormalizedCard | undefined {
  return cardsById.get(id) ?? importedCard(id);
}

/**
 * Every card available to the user right now: the curated pool plus everything
 * deck import has added, name-sorted. Recomputed per call because the imported
 * set changes at runtime; the lists are small enough that this is cheaper than
 * cache invalidation.
 */
export function allAvailableCards(): readonly NormalizedCard[] {
  const imported = importedCards();
  if (imported.length === 0) return allCards;
  return [...allCards, ...imported].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Pick the best available image URL for a card at the requested size, degrading
 * gracefully through the sizes Scryfall provides. Returns `undefined` when the
 * card has no usable image so the UI can render a fallback tile.
 */
export function cardImage(
  card: NormalizedCard,
  size: 'normal' | 'art_crop' | 'large' = 'normal',
): string | undefined {
  const uris = card.imageUris;
  if (size === 'art_crop') {
    return uris.art_crop ?? uris.normal ?? uris.large ?? uris.small;
  }
  if (size === 'large') {
    return uris.large ?? uris.normal ?? uris.small;
  }
  return uris.normal ?? uris.large ?? uris.small;
}

/** Display rarity capitalized (e.g. "mythic" → "Mythic"). */
export function displayRarity(rarity: string): string {
  return rarity.length === 0 ? rarity : rarity[0]!.toUpperCase() + rarity.slice(1);
}

/** True when the card is a basic land (exempt from the deck 4-of rule). */
export function isBasicLand(card: NormalizedCard): boolean {
  return (
    card.typeLine.supertypes.includes('Basic') && card.typeLine.types.includes('Land')
  );
}

/** The primary card type used for grouping/filtering (first listed type). */
export function primaryType(card: NormalizedCard): string {
  return card.typeLine.types[0] ?? 'Other';
}

/** Total colored + colorless + generic + other mana symbols → ordered pip list. */
export function manaPips(cost: ManaCost): string[] {
  const pips: string[] = [];
  if (cost.generic > 0) pips.push(String(cost.generic));
  const colorOrder: Array<keyof ManaCost> = ['W', 'U', 'B', 'R', 'G', 'C'];
  for (const color of colorOrder) {
    const count = cost[color];
    if (typeof count === 'number') {
      for (let i = 0; i < count; i += 1) pips.push(color as string);
    }
  }
  for (const other of cost.other) pips.push(other);
  return pips;
}
