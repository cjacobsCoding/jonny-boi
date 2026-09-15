/**
 * LIFE GAIN'S ONE QUESTION (CR 118.3, CR 614) — "how much life does this player
 * actually gain right now?"
 *
 * ## Why this is a file and not a line inside each gainer
 * Magic gains life through two genuinely different mechanisms, and they live in
 * two different packages:
 *
 *  1. **A resolving effect** — "you gain 3 life" (Healing Salve), "gain life
 *     equal to that creature's toughness" (Trostani). This is an effect
 *     primitive, so it lives in `@jonny-boi/cards` and reaches a player through
 *     `effect-helpers.changeLife`.
 *  2. **LIFELINK** — CR 702.15b, "damage dealt by this creature also causes you
 *     to gain that much life". This happens on the COMBAT DAMAGE path inside
 *     core (`internal/damage-result.ts`), which cannot reach into a primitive.
 *
 * Two mechanisms is the honest model. Two ANSWERS would not be: Rhox Faithmender
 * says "if you would gain life, you gain twice that much life instead" and it
 * does not care which mechanism the life came from. A version of this question
 * answered separately at each site is a card that doubles a Healing Salve and
 * not a lifelinked attack — which is the shape of bug nobody finds, because both
 * halves look right on their own. So the mechanisms stay separate and the
 * QUESTION is asked in exactly one place — rule 12, one answer to one question.
 *
 * This is deliberately the same shape as `untap.ts`, for the same reason and
 * with the same precedent: a pure function that ANSWERS, leaving each site to
 * perform its own mutation and emit its own events.
 *
 * ## Gain only, and the asymmetry is the card's, not ours
 * Life LOSS does not come through here. CR 118.3 keeps gaining and losing apart,
 * `triggers.ts` keeps them apart for the same reason ("a card that fired on both
 * directions is a different card"), and core's layer watches no `lifeloss`
 * event — §3.151 measured that population and reports it rather than folding it
 * in. Paying life as a COST (CR 118.4) is not losing life to an effect at all,
 * and never was a candidate.
 *
 * ## Zero is a real answer, and the caller must honour it
 * "That player gains no life instead" (Sulfuric Vortex) returns 0. CR 118.5:
 * an event that gains no life is NOT a life-gain event, so a caller that gets 0
 * must emit no `gainLife` and no `lifeChanged` — otherwise "whenever you gain
 * life" fires on a gain that did not happen. {@link gainLifeAmount} returning 0
 * is the signal; each site's `if (gained <= 0) return` is the honouring.
 */

import type { GameState, PlayerId } from './state.js';
import type { GameEvent } from './events.js';
import type { ReplacementIndex } from './internal/replacement.js';
import { indexReplacements, replaceLifeGain } from './internal/replacement.js';

/**
 * How much life `player` actually gains when something would give them
 * `amount`, after every applicable CR 614 replacement effect.
 *
 * Returns `amount` unchanged when nothing in the game replaces life gain, which
 * is every game containing none of these cards — the index lookup is one
 * `.length` read in that case (see `internal/replacement.ts`).
 *
 * ⚠️ PERF, and it is the reason `index` is a parameter rather than something
 * this function always builds. {@link indexReplacements} walks the battlefield;
 * a caller inside a loop (a combat damage round resolving lifelink for several
 * creatures) MUST build one index and pass it, or the walk becomes quadratic in
 * board size. `untap.ts` carries the same parameter for the same measured
 * reason (§3.15's ~9% throughput loss from a comparable per-call walk).
 *
 * Omitting it stays supported for the one-off question, where a single walk is
 * the cheapest answer there is — and `life.test.ts` asserts the two forms always
 * agree, because §3.146 shipped a defect that was exactly a disagreement between
 * twins like these.
 *
 * `emit` receives the layer's own log events (which replacement applied, and
 * how much it changed the number). It does NOT emit `gainLife` or `lifeChanged`:
 * those belong to the site that performs the mutation, because only it knows
 * whether the life total really moved.
 */
export function gainLifeAmount(
  state: GameState,
  player: PlayerId,
  amount: number,
  emit: (e: GameEvent) => void,
  index?: ReplacementIndex,
): number {
  // A non-positive "gain" is not a life-gain event at all (CR 118.5), so it is
  // never offered to the layer — a replacement must not be able to turn a
  // gain-of-nothing into a gain of something.
  if (amount <= 0) return amount;
  const resolved = index ?? indexReplacements(state);
  if (resolved.length === 0) return amount;
  return replaceLifeGain(state, resolved, player, amount, emit);
}
