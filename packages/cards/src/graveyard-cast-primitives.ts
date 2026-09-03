/**
 * THE GRAVEYARD-CASTING FAMILY (DESIGN §3.111) — the bodies of the abilities
 * that function while a card is in a graveyard: unearth (CR 702.84), scavenge
 * (702.96), embalm (702.128), eternalize (702.129), encore (702.141), and the
 * printed "return ~ from your graveyard to your hand" (an activated ability,
 * Rancor's trigger, "when ~ dies, return it to its owner's hand").
 *
 * Every one of these runs with `ctx.source` OFF the battlefield — in the
 * graveyard (unearth, the return template) or already in exile, because the
 * printed "Exile this card from your graveyard" is a COST core charged as the
 * ability was activated (CR 702.96a et al.). `frameSource` resolves a source
 * anywhere, so `ctx.source` here IS the card, wherever it sits; nothing in
 * this file re-reads the battlefield for it, and that is the one thing that
 * separates these bodies from their battlefield cousins (`createTokenCopy`
 * with `self`, which re-reads the battlefield on purpose).
 *
 * The verbs are shared, never re-implemented: the battlefield entry is
 * `putOntoBattlefield`, the counters go through the one CR 614 counter site,
 * the token copy is core's `tokenCopyDefOf` (CR 707.2 — the copiable values,
 * so a scavenged or embalmed card wearing counters when it died copies as
 * printed), the haste grant and the end-step removal are the Kiki-Jiki helpers
 * `grantToCreated` / `createDelayedRemoval`.
 */

import type { CopyExceptions, EffectContext, EffectPrimitive, InstanceId } from '@jonny-boi/core';
import { PLAYER_IDS, isCreature, tokenCopyDefOf } from '@jonny-boi/core';
import { createDelayedRemoval, grantToCreated } from './copy-primitives.js';
import { boolParam, moveOwnedCard, firstPermanentTarget, putOntoBattlefield, strParam } from './effect-helpers.js';
import { putCountersOfKind } from './upkeep-cost-primitives.js';

/** The +1/+1 counter kind, as `CardInstance.counters` keys it. */
const PLUS_ONE = '+1/+1';

/**
 * `unearthReturn` — CR 702.84a: "Return this card from your graveyard to the
 * battlefield. It gains haste. Exile it at the beginning of the next end step
 * or if it would leave the battlefield."
 *
 * Three printed sentences, three existing seams:
 *  - the return is the one battlefield-entry helper, under the ACTIVATOR's
 *    control (the card is in its owner's graveyard; "your graveyard" makes the
 *    two the same player on every printed card, and `controller` says so
 *    rather than assuming it);
 *  - "it gains haste" is a layer-6 grant on the object (the Kiki-Jiki
 *    reasoning in `grantToCreated`: a grant is not a copiable value, so a
 *    token copy of an unearthed creature does NOT inherit it), AND an unsick
 *    entry — because the entry helper reads only PRINTED haste, and the
 *    §3.106 precedent (suspend's `hasteOnEntry`) is that haste at entry is
 *    `!summoningSick`. A noncreature (Mishra's Research Desk) gets neither:
 *    its printed line omits the sentence;
 *  - "exile it at the beginning of the next end step" is the same delayed
 *    ability Twinflame creates, declared to the pilot as a removal; "or if it
 *    would leave the battlefield" is the instance flag both leave funnels ask
 *    (CR 702.84c — `leaveBattlefieldDestination`).
 *
 * A card that left the graveyard in response does nothing — the printed
 * ability does nothing either.
 */
export const unearthReturn: EffectPrimitive = (ctx) => {
  const source = ctx.source;
  const returned = putOntoBattlefield(ctx, source.owner, source.instanceId, 'graveyard', {
    controller: ctx.controller,
  });
  if (!returned) return;
  if (isCreature(returned.def)) {
    returned.summoningSick = false;
    ctx.addContinuousEffect({ target: returned.instanceId, duration: 'permanent', keywords: { haste: true } });
  }
  returned.exileIfLeaves = true;
  ctx.createDelayedTrigger({
    condition: { on: 'endStep', who: 'any' },
    effects: [{ primitive: 'exileNamed', params: { instanceIds: [returned.instanceId] } }],
    label: `Unearth: exile ${returned.def.name} at the beginning of the next end step`,
    removesFromBattlefield: [returned.instanceId],
  });
};

/**
 * `scavengeCounters` — CR 702.96a: "Put a number of +1/+1 counters equal to
 * this card's power on target creature."
 *
 * "This card's power" is the PRINTED power of the card now in exile (the exile
 * was the cost); the compiler refuses scavenge on a card whose power is a
 * characteristic-defining `*`, so the number here is always the printed one.
 * The target is re-checked at resolution exactly as every targeting primitive
 * does, and the counters go through the one CR 614 counter site, so Hardened
 * Scales applies to a scavenge as it does to anything else.
 */
export const scavengeCounters: EffectPrimitive = (ctx) => {
  const target = firstPermanentTarget(ctx);
  if (!target || !isCreature(target.def)) return;
  const amount = Math.max(0, ctx.source.def.power ?? 0);
  if (amount === 0) return;
  putCountersOfKind(ctx, target, PLUS_ONE, amount);
};

/**
 * `graveyardTokenCopy` — "Create a token that's a copy of it, except …"
 * (embalm, CR 702.128a; eternalize, 702.129a) and encore's "For each opponent,
 * create a token copy that attacks that opponent this turn if able. They gain
 * haste. Sacrifice them at the beginning of the next end step." (702.141a).
 *
 * Params:
 *  - `except`        — the printed "except" tail in core's {@link CopyExceptions}
 *                      vocabulary (embalm: white, a Zombie, no mana cost;
 *                      eternalize: 4/4, black, a Zombie, no mana cost);
 *  - `perOpponent`   — one token per opponent (encore). In this two-player
 *                      engine that is exactly ONE token, which is the printed
 *                      count and not an approximation of it: CR 702.141a says
 *                      "for each opponent", and there is one;
 *  - `grantKeywords` / `delayedRemoval` — the Kiki-Jiki follow-up sentences,
 *                      read by the shared helpers. Encore's "attacks that
 *                      opponent this turn if able" is the `mustAttack` grant:
 *                      with one opponent, "that opponent" is the only player
 *                      the token could attack.
 *
 * The copied object is `ctx.source` — the card in exile — through
 * `tokenCopyDefOf` (CR 707.2: the copiable values, so a card that died wearing
 * counters copies as printed).
 */
export const graveyardTokenCopy: EffectPrimitive = (ctx) => {
  const source = ctx.source;
  const def = tokenCopyDefOf(source, exceptParam(ctx));
  const count = boolParam(ctx, 'perOpponent', false)
    ? PLAYER_IDS.filter((player) => player !== ctx.controller).length
    : 1;
  if (count <= 0) return;
  const created = ctx.createTokens(def, count);
  for (const instanceId of created) {
    ctx.emit({
      type: 'tokenCopyCreated',
      instanceId,
      copiedInstanceId: source.instanceId,
      controller: ctx.controller,
      name: def.name,
    });
  }
  grantToCreated(ctx, created);
  createDelayedRemoval(ctx, created);
};

/**
 * `returnSourceFromGraveyard` — "Return ~ from your graveyard to your hand"
 * as an activated ability of the card itself, and the body of "when ~ dies /
 * is put into a graveyard from the battlefield, return it to its owner's
 * hand" (Rancor). `params.to` is `'hand'` (the default) — a battlefield
 * destination is unearth's own primitive, because unearth's riders are not
 * this sentence's.
 *
 * The card goes to its OWNER's hand ("its owner's hand"), from its owner's
 * graveyard, through the one owned-zone funnel. A card no longer in the
 * graveyard (exiled in response) is left alone.
 */
export const returnSourceFromGraveyard: EffectPrimitive = (ctx) => {
  const to = strParam(ctx, 'to') === 'hand' || strParam(ctx, 'to') === undefined ? 'hand' : undefined;
  if (to === undefined) return; // an unknown destination is refused, never guessed
  const source = ctx.source;
  moveOwnedCard(ctx, source.owner, source.instanceId, 'graveyard', to);
};

/** The `except` param as a {@link CopyExceptions}, validated shallowly (the compiler never emits a malformed one). */
function exceptParam(ctx: EffectContext): CopyExceptions | undefined {
  const raw = ctx.params.except;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as CopyExceptions;
}

/** Re-exported for the pilot's valuation, which prices an unearth as one attack. */
export type { InstanceId };

/** The primitives this module contributes to the shared registry. */
export const GRAVEYARD_CAST_PRIMITIVES: Readonly<Record<string, EffectPrimitive>> = Object.freeze({
  unearthReturn,
  scavengeCounters,
  graveyardTokenCopy,
  returnSourceFromGraveyard,
});
