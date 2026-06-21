/**
 * Creature stat derivation. Effective power/toughness and keywords come from the
 * card definition's printed base, plus runtime modifiers, applied in this order:
 *   1. printed base (def.power / def.toughness / def.keywords)
 *   2. +1/+1 counters (a permanent per-object modifier)
 *   3. continuous effects (temporary "until end of turn" pumps / keyword grants —
 *      see internal/continuous.ts), passed in as an `AggregatedMod`.
 *
 * Kept pure so combat, SBAs, and serialization all read the same numbers. The
 * continuous layer is passed explicitly (defaulting to "no modification") rather
 * than read from a global, so a caller that already has the per-instance aggregate
 * pays O(1) and a caller that doesn't gets correct base+counter values for free.
 */

import type { CardInstance } from '../state.js';
import type { KeywordFlags } from '../card.js';
import type { AggregatedMod } from './continuous.js';
import { NO_MOD } from './continuous.js';

/** Counter kind for the standard +1/+1 counter. */
export const PLUS_ONE_COUNTER = '+1/+1';

/** Effective power: base + counters + continuous power delta. */
export function effectivePower(inst: CardInstance, mod: AggregatedMod = NO_MOD): number {
  const base = inst.def.power ?? 0;
  const plus = inst.counters[PLUS_ONE_COUNTER] ?? 0;
  return base + plus + mod.power;
}

/** Effective toughness: base + counters + continuous toughness delta. */
export function effectiveToughness(inst: CardInstance, mod: AggregatedMod = NO_MOD): number {
  const base = inst.def.toughness ?? 0;
  const plus = inst.counters[PLUS_ONE_COUNTER] ?? 0;
  return base + plus + mod.toughness;
}

/** Remaining toughness after marked damage (≤ 0 means lethal). */
export function remainingToughness(inst: CardInstance, mod: AggregatedMod = NO_MOD): number {
  return effectiveToughness(inst, mod) - inst.damageMarked;
}

/**
 * Effective keyword set: the printed keywords OR-ed with any granted by continuous
 * effects. Returns a fresh object so callers never mutate the def or an aggregate.
 */
export function effectiveKeywords(inst: CardInstance, mod: AggregatedMod = NO_MOD): KeywordFlags {
  const printed = inst.def.keywords;
  const granted = mod.keywords;
  // Fast path: nothing granted → return the printed set (or empty) directly.
  if (!granted || isEmptyKeywords(granted)) return printed ?? {};
  return { ...(printed ?? {}), ...onlyTrue(granted) };
}

/** Whether a creature effectively has a given keyword (base or granted). */
export function hasKeyword(inst: CardInstance, keyword: keyof KeywordFlags, mod: AggregatedMod = NO_MOD): boolean {
  return Boolean(effectiveKeywords(inst, mod)[keyword]);
}

function isEmptyKeywords(k: KeywordFlags): boolean {
  for (const key in k) {
    if ((k as Record<string, unknown>)[key]) return false;
  }
  return true;
}

/** A copy of `k` keeping only the flags set to true (so OR-merge never un-sets one). */
function onlyTrue(k: KeywordFlags): KeywordFlags {
  const out: Record<string, boolean> = {};
  for (const key in k) {
    if ((k as Record<string, unknown>)[key]) out[key] = true;
  }
  return out as KeywordFlags;
}
