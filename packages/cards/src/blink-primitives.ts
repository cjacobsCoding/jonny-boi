/**
 * BLINK (a.k.a. flicker) — "exile target permanent you control, then return that
 * card to the battlefield under your control."
 *
 * The whole mechanic is CR 400.7 taken seriously: the thing that comes back is a
 * NEW OBJECT. That single sentence is what the archetype is built on, and it is
 * why blink is worth an engine primitive rather than a card script:
 *
 *  - its enters-the-battlefield trigger fires again (the payoff — Wall of Omens
 *    draws a second card, Thragtusk makes a second 5-life);
 *  - counters, damage, Auras, Equipment and "until end of turn" effects do not
 *    come with it — including a "gain control until end of turn", which is why
 *    blinking a stolen creature keeps it for good;
 *  - it arrives untapped and summoning-sick (CR 302.6), so blinking an attacker
 *    mid-combat removes it from combat rather than untapping a threat;
 *  - a TOKEN blinked this way ceases to exist (CR 111.7) — it is exiled, and a
 *    token that has left the battlefield is gone before anything can return it.
 *
 * Nothing above is re-implemented here. Both halves are the package's existing
 * shared funnels — `movePermanentTo` on the way out and `putOntoBattlefield` on
 * the way back — precisely because those already answer "what does a zone change
 * do" for destroy, bounce, reanimate and fetch. A third opinion is how the funnels
 * drift, and `effect-helpers.ts` carries a scar comment about exactly that.
 *
 * ⚠️ What the funnels canNOT answer, and why `blinkOne` says three more things.
 * The returned card keeps its INSTANCE ID (a blink is not a new card, and every
 * id-keyed reference in the state has to stay sound). Three rules in this engine
 * were enforced purely by an id no longer being on the battlefield — removal from
 * combat, the attachment state-based action, and the pruning of floating
 * continuous effects — and a blink is the one effect that puts the id straight
 * back before any of them can look. So the second and third bullets above were,
 * until §3.43, quietly false: a blinked attacker still connected for its damage,
 * an Aura stayed on a creature it had never enchanted, and a Giant Growth came
 * back with it. See `blinkOne`.
 *
 * ⚠️ Immediate return ONLY. "Return it at the beginning of the next end step"
 * (Flickerwisp, Eerie Interlude, Ghostway) is a DELAYED trigger, which the engine
 * does not have yet — see DESIGN §3.21's named-unsupported list. Those cards stay
 * out of the pool rather than being approximated by an immediate return, which
 * would be a different card.
 */
import {
  dropContinuousEffectsFor,
  isLegalTarget,
  removeFromCombat,
  unattachDependentsOf,
  type CardInstance,
  type EffectContext,
  type EffectPrimitive,
  type InstanceId,
} from '@jonny-boi/core';
import {
  intParam,
  isPlayerTarget,
  movePermanentTo,
  permanentById,
  putOntoBattlefield,
  restrictionParam,
} from './effect-helpers.js';

/**
 * Blink ONE permanent: exile it, then put it straight back under `ctx.controller`.
 *
 * Returns the new object, or `undefined` when nothing came back — the permanent
 * had already left, or it was a token and ceased to exist on the way out. Both
 * are ordinary outcomes, not errors: a blink whose target is gone simply does
 * nothing, the same re-check every targeting primitive in this package makes at
 * resolution time.
 */
function blinkOne(ctx: EffectContext, permanent: CardInstance): CardInstance | undefined {
  const id = permanent.instanceId;
  // A card always goes to its OWNER's exile (CR 400.3), so that is where the
  // return has to look for it — while the CONTROLLER it comes back under is the
  // player doing the blinking. For the ordinary case those are the same player;
  // for a creature you control but do not own they are not, and blinking it is
  // the classic way a temporary control effect becomes permanent.
  const owner = permanent.owner;
  movePermanentTo(ctx, permanent, 'exile');
  // ⚠️ THE ID COMES BACK, so the two rules that normally notice a departure by
  // the id simply being gone have to be told. Both are asked AFTER the funnel
  // above has emitted its `zoneChange`, so every leaves/dies trigger still sees
  // the board it left — the same ordering `ceaseToExistIfToken` relies on.
  //   - CR 506.4: it is removed from combat. Without this a blinked attacker
  //     still connects for full damage AND returns untapped.
  //   - CR 400.7 + 704.5m/n: Auras and Equipment were attached to the OBJECT
  //     that left, not to the one coming back. Only the link is broken here;
  //     the state-based actions decide what each attachment does about it.
  //   - CR 400.7 again: a floating continuous effect applied to that object, so
  //     a Giant Growth does not follow it back — and neither does a "gain
  //     control until end of turn", which is precisely what makes blinking a
  //     stolen creature keep it (see the `controller` option below).
  removeFromCombat(ctx.state.combat, id);
  unattachDependentsOf(ctx.state, id, ctx.emit);
  dropContinuousEffectsFor(ctx.state, id);
  // "…return that card to the battlefield under ITS OWNER'S control"
  // (Teleportation Circle) vs "…under YOUR control" (Cloudshift, Thassa). The
  // printed words differ on exactly one board: a permanent you control but do
  // not own — the first hands it back, the second keeps it for good.
  const returnController = ctx.params.ownerControl === true ? owner : ctx.controller;
  return putOntoBattlefield(ctx, owner, id, 'exile', { controller: returnController });
}

/** Is this permanent a legal thing for THIS effect to blink? */
function blinkable(ctx: EffectContext, permanent: CardInstance | undefined): permanent is CardInstance {
  if (!permanent) return false;
  // The printed restriction ("target creature you control", "target non-Angel
  // creature you control") is re-checked at resolution, exactly as the removal
  // primitives do — the board may have changed since the spell was aimed.
  return isLegalTarget(ctx.state, restrictionParam(ctx), permanent.instanceId, ctx.controller, ctx.source.def);
}

/**
 * `blinkTarget` — exile the targeted permanents you control and return them.
 *
 * Every non-player target is blinked, in the order they were chosen, so the one
 * primitive serves a single-target blink (Cloudshift, Restoration Angel) and a
 * multi-target one (Teleportation Circle's artifact + creature) without a second
 * implementation. `params.max` caps how many are taken when a card wants a limit
 * independent of how many targets the engine happened to collect.
 */
export const blinkTarget: EffectPrimitive = (ctx) => {
  const max = intParam(ctx, 'max', Number.MAX_SAFE_INTEGER);
  if (max <= 0) return;
  // Snapshot the ids first. `blinkOne` mutates the battlefield, and resolving a
  // permanent lazily out of a list being spliced is how the second target of a
  // two-target blink would silently become the wrong object.
  const ids: InstanceId[] = [];
  for (const t of ctx.targets) if (!isPlayerTarget(t)) ids.push(t);

  let done = 0;
  for (const id of ids) {
    if (done >= max) break;
    const permanent = permanentById(ctx.state, id);
    if (!blinkable(ctx, permanent)) continue;
    blinkOne(ctx, permanent);
    done += 1;
  }
};

/**
 * `blinkSelf` — exile the SOURCE permanent and return it (Conjurer's Closet aims
 * at another creature, but a self-blink is the shape several cards use, and a
 * trigger that blinks its own source has no target to read).
 *
 * Split from {@link blinkTarget} rather than folded in behind a param: "which
 * permanent" is the entire decision a blink makes, and a primitive that answers
 * it two ways depending on a flag is the shape that hides a bug.
 */
export const blinkSelf: EffectPrimitive = (ctx) => {
  const self = permanentById(ctx.state, ctx.source.instanceId);
  if (!self) return; // already left the battlefield — a safe no-op
  // Deliberately NOT `isCreature`-gated: an artifact or enchantment can blink
  // itself just as legally, and gating here would make the primitive lie about
  // what it does the first time a non-creature card wants it.
  blinkOne(ctx, self);
};

/**
 * Does this card have an enters-the-battlefield trigger — i.e. is blinking it
 * worth anything at all?
 *
 * The pilot's blink scoring asks exactly this question, and it lives here beside
 * the primitive so "what makes a blink good" has one answer rather than one per
 * consumer.
 */
export function hasEntersTrigger(def: CardInstance['def']): boolean {
  return (def.triggers ?? []).some((t) => t.condition.on === 'etb');
}

/** The primitives this module contributes to the shared registry. */
export const BLINK_PRIMITIVES: Readonly<Record<string, EffectPrimitive>> = Object.freeze({
  blinkTarget,
  blinkSelf,
});
