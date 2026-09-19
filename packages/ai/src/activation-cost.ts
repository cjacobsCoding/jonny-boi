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
 *  - `discard` (§3.172) — the CARD given up, at the one ranking every other
 *    "which card do I least want?" question uses (`cardValue`, the cleanup
 *    discard's policy). With the payer NAMED — an offered action carries it —
 *    it is that card's worth, so the offer that pitches the flooded land
 *    outscores the one that pitches the bomb and the pilot discards its worst
 *    card by construction. Unnamed — the funded path deciding whether to tap
 *    for it — it is the cheapest qualifying card; a printed "at random" is the
 *    mean, which is what a random draw is worth.
 *
 * ⚠️ NOT priced here, and said so: `sacrificeAnother` (the victim is chosen by
 * the engine's offer, one action per payer, and its worth is that permanent's
 * — a later scorer can price it per offered `costInstanceIds`) and `loyalty`
 * (owned by `bestLoyaltyActivation`, which prices counters itself).
 */
import {
  matchesCardFilter,
  MINUS_ONE_COUNTER,
  PLUS_ONE_COUNTER,
  type ActivationCost,
  type CardInstance,
  type GameState,
  type InstanceId,
  type PlayerId,
} from '@jonny-boi/core';
import type { ContinuousIndex } from './board-stats.js';
import { toughness } from './board-stats.js';
import { cardValue, cardValueContext, type CardValueContext } from './card-value.js';
import type { HeuristicWeights } from './weights.js';

/** Two stat points per ±1/±1 counter — the arithmetic `addCounters` is priced by. */
const STAT_POINTS_PER_COUNTER = 2;

export interface ActivationCostContext {
  readonly state: GameState;
  readonly player: PlayerId;
  readonly weights: HeuristicWeights;
  readonly index: ContinuousIndex;
  /** The card ranking's context, when the caller already built one. */
  readonly cards?: CardValueContext;
}

/**
 * The value, to `ctx.player`, of paying `cost` on `source` — zero or negative
 * for every component but a -1/-1 counter removed. Add it to the body's value.
 * `payer` is the offered action's `costInstanceIds`, when there is one.
 */
export function activationCostValue(
  cost: ActivationCost,
  source: CardInstance,
  ctx: ActivationCostContext,
  payer?: readonly InstanceId[],
): number {
  const weights = ctx.weights;
  let value = 0;
  if (cost.discard !== undefined) value -= discardCostValue(cost.discard, ctx, payer);
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

/** §3.172 — see the module header: the card a discard cost gives up, priced. */
function discardCostValue(
  discard: NonNullable<ActivationCost['discard']>,
  ctx: ActivationCostContext,
  payer: readonly InstanceId[] | undefined,
): number {
  const hand = ctx.state.players[ctx.player].hand;
  const candidates: CardInstance[] = [];
  for (const card of hand) if (matchesCardFilter(card, discard.filter)) candidates.push(card);
  if (candidates.length === 0) return 0; // unpayable — the engine never offers it
  const cards = ctx.cards ?? cardValueContext(ctx.state, ctx.index);
  if (discard.random !== true && payer !== undefined && payer.length > 0) {
    let total = 0;
    for (const id of payer) {
      const named = candidates.find((card) => card.instanceId === id);
      if (named !== undefined) total += cardValue(named, ctx.weights, cards);
    }
    return total;
  }
  const values = candidates.map((card) => cardValue(card, ctx.weights, cards));
  if (discard.random === true) {
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    return discard.count * mean;
  }
  values.sort((a, b) => a - b);
  let cheapest = 0;
  for (let i = 0; i < Math.min(discard.count, values.length); i++) cheapest += values[i] as number;
  return cheapest;
}
