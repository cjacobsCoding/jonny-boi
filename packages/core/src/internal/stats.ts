/**
/**
 * Creature stat derivation. Effective power/toughness and keywords come from the
 * card definition's base, plus runtime modifiers, applied in this order:
 *   1a. CHARACTERISTIC-DEFINING base (CR 613.3 layer 7a) — a `*` P/T box whose
 *      value is a formula over the game state (Tarmogoyf). It REPLACES the
 *      printed numbers rather than adding to them, and it is applied FIRST,
 *      before counters and before every pump, which is exactly where CR 613.10
 *      puts it. It reaches this function as `AggregatedMod.basePower` /
 *      `baseToughness`, computed by internal/continuous.ts — the layer that has
 *      the state a formula needs.
 *   1b. printed base (def.power / def.toughness / def.keywords), used whenever
 *      no characteristic-defining value was supplied.
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

import type { ActivatedAbility } from '../card.js';
import type { CardInstance } from '../state.js';
import type { BlockerQuality, BlockRestriction, KeywordFlags } from '../card.js';
import { unionProtection } from '../card.js';
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
 * Counter kind for defense counters — a battle's "life total" (CR 310.4). Stored
 * in the same generic `CardInstance.counters` record as loyalty, and for the same
 * reason: they ARE counters, so cloning, serialization and the inspector carry
 * them for free.
 */
export const DEFENSE_COUNTER = 'defense';

/**
 * A battle's current defense. Zero for anything not carrying defense counters —
 * including a non-battle, so callers gate on the card type, not on this
 * returning 0.
 */
export function defenseOf(inst: CardInstance): number {
  return inst.counters[DEFENSE_COUNTER] ?? 0;
}

/**
 * Remove `amount` defense counters from a battle (damage — CR 120.3d), never
 * below zero. Returns how many counters actually left. Honors the counters
 * replace-don't-mutate contract.
 */
export function removeDefense(inst: CardInstance, amount: number): number {
  const current = inst.counters[DEFENSE_COUNTER] ?? 0;
  const removed = Math.min(Math.max(amount, 0), current);
  if (removed === 0) return 0;
  inst.counters = { ...inst.counters, [DEFENSE_COUNTER]: current - removed };
  return removed;
}

/**
 * Give a just-entered battle its printed starting defense (CR 310.4). The ONE
 * helper every battlefield-entry path calls, exactly like
 * {@link applyEnteringLoyalty} — so "enters with its defense" cannot be true on
 * one path and false on another. A non-battle (or a battle definition with no
 * printed defense, which the compiler refuses to produce) is left untouched.
 */
export function applyEnteringDefense(
  inst: CardInstance,
  emit: (e: import('../events.js').GameEvent) => void,
): void {
  const printed = inst.def.defense;
  if (printed === undefined || printed <= 0) return;
  if (!inst.def.types.includes('battle')) return;
  inst.counters = { ...inst.counters, [DEFENSE_COUNTER]: printed };
  emit({ type: 'defenseChanged', instanceId: inst.instanceId, delta: printed, to: printed });
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

/**
 * Effective power: base (layer 7a formula, else printed) + counters + deltas.
 *
 * ⚠️ A CHARACTERISTIC-DEFINING creature read with NO `mod` answers 0, because a
 * `*` box is a function of the whole game and this accessor is given only the
 * instance. That is the same documented limit the module header states for the
 * bare call ("correct only where no modification can apply"), and every RULES
 * path — combat, state-based actions, the damage/fight primitives, serialization
 * — passes an aggregate built by `indexContinuous`/`aggregateFor`, which supply
 * the formula's value. Pass one whenever a `*` creature could be on the board.
 */
export function effectivePower(inst: CardInstance, mod: AggregatedMod = NO_MOD): number {
  const base = mod.basePower ?? inst.def.power ?? 0;
  return base + counterShift(inst) + mod.power;
}

/** Effective toughness: base (layer 7a formula, else printed) + counters + deltas. */
export function effectiveToughness(inst: CardInstance, mod: AggregatedMod = NO_MOD): number {
  const base = mod.baseToughness ?? inst.def.toughness ?? 0;
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
/**
 * The activated abilities a permanent HAS right now — its printed ones plus any
 * a continuous effect granted it (an Aura's quoted ability, "All Slivers have
 * …", Cryptolith Rite).
 *
 * ONE accessor, read by the ability OFFER path and by the ability APPLY path,
 * because `ActivateAbilityAction.abilityIndex` indexes exactly this list — two
 * readers with different ideas of what index 1 means is the shape that
 * activates the wrong ability. PRINTED FIRST, then granted, so an index a
 * player is looking at does not shift when an unrelated grant appears.
 *
 * Returns the printed array itself when nothing was granted, which is every
 * permanent on almost every board — no allocation on the hot path.
 */
export function effectiveActivated(
  inst: CardInstance,
  mod: AggregatedMod = NO_MOD,
): readonly ActivatedAbility[] {
  const printed = inst.def.activated ?? NO_ACTIVATED;
  const granted = mod.activated;
  if (granted === undefined || granted.length === 0) return printed;
  return [...printed, ...granted];
}

/** Shared empty list so a definition with no activated abilities allocates nothing. */
const NO_ACTIVATED: readonly ActivatedAbility[] = Object.freeze([]);

export function effectiveKeywords(inst: CardInstance, mod: AggregatedMod = NO_MOD): KeywordFlags {
  const printed = inst.def.keywords;
  const granted = mod.keywords;
  // Fast path: nothing granted → return the printed set (or empty) directly.
  if (!granted || isEmptyKeywords(granted)) return printed ?? {};
  return mergeKeywordGrant(printed ?? {}, granted);
}

/**
 * Fold a keyword GRANT onto a base keyword set. Boolean flags OR together (a
 * grant can set a flag, never clear one). The three non-boolean keywords carry
 * payloads and merge by their own rules, defined once here and reused by the
 * continuous layer's aggregation:
 *   - `protectionFrom` lists UNION (protection from red plus a granted
 *     protection from white is protection from both);
 *   - `ward` costs ADD (two ward abilities charge the sum — paying both);
 *   - `minBlockers` takes the MAXIMUM. Two blocking requirements are both in
 *     force at once, so the one that is harder to satisfy is the one that
 *     decides — adding them would invent a restriction neither card printed.
 *   - `blockRestriction` merges FIELD BY FIELD, taking the strictest of each —
 *     the same "both are in force" argument as `minBlockers`, applied to a
 *     record instead of a number.
 */
export function mergeKeywordGrant(base: KeywordFlags, granted: KeywordFlags): KeywordFlags {
  const out: Record<string, unknown> = { ...base };
  for (const key in granted) {
    const value = (granted as Record<string, unknown>)[key];
    if (key === 'protectionFrom') {
      const merged = unionProtection(base.protectionFrom, value as KeywordFlags['protectionFrom']);
      if (merged !== undefined) out[key] = merged;
    } else if (key === 'ward') {
      const grantedWard = typeof value === 'number' && value > 0 ? value : 0;
      if (grantedWard > 0) out[key] = (base.ward ?? 0) + grantedWard;
    } else if (key === 'minBlockers') {
      const grantedMin = typeof value === 'number' && value > 0 ? value : 0;
      if (grantedMin > 0) out[key] = Math.max(base.minBlockers ?? 0, grantedMin);
    } else if (key === 'blockRestriction') {
      const merged = intersectBlockRestrictions(base.blockRestriction, value as BlockRestriction | undefined);
      if (merged !== undefined) out[key] = merged;
    } else if (value === true) {
      out[key] = true;
    }
  }
  return out as KeywordFlags;
}

/**
 * Fold two block restrictions into the one that holds when BOTH are printed.
 *
 * Every bound takes its strictest value and the required-keyword lists CONCATENATE
 * — a blocker must satisfy each printed "except by …" clause, so a creature must
 * carry one keyword from every list, not one from their union. Merging them into a
 * single list would let a hasty non-flier through a card that demanded both.
 *
 * Returns `undefined` only when neither side restricts anything, so a caller can
 * skip writing the field at all.
 */
export function intersectBlockRestrictions(
  base: BlockRestriction | undefined,
  granted: BlockRestriction | undefined,
): BlockRestriction | undefined {
  if (!base) return granted;
  if (!granted) return base;
  const keywordLists = [
    ...(base.blockerMustHaveAnyOf ? [base.blockerMustHaveAnyOf] : []),
    ...(granted.blockerMustHaveAnyOf ? [granted.blockerMustHaveAnyOf] : []),
  ];
  // The same reasoning for the QUALITY lists (fear/intimidate): intersecting the
  // qualities is the strictest thing one list can say about two demands. Compared
  // structurally, since these are objects rather than names.
  const qualityLists = [
    ...(base.blockerMustMatchAnyOf ? [base.blockerMustMatchAnyOf] : []),
    ...(granted.blockerMustMatchAnyOf ? [granted.blockerMustMatchAnyOf] : []),
  ];
  const sameQuality = (a: BlockerQuality, b: BlockerQuality) =>
    a.kind === b.kind && (a.kind !== 'color' || a.color === (b as { color: unknown }).color);
  return {
    // Two "except by" clauses are two independent demands. Only when exactly one
    // side prints one is the answer a single list; when both do, the stricter
    // reading is "satisfy both", which this shape cannot express as one list — so
    // the merge keeps them apart by intersecting the NAMES, which is the strictest
    // thing one list can say.
    ...(keywordLists.length > 0
      ? { blockerMustHaveAnyOf: keywordLists.reduce((a, b) => a.filter((k) => b.includes(k))) }
      : {}),
    ...(qualityLists.length > 0
      ? {
          blockerMustMatchAnyOf: qualityLists.reduce((a, b) =>
            a.filter((quality) => b.some((other) => sameQuality(quality, other))),
          ),
        }
      : {}),
    ...(minDefined(base.maxBlockerPower, granted.maxBlockerPower) !== undefined
      ? { maxBlockerPower: minDefined(base.maxBlockerPower, granted.maxBlockerPower) as number }
      : {}),
    ...(minDefined(base.maxBlockerToughness, granted.maxBlockerToughness) !== undefined
      ? { maxBlockerToughness: minDefined(base.maxBlockerToughness, granted.maxBlockerToughness) as number }
      : {}),
    ...(maxDefined(base.minBlockerPower, granted.minBlockerPower) !== undefined
      ? { minBlockerPower: maxDefined(base.minBlockerPower, granted.minBlockerPower) as number }
      : {}),
    ...(maxDefined(base.minBlockerToughness, granted.minBlockerToughness) !== undefined
      ? { minBlockerToughness: maxDefined(base.minBlockerToughness, granted.minBlockerToughness) as number }
      : {}),
    ...(base.blockerPowerAtMostMine || granted.blockerPowerAtMostMine
      ? { blockerPowerAtMostMine: true }
      : {}),
  };
}

/** The smaller of two optional bounds (either may be absent = no bound). */
function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** The larger of two optional bounds (either may be absent = no bound). */
function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
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
