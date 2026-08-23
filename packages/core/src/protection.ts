/**
 * PROTECTION FROM [QUALITY] + WARD — the source-aware half of targeting legality.
 *
 * Protection is a bundle of four rules, every one keyed on a property of the
 * SOURCE (CR 702.16): a permanent with protection from [quality]
 *   1. can't be the TARGET of spells/abilities from sources with that quality
 *      (`targeting.ts` asks {@link protectionBlocksSource});
 *   2. can't be DEALT DAMAGE by sources with that quality — the damage is
 *      prevented (`internal/combat.ts` and the damage primitives ask
 *      {@link protectionPreventsDamage});
 *   3. can't be ENCHANTED or EQUIPPED by attachments with that quality
 *      (`attachments.ts` asks it inside `isLegalHost`, so the state-based
 *      actions knock an existing Aura off the moment protection is gained);
 *   4. can't be BLOCKED by creatures with that quality (`canBlock`).
 *
 * All four read the same two questions, defined ONCE here: "what qualities does
 * this source have?" and "does any of them fall under this protection list?" —
 * so the four halves cannot drift apart.
 *
 * ## What a source's COLOR is
 * The colors of its mana cost's colored pips, hybrid symbols included — exactly
 * the information a `CardDefinition` carries. The engine has no color
 * indicators and no color-changing effects, so this is the color of every card
 * it can represent, not an approximation of it.
 *
 * ## The conservative direction for an UNKNOWN source
 * Every checker takes the source definition as an optional argument, exactly
 * like `isLegalTarget`'s optional caster. When the source is absent a protected
 * permanent is treated as protected from it: being unable to aim is a safe
 * failure, while letting a spell through a protection the card really has would
 * play the card better than printed — the same reasoning hexproof documents.
 *
 * ## Ward
 * Ward is a triggered ability the ENGINE raises (the trigger fires on
 * "becomes the target of", a moment only the engine sees — it lives in
 * `applyCastSpell` / `applyActivateAbility` / the trigger-aim path). What goes
 * on the stack is an ordinary trigger stack object whose one effect is the
 * reserved primitive {@link WARD_COUNTER_PRIMITIVE}. Core reserves the ID as a
 * seam convention (the same shape as `TARGET_RESTRICTION_PARAM`); the `cards`
 * package registers the implementation, which asks the targeting player to pay
 * through the existing `payMana` optional-payment machinery and counters the
 * spell/ability if they decline. In a registry without it the trigger degrades
 * to `effectUnsupported` — a safe no-op, never a crash.
 */

import type { CardDefinition, ProtectionQuality } from './card.js';
import { colorsOfDefinition } from './card.js';
import type { CardInstance, GameState } from './state.js';
import type { ManaColor } from './mana.js';
import { effectiveKeywords } from './internal/stats.js';
import { aggregateFor, anyContinuousModification } from './internal/continuous.js';

// `colorsOfDefinition` moved to card.ts (the shared `CardFilter` needs it too,
// and choices.ts importing this module would cycle through the continuous
// layer). Re-exported here so existing import sites keep working.
export { colorsOfDefinition } from './card.js';

/**
 * The effect-primitive id reserved for the ward counter — "counter the targeted
 * spell or ability unless its controller pays the ward cost". Core pushes ward
 * triggers referencing this id; `cards` registers the implementation.
 */
export const WARD_COUNTER_PRIMITIVE = 'wardCounterUnlessPaid';

/** The param name carrying the ward cost on a {@link WARD_COUNTER_PRIMITIVE} ref. */
export const WARD_COST_PARAM = 'unlessPaid';

/** Every spellable protection quality, for validation at the data boundary. */
export const PROTECTION_QUALITIES: readonly ProtectionQuality[] = Object.freeze([
  'white',
  'blue',
  'black',
  'red',
  'green',
  'colorless',
  'multicolored',
  'artifacts',
  'creatures',
  'everything',
]);

/** Whether an arbitrary value names a protection quality. */
export function isProtectionQuality(value: unknown): value is ProtectionQuality {
  return typeof value === 'string' && (PROTECTION_QUALITIES as readonly string[]).includes(value);
}

/** Color-word qualities mapped to the mana pip that makes a source that color. */
const QUALITY_COLOR_PIPS: Readonly<Partial<Record<ProtectionQuality, ManaColor>>> = Object.freeze({
  white: 'W',
  blue: 'U',
  black: 'B',
  red: 'R',
  green: 'G',
});

/** Whether `source` has `quality` — the one definition of every quality word. */
export function sourceHasQuality(source: CardDefinition, quality: ProtectionQuality): boolean {
  switch (quality) {
    case 'everything':
      return true;
    case 'colorless':
      return colorsOfDefinition(source).length === 0;
    case 'multicolored':
      return colorsOfDefinition(source).length >= 2;
    case 'artifacts':
      return source.types.includes('artifact');
    case 'creatures':
      return source.types.includes('creature');
    default: {
      const pip = QUALITY_COLOR_PIPS[quality];
      return pip !== undefined && colorsOfDefinition(source).includes(pip);
    }
  }
}

/**
 * Whether a protection list blocks `source`. An absent/empty list blocks
 * nothing; an absent SOURCE with a non-empty list blocks conservatively (see
 * the module note — an unverifiable source must not slip through).
 */
export function protectionBlocksSource(
  protection: readonly ProtectionQuality[] | undefined,
  source: CardDefinition | undefined,
): boolean {
  if (protection === undefined || protection.length === 0) return false;
  if (source === undefined) return true;
  for (const quality of protection) {
    if (sourceHasQuality(source, quality)) return true;
  }
  return false;
}

/**
 * The protection list `permanent` currently has, granted qualities included.
 *
 * Same fast-path shape as `isTargetableBy`: when nothing on the board can modify
 * a keyword the printed list is the answer, and the aggregation is built only
 * when a grant could exist.
 *
 * ⚠️ The gate is {@link anyContinuousModification}, NOT `state.continuous.length`.
 * That list carries only until-end-of-turn effects; an Aura or Equipment granting
 * "protection from red" to its host, and an anthem or emblem granting it to a
 * team, are DERIVED from the battlefield and put nothing in it. Keying the fast
 * path on the list made every one of those grants invisible here — so an Aura the
 * gained protection should have knocked off (CR 704.5m) stayed on.
 */
export function effectiveProtectionOf(
  state: GameState,
  permanent: CardInstance,
): readonly ProtectionQuality[] | undefined {
  if (!anyContinuousModification(state)) return permanent.def.keywords?.protectionFrom;
  return effectiveKeywords(permanent, aggregateFor(state, permanent.instanceId)).protectionFrom;
}

/**
 * Whether damage from `source` to `permanent` is prevented by protection — the
 * "can't be dealt damage" half, shared by combat and the damage primitives.
 */
export function protectionPreventsDamage(
  state: GameState,
  permanent: CardInstance,
  source: CardDefinition | undefined,
): boolean {
  return protectionBlocksSource(effectiveProtectionOf(state, permanent), source);
}

/**
 * The ward cost `permanent` currently charges, granted ward included, as a
 * generic mana amount. Zero means "no ward". Additive across grants — paying
 * two ward abilities is paying both costs.
 */
export function effectiveWardOf(state: GameState, permanent: CardInstance): number {
  // Same gate, same reason, as `effectiveProtectionOf` — a granted ward that only
  // an Equipment or an anthem confers is still a ward the opponent has to pay.
  if (!anyContinuousModification(state)) return permanent.def.keywords?.ward ?? 0;
  return effectiveKeywords(permanent, aggregateFor(state, permanent.instanceId)).ward ?? 0;
}
