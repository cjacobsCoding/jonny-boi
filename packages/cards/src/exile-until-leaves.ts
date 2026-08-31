/**
 * EXILE UNTIL THIS LEAVES — the "O-Ring" pattern (CR 603.6c/610.3).
 *
 * "When this creature enters, exile target creature an opponent controls until
 * this creature leaves the battlefield." (Banisher Priest.) Older wordings split
 * it across two abilities — "you may exile another target creature" plus "when
 * this leaves, return the exiled card" (Fiend Hunter) — and both are the same
 * machine: something goes to exile with a LINK back to the permanent that sent
 * it, and comes back when that permanent goes away.
 *
 * The link is a CORE CardInstance field (§3.56) — it MUST survive core's
 * per-action clone, and an ad-hoc property does not: it lived until the next
 * action's clone and then vanished, which made every release a silent no-op.
 *
 * The link is what makes this a system rather than a card script. Two Fiend
 * Hunters on the battlefield have each exiled their own creature, and killing one
 * must return exactly its own — so the exiled card records WHO exiled it rather
 * than the exiler recording a list. That direction matters: the exiler is the
 * object about to leave (and be reset), while the exiled card is sitting still in
 * a zone nothing else touches.
 *
 * ⚠️ The return is deliberately NOT a state-based action. It is a real triggered
 * ability on the exiler's own `leaves` event, so it uses the stack, it can be
 * responded to, and a card that returns to HAND (Angel of Serenity) rather than
 * the battlefield differs only by a param.
 */
import {
  isCreature,
  PLAYER_IDS,
  type CardInstance,
  type EffectContext,
  type EffectPrimitive,
  type InstanceId,
  type PlayerId,
} from '@jonny-boi/core';
import { isLegalTarget } from '@jonny-boi/core';
import {
  intParam,
  isPlayerTarget,
  movePermanentTo,
  permanentById,
  putOntoBattlefield,
  restrictionParam,
  strParam,
} from './effect-helpers.js';

/** Where a returning card goes. Battlefield is the default (O-Ring, Fiend Hunter). */
type ReturnTo = 'battlefield' | 'hand';

/** Read the `to` param, defaulting to the battlefield. */
function returnDestination(ctx: EffectContext): ReturnTo {
  return strParam(ctx, 'to') === 'hand' ? 'hand' : 'battlefield';
}

/**
 * `exileUntilLeaves` — exile the targeted permanents, linked to this source.
 *
 * `params.max` caps how many are taken ("up to three other target creatures").
 * Every non-player target is tried in the order chosen, and a target that has
 * already left is skipped — the same resolution-time re-check every targeting
 * primitive in this package makes.
 */
export const exileUntilLeaves: EffectPrimitive = (ctx) => {
  const max = intParam(ctx, 'max', 1);
  if (max <= 0) return;
  const restriction = restrictionParam(ctx);
  const ids: InstanceId[] = [];
  for (const target of ctx.targets) if (!isPlayerTarget(target)) ids.push(target);

  let done = 0;
  for (const id of ids) {
    if (done >= max) break;
    if (!isLegalTarget(ctx.state, restriction, id, ctx.controller, ctx.source.def)) continue;

    const permanent = permanentById(ctx.state, id);
    let owner: PlayerId;
    if (permanent) {
      owner = permanent.owner;
      // Exile through the shared leave funnel, so a token ceases to exist and
      // every CR 400.7 reset happens exactly as it does for any other exile.
      movePermanentTo(ctx, permanent, 'exile');
    } else {
      // A creature CARD IN A GRAVEYARD (Angel of Serenity takes either). Not a
      // permanent, so the battlefield funnel does not apply: it is already a
      // card in an owned zone and simply moves to the next one.
      const found = cardInAGraveyard(ctx, id);
      if (!found) continue; // already left — the usual resolution-time re-check
      owner = found.owner;
      found.zone.splice(found.index, 1);
      found.card.zone = 'exile';
      ctx.state.players[owner].exile.push(found.card);
      ctx.emit({ type: 'zoneChange', instanceId: id, from: 'graveyard', to: 'exile' });
    }

    // Stamped AFTER the move: `resetInstanceForNewZone` runs inside the
    // battlefield funnel and would otherwise be free to clear the link.
    const exiled = ctx.state.players[owner].exile.find((c) => c.instanceId === id);
    if (exiled) exiled.exiledUntilLeavesBy = ctx.source.instanceId;
    done += 1;
  }
};

/** Locate a card sitting in EITHER graveyard, with what is needed to move it. */
function cardInAGraveyard(
  ctx: EffectContext,
  id: InstanceId,
): { readonly card: CardInstance; readonly owner: PlayerId; readonly zone: CardInstance[]; readonly index: number } | undefined {
  for (const owner of PLAYER_IDS) {
    const zone = ctx.state.players[owner].graveyard as CardInstance[];
    const index = zone.findIndex((c) => c.instanceId === id);
    if (index >= 0) return { card: zone[index] as CardInstance, owner, zone, index };
  }
  return undefined;
}

/**
 * `returnExiledByThis` — the other half: bring back everything this source
 * exiled, to `params.to` ('battlefield' by default, 'hand' for Angel of
 * Serenity).
 *
 * Runs off the source's own `leaves` trigger. Both exiles are scanned, because a
 * card is exiled to its OWNER's zone and the exiler may not own it.
 */
export const returnExiledByThis: EffectPrimitive = (ctx) => {
  const to = returnDestination(ctx);
  const source = ctx.source.instanceId;
  for (const owner of PLAYER_IDS) {
    const zone = ctx.state.players[owner].exile;
    // Snapshot: returning mutates the array being walked.
    const mine = zone.filter((c) => c.exiledUntilLeavesBy === source);
    for (const card of mine) {
      delete card.exiledUntilLeavesBy;
      if (to === 'hand') {
        const index = zone.findIndex((c) => c.instanceId === card.instanceId);
        if (index < 0) continue;
        zone.splice(index, 1);
        card.zone = 'hand';
        ctx.state.players[owner].hand.push(card);
        ctx.emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'exile', to: 'hand' });
        continue;
      }
      // "under its owner's control" — the printed wording on every card that
      // returns this way, and the reason the owner (not this source's
      // controller) is passed.
      putOntoBattlefield(ctx, owner, card.instanceId, 'exile');
    }
  }
};

/** True when this definition is a creature — read by the pilot's valuation. */
export { isCreature };

/** The primitives this module contributes to the shared registry. */
export const EXILE_UNTIL_LEAVES_PRIMITIVES: Readonly<Record<string, EffectPrimitive>> = Object.freeze({
  exileUntilLeaves,
  returnExiledByThis,
});
