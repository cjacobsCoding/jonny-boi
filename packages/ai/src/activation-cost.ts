/**
 * WHAT PAYING AN ACTIVATION'S NON-MANA COST COSTS THE PILOT.
 *
 * Every activation scorer in this package prices an ability by what its
 * EFFECTS are worth (`valueOfEffects`), and the mana half of the cost is
 * handled by the planner. The rest of the cost — the counters it strips off
 * the source, the permanent it sacrifices, the life it pays — was booked at
 * nothing, so an offered ability was judged on its credit side alone. Spike
 * Feeder made the gap visible the day it compiled: "Remove a +1/+1 counter
 * from this creature: You gain 2 life" is offered whenever a counter is there,
 * and a pilot that prices only the 2 life strips its own 2/2 down to a dead
 * 0/0 in two priority windows for four life it did not need.
 *
 * This is the debit side, in the SAME units and against the SAME weights the
 * body is priced in, so an activation is judged on its net worth:
 *
 *  - `removeCounters` of +1/+1 — the stat points that leave, at the ruler every
 *    counter-placing body is priced by (`modeCounterPerStatValue`, two points a
 *    counter); and when the counters were what kept the body alive, the body
 *    too (`choiceCreatureBaseValue`, the same weight the `sacrificeSelf`
 *    primitive books). -1/-1 counters removed are a CREDIT of the same size.
 *    An inert kind (charge, spore) has no value of its own — its meaning is the
 *    card's other lines — and is priced at zero, which is honest, not free:
 *    the ability's body still has to beat `passScore` on its own.
 *  - `sacrificeSelf` — the permanent, at `choiceCreatureBaseValue`.
 *  - `life` — the points, at the life ruler `gainLife` uses, with the same
 *    desperate multiplier below `desperateLifeThreshold`.
 *
 * ⚠️ NOT priced here, and said so: `sacrificeAnother` (the victim is chosen by
 * the engine's offer, one action per payer, and its worth is that permanent's
 * — a later scorer can price it per offered `costInstanceIds`) and `loyalty`
 * (owned by `bestLoyaltyActivation`, which prices counters itself).
 */
import {
  MINUS_ONE_COUNTER,
  PLUS_ONE_COUNTER,
  type ActivationCost,
  type CardInstance,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import type { ContinuousIndex } from './board-stats.js';
import { toughness } from './board-stats.js';
import type { HeuristicWeights } from './weights.js';

/** Two stat points per ±1/±1 counter — the arithmetic `addCounters` is priced by. */
const STAT_POINTS_PER_COUNTER = 2;

export interface ActivationCostContext {
  readonly state: GameState;
  readonly player: PlayerId;
  readonly weights: HeuristicWeights;
  readonly index: ContinuousIndex;
}

/**
 * The value, to `ctx.player`, of paying `cost` on `source` — zero or negative
 * for every component but a -1/-1 counter removed. Add it to the body's value.
 */
export function activationCostValue(cost: ActivationCost, source: CardInstance, ctx: ActivationCostContext): number {
  const weights = ctx.weights;
  let value = 0;
  if (cost.removeCounters !== undefined) {
    const { kind, count } = cost.removeCounters;
    if (kind === PLUS_ONE_COUNTER) {
      value -= count * STAT_POINTS_PER_COUNTER * weights.modeCounterPerStatValue;
      // The counters were the body: a 0/0 Spike with its last counter gone dies
      // to the state-based action the moment the activation settles.
      if (toughness(source, ctx.index) - count <= 0) value -= weights.choiceCreatureBaseValue;
    } else if (kind === MINUS_ONE_COUNTER) {
      value += count * STAT_POINTS_PER_COUNTER * weights.modeCounterPerStatValue;
    }
  }
  if (cost.sacrificeSelf === true) value -= weights.choiceCreatureBaseValue;
  if (cost.life !== undefined && cost.life > 0) {
    const desperate = ctx.state.players[ctx.player].life <= weights.desperateLifeThreshold;
    const perPoint = desperate
      ? weights.modeLifePerPointValue * weights.modeDesperateLifeMultiplier
      : weights.modeLifePerPointValue;
    value -= cost.life * perPoint;
  }
  return value;
}
