/**
 * DISPLAY RECORDS FOR ENGINE CARDS THE SCRYFALL INDEX DOES NOT COVER.
 *
 * The app has two card pools:
 *
 *   - the ENGINE pool (`@jonny-boi/cards`) — every card the rules engine can
 *     actually play;
 *   - the DISPLAY index (`data/card-index.json`) — normalized Scryfall records
 *     with art and Oracle text, committed into the build.
 *
 * Everything the UI shows reads the DISPLAY index, so a card the engine plays
 * but the index has never heard of is invisible in the app: it cannot be
 * browsed, cannot be added to a deck, and — the reason this module exists — it
 * kept the Lab's own gauntlet decks from opening in the deck builder, because
 * most of their cards had no record to render.
 *
 * The two pools now agree exactly, and `data/card-index.test.ts` fails if they
 * ever stop agreeing, so THIS SET IS EMPTY IN PRACTICE. It is deliberately kept
 * as the rule-6 safety net for the window between adding a card to the pool and
 * regenerating the index: in that window the card degrades to a readable text
 * tile instead of vanishing from the UI. It should not be deleted just because
 * it is currently contributing nothing — that IS the healthy state.
 *
 * It synthesizes a display record from the engine definition, which already
 * carries name, cost, types and P/T. What it cannot invent is art and Oracle
 * text — so those stay empty, and `CardArt` falls back to its labelled tile. A
 * card you can see and play without art beats a card that does not exist.
 *
 * These are a FALLBACK: a real Scryfall record always wins (see `cardsById`).
 */

import { loadCardPool } from '@jonny-boi/cards';
import type { CardDefinition } from '@jonny-boi/core';
import { MANA_COLORS } from '@jonny-boi/core';
import type { NormalizedCard } from '@jonny-boi/data-tools/pure';

/** Set code used for synthesized records, so they are identifiable downstream. */
export const SYNTHESIZED_SET = 'eng';

/** Convert an engine `ManaCost` into the display `ManaCost` shape. */
function displayCost(def: CardDefinition): NormalizedCard['manaCost'] {
  const cost = def.cost ?? {};
  return {
    generic: cost.generic ?? 0,
    W: cost.W ?? 0,
    U: cost.U ?? 0,
    B: cost.B ?? 0,
    R: cost.R ?? 0,
    G: cost.G ?? 0,
    C: cost.C ?? 0,
    other: [],
  };
}

/** Converted mana cost — generic plus every coloured pip. */
function cmcOf(def: CardDefinition): number {
  const cost = def.cost ?? {};
  let total = cost.generic ?? 0;
  for (const color of MANA_COLORS) total += cost[color] ?? 0;
  return total;
}

/** Title-case a type for the printed type line ("creature" → "Creature"). */
function titleCase(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
}

/** The keyword names a definition's flags imply, for display. */
function keywordNames(def: CardDefinition): string[] {
  const flags = def.keywords ?? {};
  return Object.entries(flags)
    .filter(([, on]) => on === true)
    .map(([name]) => titleCase(name.replace(/([A-Z])/g, ' $1').trim()));
}

/**
 * Build a display record from an engine definition. Honest about what it does
 * not know: no art, no Oracle text, and a marker set code — never invented.
 */
export function displayRecordFor(def: CardDefinition): NormalizedCard {
  const types = def.types.map(titleCase);
  return {
    id: def.id,
    name: def.name,
    manaCost: displayCost(def),
    cmc: cmcOf(def),
    typeLine: { supertypes: [], types: [...types], subtypes: [] },
    rawTypeLine: types.join(' '),
    oracleText: '',
    power: def.power ?? null,
    toughness: def.toughness ?? null,
    colors: MANA_COLORS.filter((c) => c !== 'C' && (def.cost?.[c] ?? 0) > 0),
    colorIdentity: MANA_COLORS.filter((c) => c !== 'C' && (def.cost?.[c] ?? 0) > 0),
    keywords: keywordNames(def),
    set: SYNTHESIZED_SET,
    collectorNumber: '0',
    rarity: 'common',
    imageUris: {},
    localImages: {},
    isDoubleFaced: false,
    faces: [],
  } as unknown as NormalizedCard;
}

let cached: readonly NormalizedCard[] | undefined;

/**
 * Display records for every card the ENGINE can play. Cached: the engine pool is
 * static build data, so this is computed once per session.
 */
export function engineDisplayCards(): readonly NormalizedCard[] {
  if (cached) return cached;
  try {
    const pool = loadCardPool({ onWarn: () => {} });
    cached = pool.cards.map(displayRecordFor);
  } catch {
    // A pool failure must never take the card browser down with it.
    cached = [];
  }
  return cached;
}
