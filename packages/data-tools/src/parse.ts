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
  if (!manaCost) return cost;

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
 * Parse a `type_line` (e.g. "Legendary Creature — Goblin Wizard") into
 * supertypes / types / subtypes.
 *
 * - Splits on the em-dash separating the type half from the subtype half.
 * - Words on the left that are known supertypes go to `supertypes`; the rest
 *   are `types`.
 * - Words on the right are `subtypes`.
 *
 * Tolerant of missing dash (no subtypes) and empty input (→ all empty).
 */
export function parseTypeLine(typeLine: string | undefined | null): ParsedTypeLine {
  const parsed: ParsedTypeLine = { supertypes: [], types: [], subtypes: [] };
  if (!typeLine || !typeLine.trim()) return parsed;

  const [leftPart, rightPart] = typeLine.split(TYPE_SUBTYPE_SEPARATOR);

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
