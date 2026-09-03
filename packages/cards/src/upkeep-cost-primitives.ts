/**
 * UPKEEP COSTS AND TIME COUNTERS (§3.106) — the primitives behind echo (CR
 * 702.30a), cumulative upkeep (702.24a), vanishing (702.63a), fading (702.32a),
 * suspend's exile-side tick (702.62a), the printed "sacrifice ~ unless you pay
 * …" template and the delayed "draw a card at the beginning of the next turn's
 * upkeep".
 *
 * All of them are BODIES of triggers the compiler builds from the existing
 * vocabulary (`upkeep`, an intervening "if", `payManaOrElse`); what this file
 * adds is the handful of verbs none of the existing primitives spoke:
 * sacrifice THE SOURCE, pay LIFE or else, an age-scaled bill, a counter that
 * ticks down to a sacrifice, and a scheduled body with an arbitrary condition.
 *
 * Every payment here is ask-then-mutate (see `EffectContext.ask`): the question
 * is the first thing a primitive does, so a parked question re-runs it from
 * the top with nothing to undo. Every sacrifice goes through the ONE sacrifice
 * funnel (`sacrificePermanent`), so dies-triggers and the instance reset behave
 * exactly as they do for an edict.
 */

import type { EffectContext, EffectPrimitive, EffectRef, TriggerCondition, TriggerWho } from '@jonny-boi/core';
import {
  AGE_COUNTER,
  formatManaCost,
  indexReplacements,
  isSuspended,
  openSuspendWindow,
  repeatCost,
  replaceCounters,
  TIME_COUNTER,
} from '@jonny-boi/core';
import { sacrificePermanent } from './choice-primitives.js';
import { intParam, manaCostParam, permanentById, strParam } from './effect-helpers.js';

/** The delayed body the suspend action schedules and the tick re-schedules — one spelling. */
export const SUSPEND_TICK_PRIMITIVE = 'suspendTick';

/** Well-formed effect refs from a wrapper param (the shared shallow guard). */
function nestedRefs(ctx: EffectContext, key: string): readonly EffectRef[] {
  const raw = ctx.params[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is EffectRef =>
      typeof entry === 'object' && entry !== null && typeof (entry as { primitive?: unknown }).primitive === 'string',
  );
}

/**
 * `sacrificeSelf` — "sacrifice ~" as a RESOLUTION effect: the source permanent,
 * if it is still on the battlefield, goes to its owner's graveyard as a
 * sacrifice. A source that has already left does nothing — the printed card
 * does nothing either.
 */
export const sacrificeSelf: EffectPrimitive = (ctx) => {
  const self = permanentById(ctx.state, ctx.source.instanceId);
  if (!self) return;
  sacrificePermanent(ctx, self);
};

/**
 * `payLifeOrElse` — the life-cost sibling of `payManaOrElse`: "unless you pay
 * N life" (Season of the Witch's upkeep, the "sacrifice ~ unless you pay 2
 * life" template). Declining — or being unable to pay (CR 118.4: life is paid
 * down to zero, never past) — runs the consequence.
 *
 * Params: `amount` (life), `effects` (the consequence), `who` (defaults to the
 * ability's controller).
 */
export const payLifeOrElse: EffectPrimitive = (ctx) => {
  const amount = intParam(ctx, 'amount', 0);
  const consequence = nestedRefs(ctx, 'effects');
  if (amount <= 0) return; // a malformed bill cannot be "not paid" — see payManaOrElse
  const paid = ctx.payLifeOrDecline({
    amount,
    prompt: `Pay ${amount} life — if you don't, ${ctx.source.def.name}'s consequence happens`,
    valence: 'gain',
  });
  if (paid === undefined) return; // parked — nothing mutated
  if (paid) return;
  if (consequence.length > 0) ctx.enqueueEffects(consequence);
};

/**
 * `cumulativeUpkeep` — CR 702.24a: "At the beginning of your upkeep, if this
 * permanent is on the battlefield, put an age counter on this permanent. Then
 * you may pay [cost] for each age counter on it. If you don't, sacrifice it."
 *
 * The bill is asked FIRST, sized for the counter this upkeep is about to add
 * (ask-then-mutate: a parked question re-runs this with the counter still not
 * on, and sizes the same bill). The counter goes on whether or not the bill is
 * paid — the printed order — and only then does an unpaid bill sacrifice.
 *
 * The cost KINDS are a closed table, decided by the compiler: `mana` (a
 * `ManaCost`, paid `age` times over — "each choice is made separately for
 * each age counter", CR 702.24a, which for a plain mana cost is one bill of
 * `age × cost`) or `life` (N life per counter). A printed cost outside the
 * table ("Sacrifice a land", "Put a -1/-1 counter") never reaches here.
 */
export const cumulativeUpkeep: EffectPrimitive = (ctx) => {
  const self = permanentById(ctx.state, ctx.source.instanceId);
  if (!self) return; // "if this permanent is on the battlefield"
  const age = (self.counters[AGE_COUNTER] ?? 0) + 1;
  const mana = manaCostParam(ctx, 'mana');
  const life = intParam(ctx, 'life', 0);
  let paid: boolean | undefined;
  if (mana) {
    const bill = repeatCost(mana, age);
    paid = ctx.payOrDecline({
      cost: bill,
      prompt: `Cumulative upkeep: pay ${formatManaCost(bill)} (${age} age counter${age === 1 ? '' : 's'}) or sacrifice ${self.def.name}`,
      valence: 'gain',
      stakeInstanceId: self.instanceId,
    });
  } else if (life > 0) {
    const bill = life * age;
    paid = ctx.payLifeOrDecline({
      amount: bill,
      prompt: `Cumulative upkeep: pay ${bill} life (${age} age counter${age === 1 ? '' : 's'}) or sacrifice ${self.def.name}`,
      valence: 'gain',
    });
  } else {
    return; // no payable cost kind — the compiler never emits this
  }
  if (paid === undefined) return; // parked — nothing mutated
  putCountersOfKind(ctx, self, AGE_COUNTER, 1);
  if (!paid) sacrificePermanent(ctx, self);
};

/**
 * `tickDownCounter` — the upkeep half of vanishing and fading: remove one
 * `counter` from the source, and sacrifice it either when the LAST one leaves
 * (vanishing, CR 702.63a — `sacrificeWhen: 'lastRemoved'`) or when there was
 * NONE to remove (fading, CR 702.32a — `'noneToRemove'`). The two spellings
 * are one primitive with a mode because the difference is exactly one
 * printed word, and a table row beats a second primitive.
 *
 * ⚠️ Vanishing prints its sacrifice as a SEPARATE trigger ("when the last time
 * counter is removed"), which would give a response window between the
 * removal and the sacrifice. Here they resolve together. The one thing that
 * window could change — an instant that moves the permanent in between — ends
 * with the permanent gone either way; a card that wants the window is the
 * counter-removal trigger event this engine does not have, and is reported.
 */
export const tickDownCounter: EffectPrimitive = (ctx) => {
  const self = permanentById(ctx.state, ctx.source.instanceId);
  if (!self) return;
  const kind = strParam(ctx, 'counter');
  const when = strParam(ctx, 'sacrificeWhen');
  if (kind === undefined || (when !== 'lastRemoved' && when !== 'noneToRemove')) return;
  const have = self.counters[kind] ?? 0;
  if (have <= 0) {
    if (when === 'noneToRemove') sacrificePermanent(ctx, self);
    return;
  }
  const left = have - 1;
  self.counters = { ...self.counters, [kind]: left };
  // The same event every counter removal emits — a negative amount, exactly as
  // the CR 704.5q annihilation in `internal/sba.ts` reports its removals.
  ctx.emit({ type: 'counterAdded', instanceId: self.instanceId, kind, amount: -1 });
  if (left === 0 && when === 'lastRemoved') sacrificePermanent(ctx, self);
};

/**
 * `suspendTick` — the exile-side abilities of suspend (CR 702.62a), as the
 * body of the delayed ability `applySuspendCard` creates: "At the beginning of
 * your upkeep, if this card is suspended, remove a time counter from it," and
 * "When the last time counter is removed from this card, if it's exiled, you
 * may cast it without paying its mana cost" — the latter as the cast WINDOW
 * suspend.ts describes.
 *
 * The source is the suspended card itself (the delayed record names it, and
 * `frameSource` resolves it anywhere), so nothing has to be looked up. While
 * counters remain the ability RE-SCHEDULES itself for the next upkeep: a
 * delayed ability fires once and is removed, which is exactly the "next" in
 * "at the beginning of your next upkeep", so a card suspended for four is four
 * one-shot records in sequence rather than one ability the collector would
 * have to find in exile on every event.
 */
export const suspendTick: EffectPrimitive = (ctx) => {
  const card = ctx.source;
  // CR 702.62b — a card that is no longer suspended (cast early, moved, or a
  // last-known-information stand-in) is left alone.
  if (!isSuspended(card)) return;
  const left = (card.counters[TIME_COUNTER] ?? 0) - 1;
  card.counters = { ...card.counters, [TIME_COUNTER]: left };
  ctx.emit({ type: 'counterAdded', instanceId: card.instanceId, kind: TIME_COUNTER, amount: -1 });
  if (left > 0) {
    ctx.createDelayedTrigger({
      condition: { on: 'upkeep', who: 'you' },
      effects: [{ primitive: SUSPEND_TICK_PRIMITIVE }],
      label: `Suspend: ${card.def.name}`,
    });
    return;
  }
  openSuspendWindow(ctx.state, card, ctx.emit);
};

/**
 * `scheduleDelayedEffects` — a DELAYED triggered ability (CR 603.7) with an
 * arbitrary step condition and body: "Draw a card at the beginning of the
 * next turn's upkeep" (Heal, Jolt, the Ice Age cantrips). The Pact's
 * `scheduleDelayedPayment` is this with the body fixed to a bill; this is the
 * general form, kept separate so the Pact's own guards (no bill, no
 * consequence ⇒ schedule nothing) stay where they are.
 *
 * Params: `on` (a `TriggerEvent` step name), `who` (a `TriggerWho`; "the next
 * turn's upkeep" is `'any'` — whoever's turn comes next), `effects`, `label`.
 * The body resolves under the CREATING player (CR 603.7d), which is what makes
 * "draw a card" draw the caster a card on the opponent's upkeep.
 */
export const scheduleDelayedEffects: EffectPrimitive = (ctx) => {
  const on = strParam(ctx, 'on');
  const who = strParam(ctx, 'who');
  const body = nestedRefs(ctx, 'effects');
  if (on === undefined || body.length === 0) return;
  const condition: TriggerCondition = {
    on: on as TriggerCondition['on'],
    ...(who !== undefined ? { who: who as TriggerWho } : {}),
  };
  ctx.createDelayedTrigger({
    condition,
    effects: [...body],
    label: strParam(ctx, 'label') ?? `${ctx.source.def.name}: delayed ${on}`,
  });
};

/**
 * Put `amount` counters of `kind` on `target` through the ONE CR 614 counter
 * replacement site — the same call `addCountersOfKind` in primitives.ts
 * makes, repeated here rather than imported because that module already
 * imports this one's table (an import back would be a load-order cycle).
 */
function putCountersOfKind(ctx: EffectContext, target: import('@jonny-boi/core').CardInstance, kind: string, amount: number): void {
  const magnitude = replaceCounters(ctx.state, indexReplacements(ctx.state), ctx.source, target, kind, amount, ctx.emit);
  if (magnitude <= 0) return;
  target.counters = { ...target.counters, [kind]: (target.counters[kind] ?? 0) + magnitude };
  ctx.emit({ type: 'counterAdded', instanceId: target.instanceId, kind, amount: magnitude });
}

/** The table `primitives.ts` merges into the registry. */
export const UPKEEP_COST_PRIMITIVES: Readonly<Record<string, EffectPrimitive>> = Object.freeze({
  sacrificeSelf,
  payLifeOrElse,
  cumulativeUpkeep,
  tickDownCounter,
  [SUSPEND_TICK_PRIMITIVE]: suspendTick,
  scheduleDelayedEffects,
});
