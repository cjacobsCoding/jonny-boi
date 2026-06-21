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

  return {
    id: pickId(raw),
    name: raw.name,
    manaCost: parseManaCost(raw.mana_cost ?? frontFace?.mana_cost),
    cmc: typeof raw.cmc === 'number' ? raw.cmc : 0,
    typeLine: parseTypeLine(raw.type_line ?? frontFace?.type_line),
    rawTypeLine: raw.type_line ?? frontFace?.type_line ?? '',
    oracleText: raw.oracle_text ?? frontFace?.oracle_text ?? '',
    power: parseStat(raw.power ?? frontFace?.power),
    toughness: parseStat(raw.toughness ?? frontFace?.toughness),
    colors: raw.colors ?? frontFace?.colors ?? [],
    colorIdentity: raw.color_identity ?? [],
    keywords: raw.keywords ?? [],
    set: raw.set ?? '',
    collectorNumber: raw.collector_number ?? '',
    rarity: raw.rarity ?? '',
    imageUris: resolveImageUris(raw),
    localImages: {},
    isDoubleFaced,
    faces,
  };
}
