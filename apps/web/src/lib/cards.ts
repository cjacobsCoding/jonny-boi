/**
 * Single source of truth for card data in the web app.
 *
 * We bundle the committed `card-index.json` — a normalized Scryfall record for
 * every card in the engine pool — directly into the app via a static import
 * rather than fetching it at runtime. Rationale: it guarantees the card list is
 * available offline (a PWA requirement — no fetch race, no network dependency
 * for the shell), and it removes a class of "blank screen on a bad fetch path"
 * failures. Card *art* still loads from remote Scryfall URLs (see
 * {@link cardImage}); that needs network, which is acceptable per scope.
 *
 * The file is DERIVED, not authored: `apps/web/scripts/build-card-index.mjs`
 * projects it out of the canonical `packages/data-tools/data/card-index.json`,
 * keeping only the fields the app renders. **Never hand-edit it** — regenerate
 * with `npm run cards:index -w @jonny-boi/web`. It was a hand-made copy once,
 * and it went stale by 124 cards before anyone noticed; `data/card-index.test.ts`
 * now re-derives it on every `npm test` so that cannot recur.
 *
 * We import only the TYPES from `@jonny-boi/data-tools` so there is one
 * definition of the card shape (no duplicated interfaces here).
 */
import type { CardIndex, NormalizedCard, ManaCost } from '@jonny-boi/data-tools';
import { scryfallImageUrl, type ScryfallImageSize } from '@jonny-boi/data-tools/pure';
import { COPY_ID_SUFFIX } from '@jonny-boi/core';
import rawIndex from '../data/card-index.json';
import { corpusCard, corpusCardByName, corpusCards, corpusVersion } from './cards/corpus.js';
import { engineDisplayCards } from './cards/enginePool.js';
import { importedCard, importedCardCount, importedCards } from './decklist/importedCards.js';
import { normalizeName } from './scryfall/collection.js';

/** The bundled, normalized card index. */
export const cardIndex: CardIndex = rawIndex as CardIndex;

/** Scryfall attribution string to display in the UI (Scryfall etiquette). */
export const attribution: string = cardIndex.attribution;

/**
 * The CURATED cards bundled with the build, sorted by name.
 *
 * This is the SCRYFALL-BACKED set: full art and Oracle text, but far smaller than
 * the set the engine can play. Prefer {@link allAvailableCards} for anything the
 * user picks from — it also covers engine cards with no Scryfall record, and
 * everything deck import has added.
 */
export const allCards: readonly NormalizedCard[] = cardIndex.cards;

/**
 * Every card with a display record, indexed by id: the Scryfall-backed ones
 * FIRST, then synthesized records for engine cards Scryfall data doesn't cover.
 *
 * Order matters — a real record must always win over a synthesized one, which
 * has no art or Oracle text. Built once; both inputs are static build data.
 */
const cardsById: ReadonlyMap<string, NormalizedCard> = (() => {
  const index = new Map<string, NormalizedCard>();
  // Synthesized first so the real Scryfall records overwrite them.
  for (const card of engineDisplayCards()) index.set(card.id, card);
  for (const card of cardIndex.cards) index.set(card.id, card);
  return index;
})();

/**
 * The full displayable pool: the Scryfall records, plus synthesized ones for any
 * engine card the index does not cover. That second set is empty today (a test
 * asserts it) and exists so it can never again be the case that the app plays a
 * card it cannot show — which is what stopped the Lab's own gauntlet decks from
 * opening in the deck builder.
 */
const displayablePool: readonly NormalizedCard[] = [...cardsById.values()].sort((a, b) =>
  a.name.localeCompare(b.name),
);

/**
 * The curated pool's records by NORMALIZED NAME — the shadow check for imports.
 *
 * Everything else here joins on Scryfall id, but an id names a PRINTING, not a
 * card: the fuzzy add-card lookup returns Scryfall's default printing, and a
 * deck imported before a card joined the curated pool keeps whatever printing
 * was fetched then. Either way the store can hold the same CARD under a second
 * id, and only the name says so.
 */
const displayableByName: ReadonlyMap<string, NormalizedCard> = new Map(
  displayablePool.map((card) => [normalizeName(card.name), card]),
);

/**
 * The id suffix the card compiler stamps on a transforming DFC's BACK-face
 * definition (`<frontId>#back` — see `BACK_FACE_ID_SUFFIX` in
 * `@jonny-boi/cards`). Kept as a literal here so the display layer needs no
 * dependency on the compiler package; `getCard`'s own test pins the two agree.
 */
export const BACK_FACE_ID_SUFFIX = '#back';

/** Which face of a DFC record a back-face id refers to (0 = front). */
const BACK_FACE_INDEX = 1;

/**
 * Synthesized display records for back faces, built lazily and memoized: a
 * transformed permanent's `cardId` is `<frontId>#back`, and the board/hover
 * must show the BACK face's own name, art, type line and P/T — the whole point
 * of per-face Scryfall data. Deliberately NOT part of {@link cardsById}: a back
 * face is not a card you can put in a deck, so it must never appear in the
 * browser/deck-builder pool.
 */
const backFaceCache = new Map<string, NormalizedCard | undefined>();

function backFaceRecord(backId: string): NormalizedCard | undefined {
  if (backFaceCache.has(backId)) return backFaceCache.get(backId);
  const frontId = backId.slice(0, -BACK_FACE_ID_SUFFIX.length);
  const front = cardsById.get(frontId) ?? importedCard(frontId) ?? corpusCard(frontId);
  const face = front?.faces?.[BACK_FACE_INDEX];
  const record: NormalizedCard | undefined =
    front && face
      ? {
          ...front,
          id: backId,
          name: face.name,
          manaCost: face.manaCost,
          typeLine: face.typeLine,
          rawTypeLine: face.rawTypeLine,
          oracleText: face.oracleText,
          power: face.power,
          toughness: face.toughness,
          colors: face.colors,
          // §3.167 — a record with no face URLs (the corpus tier, a slimmed
          // pool record) derives them from the PRINTING id, back face.
          imageUris:
            Object.keys(face.imageUris).length > 0
              ? face.imageUris
              : derivedImageUris(frontId, 'back'),
          // Face records carry no localImages of their own; remote art only.
          localImages: {},
          faces: [],
        }
      : undefined;
  backFaceCache.set(backId, record);
  return record;
}

/**
 * Resolve a card by id, or `undefined` if it is in neither the curated pool nor
 * the user's imported cards. Every display path (deck lists, curves, validation)
 * goes through here, so an imported card renders exactly like a curated one —
 * and a transformed DFC's back-face id (`<frontId>#back`) resolves to a record
 * built from that face's own Scryfall data, so the board and CardHover show the
 * active face's art.
 */
export function getCard(id: string): NormalizedCard | undefined {
  if (id.endsWith(BACK_FACE_ID_SUFFIX)) return backFaceRecord(id);
  // A COPY's definition id is the COPIED card's id plus `#copy` (core's
  // `COPY_ID_SUFFIX`) -- derived exactly as a back face is, and for the same
  // reason: the copy is not the pool's row for that card, because the printed
  // "except" tail may have changed its name or its types. What it should LOOK
  // like, though, is the thing it copied, so the id resolves to that record and
  // the board shows a Clone wearing the copied creature's art.
  if (id.endsWith(COPY_ID_SUFFIX)) {
    return getCard(id.slice(0, -COPY_ID_SUFFIX.length));
  }
  return cardsById.get(id) ?? importedCard(id) ?? corpusCard(id);
}

/**
 * Resolve a card by NAME (case- and space-insensitively), preferring the curated
 * record. This is the "do we already have this card?" question, and it must be
 * asked by name: an id only identifies a printing, so a by-id lookup happily
 * waves a second printing of a curated card into the pool as if it were new.
 */
export function getCardByName(name: string): NormalizedCard | undefined {
  const key = normalizeName(name);
  const pooled = displayableByName.get(key);
  if (pooled) return pooled;
  return importedCards().find((card) => normalizeName(card.name) === key) ?? corpusCardByName(name);
}

/**
 * Every card available to the user right now: the curated pool plus everything
 * deck import has added, name-sorted. Recomputed per call because the imported
 * set changes at runtime; the lists are small enough that this is cheaper than
 * cache invalidation.
 *
 * Deduplicated by NAME, curated record first: the import store keys on Scryfall
 * id, so a different PRINTING of a curated card (an old import from before the
 * card joined the pool, or a fuzzy-lookup add that returned another set's copy)
 * sits in the store under a second id — and showed in the browser as a second,
 * identical card. The store entry itself is kept (a saved deck may reference
 * its id, and {@link getCard} must keep resolving it); it just stops being
 * offered as if it were a different card.
 */
export function allAvailableCards(): readonly NormalizedCard[] {
  // §3.167 — memoized on the two stores that can change it: the merged list
  // is tens of thousands of cards once the corpus tier has arrived, and every
  // view asks for it per render.
  const key = `${importedCardCount()}|${corpusVersion()}`;
  if (availableMemo && availableMemo.key === key) return availableMemo.cards;
  const imported = importedCards();
  const extras = new Map<string, NormalizedCard>();
  for (const card of imported) {
    const key = normalizeName(card.name);
    if (!displayableByName.has(key) && !extras.has(key)) extras.set(key, card);
  }
  // The corpus tier is disjoint from the pool BY CONSTRUCTION (data-tools
  // subtracts the pool by the same name key); an import may still shadow a
  // corpus card by name, and the import wins because it may have compiled.
  for (const card of corpusCards()) {
    const key = normalizeName(card.name);
    if (!displayableByName.has(key) && !extras.has(key)) extras.set(key, card);
  }
  const cards =
    extras.size === 0
      ? displayablePool
      : [...displayablePool, ...extras.values()].sort((a, b) => a.name.localeCompare(b.name));
  availableMemo = { key, cards };
  return cards;
}

let availableMemo: { readonly key: string; readonly cards: readonly NormalizedCard[] } | null =
  null;

/**
 * The four variants `cardImage` can return, derived from a printing id — for a
 * record that carries no URLs of its own (§3.167). Empty when the id is not a
 * Scryfall uuid, which is exactly when the record has to carry them itself.
 */
function derivedImageUris(printingId: string, face: 'front' | 'back'): NormalizedCard['imageUris'] {
  const derived: Record<string, string> = {};
  for (const size of DERIVED_IMAGE_SIZES) {
    const url = scryfallImageUrl(printingId, size, face);
    if (url !== undefined) derived[size] = url;
  }
  return derived;
}

/** The sizes the app displays — the same four the index projection keeps. */
const DERIVED_IMAGE_SIZES: readonly ScryfallImageSize[] = ['small', 'normal', 'large', 'art_crop'];

/**
 * Pick the best available image URL for a card at the requested size, degrading
 * gracefully through the sizes Scryfall provides. Returns `undefined` when the
 * card has no usable image so the UI can render a fallback tile.
 */
export function cardImage(
  card: NormalizedCard,
  size: 'normal' | 'art_crop' | 'large' = 'normal',
): string | undefined {
  // §3.167 — a record with no URLs derives them from its printing id (the
  // corpus tier, and every pool record whose URLs said nothing the id did not).
  const uris =
    Object.keys(card.imageUris).length > 0 ? card.imageUris : derivedImageUris(card.id, 'front');
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
  return card.typeLine.supertypes.includes('Basic') && card.typeLine.types.includes('Land');
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
