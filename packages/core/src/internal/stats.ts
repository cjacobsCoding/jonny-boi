/**
/**
 * Creature stat derivation. Effective power/toughness and keywords come from the
 * card definition's printed base, plus runtime modifiers, applied in this order:
 *   1. printed base (def.power / def.toughness / def.keywords)
 *   2. +1/+1 counters (a permanent per-object modifier)
 *   3. static "anthem" abilities radiating from permanents on the battlefield
 *   4. until-end-of-turn continuous effects (pumps / keyword grants)
 *
 * Layers 3 and 4 arrive here PRE-AGGREGATED as a single `AggregatedMod`, built by
 * internal/continuous.ts — they are both additive (P/T sums) and idempotent (keyword
 * ORs), so folding them together loses nothing and there is exactly one layering
 * path in the codebase rather than one per lifetime. All four layers therefore
 * combine: a 1/1 with a +1/+1 counter, under a +1/+1 anthem, given +2/+2 until end
 * of turn, is a 5/5, and it becomes a 3/3 again when the pump expires and a 2/2 the
 * moment the anthem leaves play.
 *
 * Kept pure so combat, SBAs, legality checks and serialization all read the same
 * numbers. The aggregate is passed explicitly (defaulting to "no modification")
 * rather than read from a global, so a caller that already has the per-instance
 * aggregate pays O(1) — and a caller that passes nothing gets base+counters, which
 * is correct only where no modification can apply.
 */

import type { CardInstance } from '../state.js';
import type { KeywordFlags } from '../card.js';
import type { AggregatedMod } from './continuous.js';
import { NO_MOD } from './continuous.js';

/** Counter kind for the standard +1/+1 counter. */
export const PLUS_ONE_COUNTER = '+1/+1';

/** Counter kind for the standard -1/-1 counter. */
export const MINUS_ONE_COUNTER = '-1/-1';

/**
 * Net power/toughness shift from counters on a permanent.
 *
 * Both standard kinds are read here. `-1/-1` used to be stored as a NEGATIVE
 * `+1/+1` because the stat layer looked at one key, which works for arithmetic
 * but is not what the card says: nothing could ask "does this have a -1/-1
 * counter on it?", and a card that puts a -1/-1 counter on a creature already
 * carrying a +1/+1 counter has to ANNIHILATE the pair (CR 704.5q), which a single
 * signed number silently pre-collapses.
 *
 * Counting them separately keeps the arithmetic identical while letting the two
 * kinds exist as distinct, inspectable state.
 */
function counterShift(inst: CardInstance): number {
  return (inst.counters[PLUS_ONE_COUNTER] ?? 0) - (inst.counters[MINUS_ONE_COUNTER] ?? 0);
}

/** Effective power: base + counters + continuous power delta. */
export function effectivePower(inst: CardInstance, mod: AggregatedMod = NO_MOD): number {
  const base = inst.def.power ?? 0;
  return base + counterShift(inst) + mod.power;
}

/** Effective toughness: base + counters + continuous toughness delta. */
export function effectiveToughness(inst: CardInstance, mod: AggregatedMod = NO_MOD): number {
  const base = inst.def.toughness ?? 0;
  return base + counterShift(inst) + mod.toughness;
}

/** Remaining toughness after marked damage (≤ 0 means lethal). */
export function remainingToughness(inst: CardInstance, mod: AggregatedMod = NO_MOD): number {
  return effectiveToughness(inst, mod) - inst.damageMarked;
}

/**
 * Effective keyword set: the printed keywords OR-ed with any granted by continuous
 * effects.
 *
 * The result is READ-ONLY and must never be mutated: with nothing granted this is
 * the definition's own (shared, immutable) keyword object, returned as-is because
 * this runs for every creature in every combat/legality pass and allocating a copy
 * there is pure waste. `KeywordFlags` is declared readonly for exactly that reason.
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
