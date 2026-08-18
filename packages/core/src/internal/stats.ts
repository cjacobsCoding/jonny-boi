/**
/**
 * Creature stat derivation. Effective power/toughness and keywords come from the
 * card definition's printed base, plus runtime modifiers, applied in this order:
 *   1. printed base (def.power / def.toughness / def.keywords)
 *   2. +1/+1 counters (a permanent per-object modifier)
 *   3. modifications radiating from permanents on the battlefield — the Aura /
 *      Equipment attached to this one, and static "anthem" abilities
 *   4. until-end-of-turn continuous effects (pumps / keyword grants)
 *
 * Layers 3 and 4 arrive here PRE-AGGREGATED as a single `AggregatedMod`, built by
 * internal/continuous.ts — they are both additive (P/T sums) and idempotent (keyword
 * ORs), so folding them together loses nothing and there is exactly one layering
 * path in the codebase rather than one per lifetime. All four layers therefore
 * combine: a 1/1 with a +1/+1 counter, wearing a +2/+0 Equipment, under a +1/+1
 * anthem, given +2/+2 until end of turn, is a 7/5 — and it drops back a step at a
 * time as the pump expires, the anthem leaves play, and the Equipment is unequipped.
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
 * Counter kind for loyalty counters — a planeswalker's "life total". Stored in the
 * same generic `CardInstance.counters` record as +1/+1 counters (they ARE counters,
 * CR 306.5b), so cloning, serialization and the inspector all carry them for free.
 */
export const LOYALTY_COUNTER = 'loyalty';

/**
 * A planeswalker's current loyalty. Zero for anything that is not carrying loyalty
 * counters — including a non-planeswalker, so callers gate on the card type, not
 * on this returning 0.
 */
export function loyaltyOf(inst: CardInstance): number {
  return inst.counters[LOYALTY_COUNTER] ?? 0;
}

/**
 * Remove `amount` loyalty from a walker (damage, a minus ability), never below
 * zero — there is no such thing as negative loyalty (CR 118.5). Returns how many
 * counters actually left. Honors the counters replace-don't-mutate contract.
 */
export function removeLoyalty(inst: CardInstance, amount: number): number {
  const current = inst.counters[LOYALTY_COUNTER] ?? 0;
  const removed = Math.min(Math.max(amount, 0), current);
  if (removed === 0) return 0;
  inst.counters = { ...inst.counters, [LOYALTY_COUNTER]: current - removed };
  return removed;
}

/** Add `amount` loyalty counters (a plus ability). Replace-don't-mutate. */
export function addLoyalty(inst: CardInstance, amount: number): void {
  if (amount <= 0) return;
  const current = inst.counters[LOYALTY_COUNTER] ?? 0;
  inst.counters = { ...inst.counters, [LOYALTY_COUNTER]: current + amount };
}

/**
 * Give a just-entered planeswalker its printed starting loyalty (CR 306.5b).
 * The ONE helper every battlefield-entry path calls — resolving the walker
 * spell, a token copy, a mid-resolution put — so "enters with its loyalty"
 * cannot be true on one path and false on another. A non-walker (or a walker
 * definition with no printed loyalty, which the compiler refuses to produce) is
 * left untouched.
 */
export function applyEnteringLoyalty(
  inst: CardInstance,
  emit: (e: import('../events.js').GameEvent) => void,
): void {
  const printed = inst.def.loyalty;
  if (printed === undefined || printed <= 0) return;
  if (!inst.def.types.includes('planeswalker')) return;
  inst.counters = { ...inst.counters, [LOYALTY_COUNTER]: printed };
  emit({ type: 'loyaltyChanged', instanceId: inst.instanceId, delta: printed, to: printed });
}

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
