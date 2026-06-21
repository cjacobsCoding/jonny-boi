/**
 * Creature stat derivation. Power/toughness come from the card definition plus
 * runtime modifiers (currently +1/+1 counters). Kept pure so combat and SBAs read
 * the same numbers. Adding new modifier sources (static buffs, etc.) happens here.
 */

import type { CardInstance } from '../state.js';

/** Counter kind for the standard +1/+1 counter. */
export const PLUS_ONE_COUNTER = '+1/+1';

/** Effective power including counters. */
export function effectivePower(inst: CardInstance): number {
  const base = inst.def.power ?? 0;
  const plus = inst.counters[PLUS_ONE_COUNTER] ?? 0;
  return base + plus;
}

/** Effective toughness including counters. */
export function effectiveToughness(inst: CardInstance): number {
  const base = inst.def.toughness ?? 0;
  const plus = inst.counters[PLUS_ONE_COUNTER] ?? 0;
  return base + plus;
}

/** Remaining toughness after marked damage (≤ 0 means lethal). */
export function remainingToughness(inst: CardInstance): number {
  return effectiveToughness(inst) - inst.damageMarked;
}
