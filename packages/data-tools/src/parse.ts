/**
 * Pure parsers for Scryfall string fields. No I/O, no network — these are the
 * heart of the unit tests and must stay dependency-free.
 */

import type { ManaCost, ParsedTypeLine } from './types.js';

/** A fresh, all-zero mana cost. */
function emptyManaCost(): ManaCost {
  return { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] };
}

const SIMPLE_COLOR_SYMBOLS: ReadonlySet<string> = new Set(['W', 'U', 'B', 'R', 'G', 'C']);

/**
 * Parse a Scryfall mana-cost string (e.g. `{2}{U}{U}`) into a structured cost.
 *
 * - Pure numeric pips accumulate into `generic` (`{2}` → generic 2).
 * - Single WUBRG / C pips increment their channel (`{U}{U}` → U:2).
 * - Anything compound — hybrid `{W/U}`, Phyrexian `{W/P}`, snow `{S}`, `{X}` —
 *   degrades gracefully into `other` so no cost data is silently dropped.
 *
 * Tolerant of empty / undefined input (lands, DFC backs) → an all-zero cost.
 */
export function parseManaCost(manaCost: string | undefined | null): ManaCost {
  const cost = emptyManaCost();
  // No printed cost at all is NOT `{0}` — see `ManaCost.absent`.
  if (!manaCost) return { ...cost, absent: true };

  // Symbols are wrapped in braces: {2}{W}{W/U}{X}. Extract each brace group.
  const symbols = manaCost.match(/\{([^}]+)\}/g);
  if (!symbols) return cost;

  for (const wrapped of symbols) {
    const symbol = wrapped.slice(1, -1).toUpperCase();

    // Pure generic numeric pip.
    if (/^\d+$/.test(symbol)) {
      cost.generic += Number.parseInt(symbol, 10);
      continue;
    }

    // Single colored / colorless pip.
    if (SIMPLE_COLOR_SYMBOLS.has(symbol)) {
      cost[symbol as 'W' | 'U' | 'B' | 'R' | 'G' | 'C'] += 1;
      continue;
    }

    // Hybrid, Phyrexian, snow, X, and friends — keep verbatim, don't drop.
    cost.other.push(symbol);
  }

  return cost;
}

/** The em-dash (and hyphen fallback) Scryfall uses to separate types/subtypes. */
const TYPE_SUBTYPE_SEPARATOR = /\s[—-]\s/;

/**
 * MTG supertypes. Everything left of the dash that is one of these is a
 * supertype; the remaining left-of-dash words are card types.
 */
const SUPERTYPES: ReadonlySet<string> = new Set([
  'Basic',
  'Legendary',
  'Ongoing',
  'Snow',
  'World',
  'Host',
  'Elite',
]);

/**
 * Scryfall joins a double-faced card's two type lines with " // ", e.g.
 * "Creature — Minotaur Warrior // Land". That string is TWO type lines, not one.
 */
const FACE_SEPARATOR = ' // ';

/**
 * Parse a `type_line` (e.g. "Legendary Creature — Goblin Wizard") into
 * supertypes / types / subtypes.
 *
 * - Splits on the em-dash separating the type half from the subtype half.
 * - Words on the left that are known supertypes go to `supertypes`; the rest
 *   are `types`.
 * - Words on the right are `subtypes`.
 *
 * ⚠️ A COMBINED double-faced line describes the FRONT face only (§3.64). Every
 * other card-level field is already the front face's — `power`, `toughness`,
 * `oracleText` all read `raw.X ?? frontFace.X` — and each back face carries its
 * own clean `type_line` in `faces[]`, so this is the reading that makes the card
 * level self-consistent rather than the one that loses data.
 *
 * Parsing the whole string put a literal "//" into the results and filed the
 * back face's words under the front's: every one of the pool's 50 DFCs was
 * affected, and "Creature — Minotaur Warrior // Land" claimed *Land* as a
 * SUBTYPE of a creature — which any rule matching on subtypes would believe.
 *
 * Tolerant of missing dash (no subtypes) and empty input (→ all empty).
 */
export function parseTypeLine(typeLine: string | undefined | null): ParsedTypeLine {
  const parsed: ParsedTypeLine = { supertypes: [], types: [], subtypes: [] };
  if (!typeLine || !typeLine.trim()) return parsed;

  const frontFace = typeLine.split(FACE_SEPARATOR)[0] as string;
  const [leftPart, rightPart] = frontFace.split(TYPE_SUBTYPE_SEPARATOR);

  const leftWords = (leftPart ?? '').trim().split(/\s+/).filter(Boolean);
  for (const word of leftWords) {
    if (SUPERTYPES.has(word)) {
      parsed.supertypes.push(word);
    } else {
      parsed.types.push(word);
    }
  }

  if (rightPart) {
    parsed.subtypes = rightPart.trim().split(/\s+/).filter(Boolean);
  }

  return parsed;
}

/**
 * Parse a Scryfall power/toughness string into a number, or `null`.
 *
 * P/T can be absent (non-creatures), or non-numeric (`*`, `1+*`, `X`). Those
 * variable values are intentionally `null` — callers treat them as "not a fixed
 * number" rather than guessing a value.
 */
export function parseStat(stat: string | undefined | null): number | null {
  if (stat === undefined || stat === null || stat === '') return null;
  const value = Number.parseInt(stat, 10);
  // Reject `*`, `1+*`, `X`, etc. (NaN), but allow plain integers incl. 0.
  if (Number.isNaN(value) || !/^-?\d+$/.test(stat.trim())) return null;
  return value;
}
