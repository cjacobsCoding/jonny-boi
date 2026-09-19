/**
 * THE BROWSE RECORD — a `NormalizedCard` packed for an index of EVERY card.
 *
 * The bundled `card-index.json` carries a full `NormalizedCard` per card and is
 * statically imported: at ~1,564 B/card that is fine for the ~7k cards the
 * engine plays and impossible for the 32k Scryfall knows (48 MB raw, measured
 * 2026-09-18). The whole-Scryfall index therefore ships in THIS shape — the same
 * facts, ~4× smaller — and is unpacked to a `NormalizedCard` on read, so every
 * consumer keeps seeing the one card shape this package defines.
 *
 * Where the bytes went, and where they go now (measured on the 6,944-card index):
 *
 *  * `imageUris` — 425 B/card of four URLs that differ only in a size segment
 *    and, for 91.2% of cards, contain the card's own id. All 27,776 URLs follow
 *    `https://cards.scryfall.io/{size}/front/{id[0]}/{id[1]}/{id}.jpg` exactly;
 *    the `?timestamp` is a cache-buster Scryfall serves identically without (same
 *    200, same bytes). So the record stores nothing when the image id IS the card
 *    id, and just the image id when it is not. → {@link browseImageUris}.
 *  * `manaCost` — a seven-key object (60 B) for what the printed string says in
 *    ~8; stored as the canonical string and re-read by the same `parseManaCost`
 *    that built it in the first place, so there is ONE parser.
 *  * `typeLine` — a parsed object beside `rawTypeLine`, its own source; the raw
 *    line is kept and `parseTypeLine` re-derives the rest.
 *  * nulls and empties — omitted; absence is the value.
 *
 * Keys are one or two letters because there are 32,341 of each. The legend is
 * the {@link BrowseRecord} interface, and {@link unpackBrowseRecord} is the only
 * place that reads them. **Adding a field is a row in both `pack` and `unpack`
 * and a line in the round-trip test**, which fails on any field that does not
 * survive — a packed index that silently dropped a fact would be worse than a
 * big one.
 */

import type { ManaColor, ManaCost, NormalizedCard, NormalizedCardFace, ScryfallImageUris } from './types.js';
import { parseManaCost, parseTypeLine } from './parse.js';

/** Scryfall's image host and the four sizes the app reads, in the app's order. */
export const SCRYFALL_IMAGE_HOST = 'https://cards.scryfall.io';
export const BROWSE_IMAGE_SIZES = ['small', 'normal', 'large', 'art_crop'] as const;

/** The colour letters in mana-symbol order — the order `packManaCost` writes pips in. */
const COLOR_ORDER: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

/** One face of a double-faced / split / adventure card, packed. */
export interface BrowseFace {
  readonly n: string;
  readonly m?: string;
  readonly t: string;
  readonly o?: string;
  readonly p?: number;
  readonly g?: number;
  readonly co?: string;
  /** The face's own image id, when it has one and it differs from the card's. */
  readonly img?: string;
}

/** A `NormalizedCard`, packed. See the module header for the legend. */
export interface BrowseRecord {
  /** id */
  readonly i: string;
  /** name */
  readonly n: string;
  /** mana cost, canonical string; absent when the card prints no cost */
  readonly m?: string;
  /** cmc */
  readonly c: number;
  /** raw type line */
  readonly t: string;
  /** oracle text; absent when empty */
  readonly o?: string;
  /** power / toughness, when printed as numbers */
  readonly p?: number;
  readonly g?: number;
  /** loyalty / defense */
  readonly l?: number;
  readonly d?: number;
  /** colors / colour identity, as letters in WUBRG order; absent when colourless */
  readonly co?: string;
  readonly ci?: string;
  /** keywords; absent when none */
  readonly k?: readonly string[];
  /** set code, collector number, rarity */
  readonly s: string;
  readonly cn: string;
  readonly r: string;
  /** image id, only when it is not the card id */
  readonly img?: string;
  /** layout, only when not 'normal' */
  readonly ly?: string;
  /** faces, only for cards that have them */
  readonly f?: readonly BrowseFace[];
}

// ---------------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------------

/** The four image URIs Scryfall serves for an image id — the shape every URL in the index follows. */
export function browseImageUris(imageId: string): ScryfallImageUris {
  const uris: Partial<Record<(typeof BROWSE_IMAGE_SIZES)[number], string>> = {};
  for (const size of BROWSE_IMAGE_SIZES) {
    uris[size] = `${SCRYFALL_IMAGE_HOST}/${size}/front/${imageId[0]}/${imageId[1]}/${imageId}.jpg`;
  }
  return uris;
}

/**
 * The image id a set of URIs was built from, or `undefined` when they do not
 * follow the shape (no URIs at all, or a URL this cannot read). The caller then
 * keeps nothing, and `unpack` will synthesize from the card id — which is only
 * right when the URIs were absent; a URL of another shape is reported.
 */
export function imageIdOf(uris: ScryfallImageUris | undefined): string | undefined {
  if (!uris) return undefined;
  for (const size of BROWSE_IMAGE_SIZES) {
    const url = uris[size];
    if (typeof url !== 'string') continue;
    const m = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jpg(?:\?|$)/.exec(url);
    if (m) return m[1];
  }
  return undefined;
}

// ---------------------------------------------------------------------------------
// mana and colours
// ---------------------------------------------------------------------------------

/**
 * A `ManaCost` back to the canonical string `parseManaCost` reads: generic first,
 * then WUBRG and C pips, then every `other` symbol verbatim. Not necessarily the
 * PRINTED order — the app only ever reads the parsed object, so the string need
 * only be lossless, and the round-trip test is what says it is.
 */
export function packManaCost(cost: ManaCost): string | undefined {
  if (cost.absent) return undefined;
  let out = '';
  if (cost.generic > 0) out += `{${cost.generic}}`;
  for (const color of [...COLOR_ORDER, 'C'] as const) {
    out += `{${color}}`.repeat(cost[color]);
  }
  for (const symbol of cost.other) out += `{${symbol}}`;
  // A printed {0} (Ornithopter) is a cost of nothing, which is not the same as no
  // cost at all (a land): the string must say so, or the parser reads it back as
  // absent.
  return out === '' ? '{0}' : out;
}

/** Colour letters concatenated IN THE ORDER GIVEN — one character each, so no separator, and the order survives. */
function packColors(colors: readonly string[]): string | undefined {
  if (colors.length === 0) return undefined;
  return colors.join('');
}

function unpackColors(packed: string | undefined): string[] {
  return packed === undefined ? [] : packed.split('');
}

// ---------------------------------------------------------------------------------
// pack / unpack
// ---------------------------------------------------------------------------------

function packFace(face: NormalizedCardFace, cardId: string): BrowseFace {
  const img = imageIdOf(face.imageUris);
  return {
    n: face.name,
    ...(packManaCost(face.manaCost) !== undefined ? { m: packManaCost(face.manaCost) } : {}),
    t: face.rawTypeLine,
    ...(face.oracleText ? { o: face.oracleText } : {}),
    ...(face.power !== null ? { p: face.power } : {}),
    ...(face.toughness !== null ? { g: face.toughness } : {}),
    ...(packColors(face.colors) !== undefined ? { co: packColors(face.colors) } : {}),
    ...(img !== undefined && img !== cardId ? { img } : {}),
  };
}

function unpackFace(face: BrowseFace, cardId: string, cardHasImages: boolean): NormalizedCardFace {
  const imageId = face.img ?? (cardHasImages ? cardId : undefined);
  return {
    name: face.n,
    manaCost: parseManaCost(face.m),
    typeLine: parseTypeLine(face.t),
    rawTypeLine: face.t,
    oracleText: face.o ?? '',
    power: face.p ?? null,
    toughness: face.g ?? null,
    colors: unpackColors(face.co),
    imageUris: imageId !== undefined ? browseImageUris(imageId) : {},
  };
}

/** Pack one card. Lossless for every field {@link unpackBrowseRecord} restores — the test says which. */
export function packBrowseRecord(card: NormalizedCard): BrowseRecord {
  const img = imageIdOf(card.imageUris);
  const m = packManaCost(card.manaCost);
  const co = packColors(card.colors);
  const ci = packColors(card.colorIdentity);
  return {
    i: card.id,
    n: card.name,
    ...(m !== undefined ? { m } : {}),
    c: card.cmc,
    t: card.rawTypeLine,
    ...(card.oracleText ? { o: card.oracleText } : {}),
    ...(card.power !== null && card.power !== undefined ? { p: card.power } : {}),
    ...(card.toughness !== null && card.toughness !== undefined ? { g: card.toughness } : {}),
    ...(card.loyalty !== null && card.loyalty !== undefined ? { l: card.loyalty } : {}),
    ...(card.defense !== null && card.defense !== undefined ? { d: card.defense } : {}),
    ...(co !== undefined ? { co } : {}),
    ...(ci !== undefined ? { ci } : {}),
    ...(card.keywords.length > 0 ? { k: card.keywords } : {}),
    s: card.set,
    cn: card.collectorNumber,
    r: card.rarity,
    ...(img !== undefined && img !== card.id ? { img } : {}),
    ...(card.layout !== undefined && card.layout !== 'normal' ? { ly: card.layout } : {}),
    ...(card.faces.length > 0 ? { f: card.faces.map((face) => packFace(face, card.id)) } : {}),
  };
}

/**
 * Unpack one record to the `NormalizedCard` the app consumes.
 *
 * `imageUris` is synthesized from the image id (or the card id). A card packed
 * from a record that had NO image URIs at all would come back with some — the
 * generator excludes such cards before packing, and the round-trip test over the
 * real index is what guarantees no card in it has that shape.
 */
export function unpackBrowseRecord(rec: BrowseRecord): NormalizedCard {
  const imageId = rec.img ?? rec.i;
  return {
    id: rec.i,
    name: rec.n,
    manaCost: parseManaCost(rec.m),
    cmc: rec.c,
    typeLine: parseTypeLine(rec.t),
    rawTypeLine: rec.t,
    oracleText: rec.o ?? '',
    power: rec.p ?? null,
    toughness: rec.g ?? null,
    loyalty: rec.l ?? null,
    defense: rec.d ?? null,
    colors: unpackColors(rec.co),
    colorIdentity: unpackColors(rec.ci),
    keywords: rec.k ? [...rec.k] : [],
    set: rec.s,
    collectorNumber: rec.cn,
    rarity: rec.r,
    imageUris: browseImageUris(imageId),
    localImages: {},
    layout: rec.ly ?? 'normal',
    isDoubleFaced: (rec.f?.length ?? 0) > 1,
    faces: rec.f ? rec.f.map((face) => unpackFace(face, rec.i, true)) : [],
  };
}
