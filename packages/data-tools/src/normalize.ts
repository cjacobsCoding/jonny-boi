/**
 * Pure normalizer: raw Scryfall card → clean internal {@link NormalizedCard}.
 * No I/O. Handles single-faced and double-faced cards. Thoroughly unit-tested.
 */

import { parseManaCost, parseStat, parseTypeLine } from './parse.js';
import type {
  NormalizedCard,
  NormalizedCardFace,
  RawScryfallCard,
  RawScryfallCardFace,
  ScryfallImageUris,
} from './types.js';

/** Pick a stable id: prefer oracle id, then printing id, then fall back to name. */
function pickId(raw: RawScryfallCard): string {
  return raw.oracle_id ?? raw.id ?? raw.name;
}

/** Normalize one face of a double-faced card. */
function normalizeFace(face: RawScryfallCardFace): NormalizedCardFace {
  return {
    name: face.name,
    manaCost: parseManaCost(face.mana_cost),
    typeLine: parseTypeLine(face.type_line),
    rawTypeLine: face.type_line ?? '',
    oracleText: face.oracle_text ?? '',
    power: parseStat(face.power),
    toughness: parseStat(face.toughness),
    colors: face.colors ?? [],
    imageUris: face.image_uris ?? {},
  };
}

/**
 * Resolve the image URIs to use for a card. Single-faced cards carry them at
 * the top level; double-faced cards carry them per-face — we use the front
 * (first) face. Returns an empty map rather than throwing when absent.
 */
function resolveImageUris(raw: RawScryfallCard): ScryfallImageUris {
  if (raw.image_uris) return raw.image_uris;
  const frontFace = raw.card_faces?.[0];
  return frontFace?.image_uris ?? {};
}

/**
 * Normalize a raw Scryfall card object into the internal record.
 *
 * Robust by design: every field has a safe default, so a malformed or partial
 * card object yields a usable (if sparse) record instead of crashing the run.
 */
export function normalizeCard(raw: RawScryfallCard): NormalizedCard {
  const isDoubleFaced = Array.isArray(raw.card_faces) && raw.card_faces.length > 0;
  const faces = isDoubleFaced ? (raw.card_faces ?? []).map(normalizeFace) : [];

  // For DFCs, top-level mana_cost / type_line / oracle_text may be empty; fall
  // back to the front face so the primary record stays meaningful.
  const frontFace = raw.card_faces?.[0];

  /**
   * CR 715.2 — an ADVENTURER card is the creature in every zone but the stack,
   * so its mana cost is the creature's. Scryfall still prints the combined
   * `"{B} // {2}{B}"` at the top level, which `parseManaCost` sums into a cost
   * the card never has and which contradicts Scryfall's own `cmc` (1, not 4).
   * A split card is the opposite — CR 709.4 makes the combined object's cost
   * the SUM, and Scryfall's `cmc` agrees — so this is narrowed to the one
   * layout where the top-level string is not the card's cost.
   */
  const costSource = raw.layout === 'adventure' ? frontFace?.mana_cost : raw.mana_cost;

  return {
    id: pickId(raw),
    name: raw.name,
    manaCost: parseManaCost(costSource ?? frontFace?.mana_cost),
    cmc: typeof raw.cmc === 'number' ? raw.cmc : 0,
    typeLine: parseTypeLine(raw.type_line ?? frontFace?.type_line),
    rawTypeLine: raw.type_line ?? frontFace?.type_line ?? '',
    oracleText: raw.oracle_text ?? frontFace?.oracle_text ?? '',
    power: parseStat(raw.power ?? frontFace?.power),
    toughness: parseStat(raw.toughness ?? frontFace?.toughness),
    // Planeswalkers: printed starting loyalty. `parseStat` already returns null
    // for a non-numeric box ("X"), which is exactly "variable - not compilable".
    // The front-face fallback is the one the cost/type/text lines above already
    // take, and for the same reason: a TRANSFORMING walker prints its number on
    // a face and carries nothing at the top level.
    loyalty: parseStat(raw.loyalty ?? frontFace?.loyalty),
    // Battles: printed starting defense. Same parse, and the same meaning for a
    // non-numeric box as loyalty's — "variable, not compilable".
    //
    // ⚠️ MEASURED, and the reason a Siege still did not compile after `defense`
    // was captured: Scryfall puts a Siege's defense on `card_faces[0]`, NOT at
    // the top level (`Invasion of Gobakhan` → `defense: undefined` on the card,
    // `'3'` on the battle face). Reading only the top level captured the field
    // and normalized every battle in the game to `null` anyway.
    defense: parseStat(raw.defense ?? frontFace?.defense),
    colors: raw.colors ?? frontFace?.colors ?? [],
    colorIdentity: raw.color_identity ?? [],
    keywords: raw.keywords ?? [],
    set: raw.set ?? '',
    collectorNumber: raw.collector_number ?? '',
    rarity: raw.rarity ?? '',
    imageUris: resolveImageUris(raw),
    localImages: {},
    // Verbatim, never derived: the layout is what tells the compiler whether a
    // two-faced record is a transforming DFC, a modal DFC, a split card or an
    // adventure, and those four play by four different rules.
    ...(typeof raw.layout === 'string' && raw.layout.length > 0 ? { layout: raw.layout } : {}),
    isDoubleFaced,
    faces,
  };
}
