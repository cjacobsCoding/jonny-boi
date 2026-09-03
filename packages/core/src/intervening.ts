/**
 * INTERVENING "IF" — the printed clause between a trigger's event and its body
 * ("at the beginning of your upkeep, **if you control three or more artifacts**,
 * you gain 1 life").
 *
 * It is a property of the trigger CONDITION rather than of the body, because
 * CR 603.4 checks it **twice**:
 *
 *   1. when the ability would trigger — a false condition means it never goes on
 *      the stack at all, so nothing can respond to it and nothing counting stack
 *      objects sees it; and
 *   2. as the ability RESOLVES — a condition that has stopped holding removes the
 *      ability from the stack and it does nothing.
 *
 * Modelling it as an `if` wrapper inside the effects would implement only the
 * second check, and a card whose trigger goes on the stack when it should not is
 * a different card: an opponent gets a window they should not have, and any
 * "whenever an ability triggers" reader would count it.
 *
 * The vocabulary is deliberately CLOSED and small. A printed condition this file
 * cannot express must make its card report `incomplete` — never compile to a
 * condition that is merely close, and never to one that is silently always true.
 */

import type { CardFilter } from './choices.js';
import { matchesCardFilter } from './choices.js';
import type { GameState, InstanceId, PlayerId } from './state.js';
import { aggregateFor } from './internal/continuous.js';
import { effectivePower } from './internal/stats.js';
import { cameUnderControlSinceLastUpkeep } from './upkeep-costs.js';

/**
 * A condition the engine can decide from the board alone.
 *
 * `sourceUntapped` — "**if this artifact is untapped**" (Howling Mine). Read off
 * the source permanent; a source that has left the battlefield is not untapped,
 * so the condition fails rather than defaulting to true.
 *
 * `controlCount` — "**if you control three or more artifacts**", "if you control
 * no Snakes", "if you control a creature with power 4 or greater". `filter`
 * narrows by PRINTED characteristics (types, subtypes, colours) through the same
 * {@link CardFilter} every other filtered thing in the engine reads; `minPower`
 * is separate because it must be read as **effective** power — a creature is
 * "power 4 or greater" because of its counters and anthems, not because of the
 * number in its box. `min`/`max` bound the resulting COUNT (`max: 0` is the
 * printed word "no").
 */
export type InterveningIf =
  | { readonly kind: 'sourceUntapped' }
  /**
   * "**if it was kicked**" (Skyclave Relic's ETB). Read off the source
   * permanent's `timesKicked`, which the kicked entry wrote for exactly this
   * reader; a source that has left the battlefield, or that entered unkicked,
   * fails the condition rather than defaulting to true.
   */
  | { readonly kind: 'sourceKicked' }
  /**
   * §3.106 — ECHO's "**if this permanent came under your control since the
   * beginning of your last upkeep**" (CR 702.30a). Read off the source's
   * `controlledSinceTurn` stamp (upkeep-costs.ts), which the entry and
   * control-change funnels write for exactly this reader; a source that has
   * left the battlefield, or that carries no stamp, fails the condition rather
   * than defaulting to true.
   */
  | { readonly kind: 'sourceControlledSinceLastUpkeep' }
  /**
   * §3.106 — VANISHING's "**if this permanent has a time counter on it**"
   * (CR 702.63a). Generic over the counter kind so fading and any future
   * "if ~ has a [kind] counter on it" read the same case.
   */
  | { readonly kind: 'sourceHasCounter'; readonly counter: string }
  | {
      readonly kind: 'controlCount';
      /** Whose permanents are counted. `'triggering'` is the player the event was about. */
      readonly who?: 'you' | 'triggering';
      readonly filter?: CardFilter;
      /** Effective-power floor applied on top of {@link filter}. */
      readonly minPower?: number;
      /** Inclusive bounds on the count. Absent ⇒ unbounded on that side. */
      readonly min?: number;
      readonly max?: number;
    };

/**
 * Whether a trigger's intervening "if" holds RIGHT NOW.
 *
 * Called at both of CR 603.4's moments from two different places (the trigger
 * collector, and the resolution of the ability off the stack) — one evaluator so
 * the two checks cannot answer differently.
 *
 * An absent condition holds, which is what every trigger without one means.
 */
export function interveningIfHolds(
  state: GameState,
  condition: InterveningIf | undefined,
  sourceInstanceId: InstanceId,
  controller: PlayerId,
  triggeringPlayer?: PlayerId,
): boolean {
  if (condition === undefined) return true;
  switch (condition.kind) {
    case 'sourceKicked': {
      const battlefield = state.battlefield;
      for (let i = 0; i < battlefield.length; i++) {
        const permanent = battlefield[i]!;
        if (permanent.instanceId !== sourceInstanceId) continue;
        return (permanent.timesKicked ?? 0) > 0;
      }
      return false;
    }
    // §3.106 — the two source-reading conditions of the upkeep-cost family.
    case 'sourceControlledSinceLastUpkeep': {
      const battlefield = state.battlefield;
      for (let i = 0; i < battlefield.length; i++) {
        const permanent = battlefield[i]!;
        if (permanent.instanceId !== sourceInstanceId) continue;
        return cameUnderControlSinceLastUpkeep(state, permanent);
      }
      return false;
    }
    case 'sourceHasCounter': {
      const battlefield = state.battlefield;
      for (let i = 0; i < battlefield.length; i++) {
        const permanent = battlefield[i]!;
        if (permanent.instanceId !== sourceInstanceId) continue;
        return (permanent.counters[condition.counter] ?? 0) > 0;
      }
      return false;
    }
    case 'sourceUntapped': {
      const battlefield = state.battlefield;
      for (let i = 0; i < battlefield.length; i++) {
        const perm = battlefield[i] as (typeof battlefield)[number];
        if (perm.instanceId === sourceInstanceId) return !perm.tapped;
      }
      // Off the battlefield entirely: "this artifact is untapped" is false, not
      // vacuously true. A destroyed Howling Mine stops drawing cards.
      return false;
    }
    case 'controlCount': {
      const who =
        condition.who === 'triggering' ? (triggeringPlayer ?? controller) : controller;
      const battlefield = state.battlefield;
      let count = 0;
      for (let i = 0; i < battlefield.length; i++) {
        const perm = battlefield[i] as (typeof battlefield)[number];
        if (perm.controller !== who) continue;
        if (!matchesCardFilter(perm, condition.filter)) continue;
        if (condition.minPower !== undefined) {
          // EFFECTIVE, not printed: counters and anthems are what make a
          // creature "power 4 or greater" on the board the player is looking at.
          if (effectivePower(perm, aggregateFor(state, perm.instanceId)) < condition.minPower) continue;
        }
        count += 1;
        // Nothing printed asks for the exact number, only for a bound, so the
        // walk can stop as soon as an upper bound is already broken.
        if (condition.max !== undefined && count > condition.max) return false;
      }
      if (condition.min !== undefined && count < condition.min) return false;
      if (condition.max !== undefined && count > condition.max) return false;
      return true;
    }
    default:
      // Unknown kind → does NOT hold. A condition the engine cannot read must
      // stop the trigger, never wave it through (rule 6: safe degradation is the
      // one that does less, not the one that does more).
      return false;
  }
}
