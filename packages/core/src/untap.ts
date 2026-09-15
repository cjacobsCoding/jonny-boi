/**
 * THE UNTAP STEP'S ONE QUESTION (CR 302.6, CR 514-adjacent) — "does this
 * permanent untap right now?"
 *
 * ## Why this is a file and not two `if`s in the untap loop
 * Magic prints the does-not-untap effect in two shapes with two different
 * LIFETIMES, and they are genuinely different mechanisms:
 *
 *  1. **Continuous** — "~ doesn't untap during your untap step" (Basalt
 *     Monolith), "Enchanted creature doesn't untap during its controller's
 *     untap step" (Waterknot), "Equipped creature doesn't untap…" (Cement
 *     Shoes). This lasts exactly as long as its SOURCE, so it is a keyword flag
 *     ({@link KeywordFlags.doesNotUntap}) folded by the continuous layer, and
 *     destroying the Aura ends it with nothing to clean up.
 *  2. **One-shot** — "it doesn't untap during its controller's NEXT untap step"
 *     (Frost Trickster, Tamiyo's +1), "next TWO untap steps" (Telekinesis).
 *     This OUTLIVES its source and expires by being SPENT, so it is a stored
 *     count ({@link CardInstance.untapSkips}).
 *
 * Two mechanisms is the honest model. Two ANSWERS would not be: the untap step
 * would have to remember to ask both, and the next reader (a pilot deciding
 * whether a land will be available next turn, the inspector, a "untap all
 * permanents you control" effect) would ask one of them and be wrong. So the
 * mechanisms stay separate and the QUESTION is asked in exactly one place —
 * rule 12, one answer to one question.
 *
 * ## Spending is the untap step's job, and only the untap step's
 * {@link spendUntapSkip} is the ONLY writer that reduces the count. It is called
 * by the untap step for the permanents it considered, whether or not they were
 * tapped: a freeze is spent by the untap step HAPPENING, not by a tapped
 * permanent failing to untap. An untapped Frost Trickster victim that would
 * otherwise have kept its skip forever is the bug this paragraph prevents.
 */

import { effectiveKeywords } from './internal/stats.js';
import { aggregateFor } from './internal/continuous.js';
import type { CardInstance, GameState } from './state.js';

/**
 * Whether `inst` untaps during its controller's untap step right now.
 *
 * Asks the CONTINUOUS half through the ordinary continuous index — so an
 * anthem-shaped grant from an Aura, an Equipment or the permanent's own static
 * all arrive by the same route — and the ONE-SHOT half off the instance.
 *
 * PERF: the aggregate walk is only reached when the permanent carries no stored
 * skip, and the untap step runs once per turn over one player's permanents. It
 * is not on the continuous-layering path, combat, or the mana planner.
 */
export function untapsDuringUntapStep(state: GameState, inst: CardInstance): boolean {
  if ((inst.untapSkips ?? 0) > 0) return false;
  return effectiveKeywords(inst, aggregateFor(state, inst.instanceId)).doesNotUntap !== true;
}

/**
 * Spend one of `inst`'s stored untap skips, if it has any. The untap step's own
 * bookkeeping — see the file header for why it is spent by the STEP happening
 * rather than by an untap being refused.
 *
 * Deletes the field at zero rather than leaving a `0` behind, so an instance
 * that is no longer frozen goes back to the object shape every other instance
 * has and `cloneInstance` stops copying it.
 */
export function spendUntapSkip(inst: CardInstance): void {
  const left = inst.untapSkips ?? 0;
  if (left <= 0) return;
  if (left === 1) delete inst.untapSkips;
  else inst.untapSkips = left - 1;
}

/**
 * Freeze `inst` for its controller's next `count` untap steps — the one-shot
 * half's only writer that INCREASES the count.
 *
 * Skips ACCUMULATE (two Frost Tricksters aimed at one creature really do cost it
 * two untap steps), for the same reason ward costs add: both effects are in
 * force and neither replaces the other. A non-positive count is a no-op rather
 * than a silent freeze of zero turns.
 */
export function addUntapSkips(inst: CardInstance, count: number): void {
  if (!Number.isFinite(count) || count <= 0) return;
  inst.untapSkips = (inst.untapSkips ?? 0) + Math.floor(count);
}
