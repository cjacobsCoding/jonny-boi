/**
 * THE CORPUS INDEX (§3.167) — every card the corpus knows that the engine
 * pool does NOT, slimmed to the fields the app renders, so the browser can show
 * the whole of Scryfall and say honestly which cards it cannot play yet.
 *
 * > "work on adding all the cards from scryfall, regardless of whether we have
 * > mechanics for them yet. Just make it so that if you put a card into a deck
 * > that has unsupported mechanics, it makes that very clear"
 *
 * Two tiers, one pipeline run:
 *  - the POOL index (`card-index.json`) — the cards the engine plays, full
 *    fidelity, bundled with the app so the shell works offline;
 *  - this CORPUS index — the rest, ~3.5× as many cards, fetched by the app on
 *    demand and cached by its service worker. Disjoint from the pool BY NAME,
 *    which is the key the pool itself resolves on, so a card is in exactly one
 *    tier and a regeneration moves it from this file to that one.
 *
 * WHAT A RECORD IS. Not a {@link NormalizedCard} — a RAW Scryfall record cut
 * down to the fields {@link normalizeCard} reads, minus the ones it can derive:
 *  - `image_uris` are dropped. Scryfall's image URL is a pure function of the
 *    printing id (`…/normal/front/e/8/e882c9f9-….jpg`), measured true for every
 *    one of 5,000 corpus records checked, and the URLs were 41% of the pool
 *    index's bytes. The app derives them (`cardImage`).
 *  - `set_name` is dropped (the app shows the set code); face `image_uris` too.
 * Keeping Scryfall's own key names rather than a private compression means the
 * app expands a record with the SAME `normalizeCard` the pool went through —
 * one normalizer, one card shape — and gzip on the wire makes the key names
 * free. Measured on the 2026-09-19 corpus AT THE TIME: 25,191 cards, 12.25 MB on
 * disk one card per line, 2.65 MB gzipped as the app's asset.
 *
 * The file is written one card per line so a regeneration diffs by card.
 */
import type { RawScryfallCard, RawScryfallCardFace } from './types.js';

/** The on-disk shape of `corpus-index.json`. */
export interface CorpusIndex {
  /** ISO timestamp of when the index was generated. */
  generatedAt: string;
  /** Attribution note (Scryfall etiquette — card data © Wizards, via Scryfall). */
  attribution: string;
  /** How many corpus records were read, before the pool was subtracted. */
  corpusSize: number;
  /** The slim raw records, sorted by name; every one is absent from the pool index. */
  cards: SlimScryfallCard[];
}

/**
 * The keys of a raw card the app needs — {@link normalizeCard}'s inputs minus
 * the derivable ones. A closed list: a key not named here is not carried.
 */
export const SLIM_CARD_KEYS = [
  'id',
  'name',
  'mana_cost',
  'cmc',
  'type_line',
  'oracle_text',
  'power',
  'toughness',
  'loyalty',
  'defense',
  'colors',
  'color_identity',
  'keywords',
  'layout',
  'set',
  'collector_number',
  'rarity',
] as const satisfies readonly (keyof RawScryfallCard)[];

/** The keys of a face the app needs — {@link normalizeFace}'s inputs minus `image_uris`. */
export const SLIM_FACE_KEYS = [
  'name',
  'mana_cost',
  'type_line',
  'oracle_text',
  'power',
  'toughness',
  'loyalty',
  'defense',
  'colors',
] as const satisfies readonly (keyof RawScryfallCardFace)[];

export type SlimScryfallCardFace = Pick<RawScryfallCardFace, (typeof SLIM_FACE_KEYS)[number]>;
export type SlimScryfallCard = Pick<RawScryfallCard, (typeof SLIM_CARD_KEYS)[number]> & {
  card_faces?: SlimScryfallCardFace[];
};

function pick<T extends object, K extends readonly (keyof T)[]>(
  record: T,
  keys: K,
): Pick<T, K[number]> {
  const out: Partial<T> = {};
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out as Pick<T, K[number]>;
}

/** One raw record, cut to the closed key lists above. Pure. */
export function slimCard(raw: RawScryfallCard): SlimScryfallCard {
  const slim: SlimScryfallCard = pick(raw, SLIM_CARD_KEYS);
  if (Array.isArray(raw.card_faces) && raw.card_faces.length > 0) {
    slim.card_faces = raw.card_faces.map((face) => pick(face, SLIM_FACE_KEYS));
  }
  return slim;
}

/**
 * The corpus minus the pool, slimmed and sorted. `inPool` is asked with the
 * same front-face key the pool resolved on, so the two tiers cannot overlap.
 */
export function buildCorpusIndex(
  rawCorpus: readonly unknown[],
  inPool: (frontFaceName: string) => boolean,
  frontFaceName: (name: string) => string,
  attribution: string,
  now: () => Date = () => new Date(),
): CorpusIndex {
  const seen = new Set<string>();
  const cards: SlimScryfallCard[] = [];
  for (const raw of rawCorpus) {
    const record = raw as RawScryfallCard;
    if (typeof record.name !== 'string' || typeof record.id !== 'string') continue;
    const key = frontFaceName(record.name);
    // First printing wins, exactly as the pool's own selection does.
    if (seen.has(key) || inPool(key)) continue;
    seen.add(key);
    cards.push(slimCard(record));
  }
  cards.sort((a, b) => a.name.localeCompare(b.name));
  return { generatedAt: now().toISOString(), attribution, corpusSize: rawCorpus.length, cards };
}

/**
 * Serialise one card per line — a regeneration then diffs by card, not by file.
 * (The write itself lives in `pipeline.ts`: this module is PURE so the browser
 * entry can export its types and builders without dragging in `node:fs`.)
 */
export function serializeCorpusIndex(index: CorpusIndex): string {
  const head = JSON.stringify({
    generatedAt: index.generatedAt,
    attribution: index.attribution,
    corpusSize: index.corpusSize,
  }).slice(0, -1);
  const rows = index.cards.map((card) => `  ${JSON.stringify(card)}`).join(',\n');
  return `${head},\n "cards": [\n${rows}\n]}\n`;
}
