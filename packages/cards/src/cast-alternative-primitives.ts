/**
 * THE CAST-ALTERNATIVE FAMILY (§3.112) — the bodies of the delayed riders that
 * dash, blitz, evoke and warp put on the permanent their spell becomes.
 *
 * Each rider is created by core as the permanent ENTERS (`applyAlternativeCostRiders`)
 * with the permanent itself as its source, so `ctx.source` — resolved anywhere
 * by `frameSource` — IS the permanent the printed sentence names. What this
 * file adds is the two verbs the existing primitives did not speak from a
 * rider's seat: "return it to its owner's hand" and "exile it, and let its
 * owner cast it later". The evoke sacrifice and the blitz dies-draw need no
 * new primitive at all: `sacrificeSelf` (§3.106) and `drawCards` are already
 * the right bodies.
 *
 * ## The stamp is the guard (CR 400.7)
 * Every body here first checks `CardInstance.castWith` for the kind it serves.
 * The stamp is written at the entry that created the rider and cleared by the
 * one zone-reset helper the moment the permanent leaves, so a dash creature
 * that was bounced and recast for its printed cost — a NEW object — is not
 * returned by the OLD rider, which still fires (it matched its end step) and
 * finds nothing to do. That is exactly what the printed card does.
 */

import type { EffectPrimitive } from '@jonny-boi/core';
import { addCardGrant } from '@jonny-boi/core';
import { sacrificePermanent } from './choice-primitives.js';
import { movePermanentTo, permanentById, strParam } from './effect-helpers.js';

/**
 * `sacrificeSelfIfCastWith` — EVOKE's enters-the-battlefield sacrifice (CR
 * 702.74a, "if its evoke cost was paid") and BLITZ's end-step sacrifice (CR
 * 702.152a). The plain `sacrificeSelf` would also sacrifice a bounced-and-
 * recast body (a new object, CR 400.7) the moment the OLD rider fired; the
 * stamp check is what keeps it to the permanent the rider was made for.
 * Params: `castWith` — the kind the stamp must read.
 */
export const sacrificeSelfIfCastWith: EffectPrimitive = (ctx) => {
  const self = permanentById(ctx.state, ctx.source.instanceId);
  const kind = strParam(ctx, 'castWith');
  if (!self || kind === undefined || self.castWith !== kind) return;
  sacrificePermanent(ctx, self);
};

/**
 * `returnSelfToHand` — DASH's rider (CR 702.109a): "return the permanent this
 * spell becomes to its owner's hand at the beginning of the next end step".
 */
export const returnSelfToHand: EffectPrimitive = (ctx) => {
  const self = permanentById(ctx.state, ctx.source.instanceId);
  if (!self || self.castWith !== 'dash') return;
  movePermanentTo(ctx, self, 'hand');
};

/**
 * `warpExile` — WARP's rider (CR 702.185a): "exile the permanent this spell
 * becomes at the beginning of the next end step. Its owner may cast this card
 * after the current turn has ended for as long as it remains exiled." The
 * permission is a card GRANT — the list that prunes itself when its card
 * changes zones — opening after this turn, for the card's printed cost.
 */
export const warpExile: EffectPrimitive = (ctx) => {
  const self = permanentById(ctx.state, ctx.source.instanceId);
  if (!self || self.castWith !== 'warp') return;
  movePermanentTo(ctx, self, 'exile');
  addCardGrant(
    ctx.state,
    {
      targetInstanceId: self.instanceId,
      sourceInstanceId: self.instanceId,
      zone: 'exile',
      duration: 'permanent',
      castFace: 'front',
      castAfterTurn: ctx.state.turnNumber,
    },
    ctx.emit,
  );
};

/** The family's primitives, spread into `CORE_PRIMITIVES`. */
export const CAST_ALTERNATIVE_PRIMITIVES: Readonly<Record<string, EffectPrimitive>> = Object.freeze({
  sacrificeSelfIfCastWith,
  returnSelfToHand,
  warpExile,
});
