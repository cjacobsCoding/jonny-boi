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
  type CardInstance,
  type EffectContext,
  type EffectPrimitive,
  type InstanceId,
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

/**
 * The link, written onto the EXILED card: the instance that sent it there.
 *
 * A widened `CardInstance` rather than a core field, because this is a
 * cards-package mechanic and core has no opinion about it. Set only on cards
 * actually exiled this way, so no other instance grows the property (the same
 * shape discipline `resetInstanceForNewZone` documents).
 */
interface ExiledCard extends CardInstance {
  exiledUntilLeavesBy?: InstanceId;
}

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
    const permanent = permanentById(ctx.state, id);
    if (!permanent) continue;
    if (!isLegalTarget(ctx.state, restriction, id, ctx.controller, ctx.source.def)) continue;
    // Exile through the shared leave funnel, so a token ceases to exist and every
    // CR 400.7 reset happens exactly as it does for any other exile.
    movePermanentTo(ctx, permanent, 'exile');
    // Stamped AFTER the move: `resetInstanceForNewZone` runs inside it and would
    // otherwise be free to clear the link we are about to write.
    const exiled = ctx.state.players[permanent.owner].exile.find((c) => c.instanceId === id);
    if (exiled) (exiled as ExiledCard).exiledUntilLeavesBy = ctx.source.instanceId;
    done += 1;
  }
};

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
  for (const owner of ['A', 'B'] as const) {
    const zone = ctx.state.players[owner].exile;
    // Snapshot: returning mutates the array being walked.
    const mine = zone.filter((c) => (c as ExiledCard).exiledUntilLeavesBy === source);
    for (const card of mine) {
      delete (card as ExiledCard).exiledUntilLeavesBy;
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
