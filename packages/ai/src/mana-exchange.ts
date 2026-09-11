/**
 * THE ABILITY THAT GIVES BACK EXACTLY WHAT IT TAKES — DESIGN §3.141.
 *
 * Bog Initiate prints `{1}: Add {B}`. Every other scorer in this package prices
 * an activation by what its EFFECTS are worth, and that is right for every
 * ability whose cost and payoff are in different currencies: you spend mana and
 * get a creature tapped, a card drawn, a body pumped. A mana ability is the one
 * shape where the cost and the payoff are the SAME currency, so pricing only the
 * credit side is a category error — the pilot books `addMana` at its per-symbol
 * weight, pays for it out of the very pool it just filled, and books the profit
 * again. Measured: eight of the deep tier's twelve violations were one turn in
 * which the pilot activated Bog Initiate ~665 times (`abilityActivated ×667`,
 * `manaAdded ×688`) until CR 104.4b drew the game.
 *
 * ## The rule, and why it is the narrow one
 *
 * **A pure mana exchange is worth nothing when the pool it would leave behind is
 * the pool it started from.** Not "never activate a mana ability twice" — that
 * would be wrong and would cost real games, because the very same `{1}: Add {B}`
 * is a genuine COLOUR FIX when the pilot holds `{R}` and needs `{B}`, and
 * Agent of Stromgald's `{R}: Add {B}` is nothing but a colour fix. Both survive
 * here, because both END with a pool they did not start with.
 *
 * The test is an equality, not an estimate, and that is what makes it safe:
 *
 *  * a filter that converts `{R}` into `{B}` changes the pool ⇒ still scored,
 *    still used;
 *  * the same filter run a second time on an all-black pool cannot change it
 *    ⇒ refused, which is exactly where the runaway lived;
 *  * a ritual (`{1}`, Sacrifice: add `{U}{B}{R}`) grows the pool ⇒ untouched —
 *    and is excluded before the arithmetic anyway, see {@link pureManaExchange}.
 *
 * So the loop cannot survive and the fixing cannot be lost: a pool that changes
 * is a pool with strictly fewer ways left to change, and an exchange that leaves
 * it identical is one the pilot can repeat for ever without progressing.
 *
 * ## Why the prediction cannot disagree with the engine
 *
 * The cost is paid through core's own `payCost` — the very function
 * `applyActivateAbility` calls, with the same spend purpose — rather than through
 * a second opinion about which mana a generic pip eats. A pilot that modelled the
 * spend itself would be one refactor away from refusing a fix that does work, or
 * permitting a loop that does not terminate.
 *
 * ## Why this is a pilot rule and not an engine rule
 *
 * The activation is LEGAL. CR 602 lets a player activate `{1}: Add {B}` as often
 * as they can pay for it, and an engine that refused would be wrong about the
 * game. What is wrong is choosing it, which is this package's business.
 */

import {
  addProduction,
  payCost,
  spendPurposeIfRestricted,
  type ActivatedAbility,
  type CardDefinition,
  type CardInstance,
  type GameState,
  type ManaColor,
  type ManaCost,
  type ManaPool,
  type ManaProduction,
  type ManaTapPlan,
  type PlayerId,
} from '@jonny-boi/core';
import type { PilotView } from './pilot.js';

/** The one effect primitive that pays a player in the currency it charges. */
const ADD_MANA = 'addMana';

/** What a {@link pureManaExchange} costs and what it hands back. */
export interface ManaExchange {
  readonly cost: ManaCost;
  /** Every symbol the ability adds, across all of its `addMana` effects. */
  readonly produced: readonly ManaColor[];
}

/**
 * The ability read as a pure mana exchange, or `undefined` when it is something
 * else and none of this applies.
 *
 * "Pure" is deliberately strict, and every exclusion is a rider that makes the
 * ability self-limiting, a real resource conversion, or both:
 *
 *  * `{T}` — a tapped permanent cannot pay again this turn;
 *  * `Sacrifice ~` / `Sacrifice a …` — the payer is gone;
 *  * `Pay N life` — a cost the pilot is not asked to price here;
 *  * a loyalty cost — `bestLoyaltyActivation` owns those;
 *  * any non-`addMana` effect — Pristine Talisman's `{T}: Add {C}` also gains a
 *    life, and a life is not mana; pricing that as an exchange would be lying.
 *
 * MEASURED against the shipped pool: of 43 printed `addMana` activations exactly
 * TWO survive every exclusion — Bog Initiate's `{1}: Add {B}` and Agent of
 * Stromgald's `{R}: Add {B}` — and only the first can ever be ruled a no-op,
 * because black mana cannot pay `{R}`. Two members is the whole reason this is a
 * shape and not a card name: the second one is already printed, it is fine, and
 * the rule has to tell them apart without being told which is which.
 * `mana-exchange.test.ts` re-measures both halves against the real pool, so the
 * card printed tomorrow that re-opens the class fails there.
 */
export function pureManaExchange(ability: ActivatedAbility): ManaExchange | undefined {
  const cost = ability.cost;
  if (cost.mana === undefined) return undefined;
  if (cost.tap || cost.sacrificeSelf || cost.sacrificeAnother) return undefined;
  if (cost.life !== undefined || cost.loyalty !== undefined) return undefined;
  const produced: ManaColor[] = [];
  for (const effect of ability.effects) {
    if (effect.primitive !== ADD_MANA) return undefined;
    const mana = (effect.params as { readonly mana?: unknown } | undefined)?.mana;
    if (!Array.isArray(mana)) return undefined;
    for (const symbol of mana) {
      if (typeof symbol !== 'string') return undefined;
      produced.push(symbol as ManaColor);
    }
  }
  if (produced.length === 0) return undefined;
  return { cost: cost.mana, produced };
}

/**
 * The pool this exchange would leave behind, or `undefined` when the cost cannot
 * be paid out of `pool` at all (which is not this module's question — the caller
 * has a funding plan for that).
 */
function poolAfterExchange(
  pool: ManaPool,
  exchange: ManaExchange,
  def: CardDefinition,
): ManaPool | undefined {
  const paid = payCost(pool, exchange.cost, spendPurposeIfRestricted(pool, def, 'activate'));
  if (!paid.ok) return undefined;
  let after = paid.pool;
  for (const color of exchange.produced) {
    after = addProduction(after, { [color]: 1 } as ManaProduction);
  }
  return after;
}

/** Same six counts, in the same six colours. */
function sameMana(a: ManaPool, b: ManaPool): boolean {
  return a.W === b.W && a.U === b.U && a.B === b.B && a.R === b.R && a.G === b.G && a.C === b.C;
}

/**
 * Whether activating this ability against `pool` would change nothing at all —
 * the one question this module exists to answer.
 *
 * `pool` is the pool AS IT WILL BE WHEN THE ABILITY IS ACTIVATED, which for a
 * caller that still has to tap for the cost means the pool plus everything its
 * funding plan produces. Asking against the pre-tap pool instead would let the
 * pilot spend a land on a tap and only then discover the activation was
 * worthless, stranding the mana (pools empty at end of step) and tapping a source
 * a real spell wanted.
 *
 * `false` for anything this cannot decide — an unpayable cost, a pool carrying
 * restricted mana (where identical colour counts do NOT mean an identical pool:
 * spending a restricted mana to make an unrestricted one is a real gain). An
 * honest "I cannot rule on this" leaves the pilot exactly the play it has today;
 * widening the refusal to cover it would be the silent strength regression this
 * rule is written to avoid.
 */
export function manaExchangeIsNoOp(
  ability: ActivatedAbility,
  def: CardDefinition,
  pool: ManaPool | undefined,
): boolean {
  const exchange = pureManaExchange(ability);
  if (exchange === undefined) return false;
  // `undefined` is the caller saying "I could not predict the pool" — see
  // `poolAfterPlan`. A restricted parcel makes two pools with equal colour counts
  // genuinely different, and this function does not model parcels. Refuse to rule
  // on either, which leaves the pilot the play it has today.
  if (pool === undefined || pool.restricted !== undefined) return false;
  const after = poolAfterExchange(pool, exchange, def);
  if (after === undefined) return false;
  return sameMana(after, pool);
}

/**
 * The pool a funding plan would leave floating — `pool` plus everything the plan
 * taps for — or `undefined` when it cannot be predicted.
 *
 * `undefined` for a plan that taps a source printing a **spend restriction**:
 * `ManaTapPlan` records the colours a tap makes but not the strings attached to
 * them, and mana that may only be spent on a creature spell is not the same
 * resource as mana that may be spent on anything. Rather than model parcels a
 * second time (core's pool already does), this says so and
 * {@link manaExchangeIsNoOp} declines to rule.
 */
export function poolAfterPlan(
  view: PilotView,
  player: PlayerId,
  plan: readonly ManaTapPlan[],
): ManaPool | undefined {
  const pool = view.players[player].manaPool;
  if (plan.length === 0) return pool;
  let after = pool;
  for (const tap of plan) {
    if (tapCarriesSpendRestriction(view, tap)) return undefined;
    after = addProduction(after, tap.production);
  }
  return after;
}

/** Whether this planned tap's source prints "spend this mana only to …". */
function tapCarriesSpendRestriction(view: PilotView, tap: ManaTapPlan): boolean {
  const battlefield = (view as GameState).battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (perm.instanceId !== tap.instanceId) continue;
    for (const ability of perm.def.manaAbilities ?? []) {
      if (ability.spendRestriction !== undefined) return true;
    }
    return false;
  }
  // The plan named a permanent this board does not have, which cannot happen —
  // but guessing "unrestricted" about a source we cannot see would be the wrong
  // direction, so say "cannot predict".
  return true;
}
