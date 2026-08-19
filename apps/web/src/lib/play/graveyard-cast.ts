/**
 * The PURE view-model for the GRAVEYARD panel both play UIs open (hotseat and
 * online) — the flashback affordance. One function decides what each graveyard
 * card looks like, so the two boards cannot drift apart and a test can assert the
 * exact props the panel renders without re-deriving them.
 *
 * Honesty rule, same as `why-disabled.ts`: every message must be TRUE from the
 * information the board actually has. The board knows whether the card HAS a
 * flashback cost, whose priority it is, and the step — it cannot always tell
 * timing from mana for a card it merely failed to fund, so that case names both.
 */
import type { InstanceId } from '@jonny-boi/core';

/** The badge stamped on a graveyard card the player can flashback right now. */
export const GRAVEYARD_CAST_BADGE = 'flashback';

/** One graveyard card as the board knows it, before the panel judges it. */
export interface GraveyardCard {
  readonly instanceId: InstanceId;
  readonly cardId: string;
  readonly name: string;
  /** Does the card print a flashback cost at all? (Most graveyard cards do not.) */
  readonly hasFlashback: boolean;
}

/** One graveyard card as the panel renders it. */
export interface GraveyardCardView {
  readonly instanceId: InstanceId;
  readonly cardId: string;
  readonly name: string;
  /** Corner badge ("flashback") for a currently castable card. */
  readonly badge?: string;
  /** True when clicking the card starts a cast (routed by the board). */
  readonly actionable: boolean;
  /** Why the card is NOT castable right now (tooltip on a disabled card). */
  readonly reason?: string;
}

/**
 * Judge every graveyard card for the panel. `castableIds` is the union of the
 * casts the engine/server already offers and the ones the seat could fund by
 * tapping first — the board computes it, this decides what it looks like.
 */
export function graveyardPanelView(
  cards: readonly GraveyardCard[],
  castableIds: ReadonlySet<InstanceId>,
  ctx: GraveyardDisabledContext,
): GraveyardCardView[] {
  return cards.map((c) => {
    const actionable = ctx.yourTurn && castableIds.has(c.instanceId);
    return {
      instanceId: c.instanceId,
      cardId: c.cardId,
      name: c.name,
      badge: actionable ? GRAVEYARD_CAST_BADGE : undefined,
      actionable,
      reason: actionable ? undefined : reasonGraveyardCardIsDisabled(ctx, c),
    };
  });
}

/** Board context a disabled graveyard card is judged against. */
export interface GraveyardDisabledContext {
  /** Does this seat hold priority (hotseat: is it the viewer's window)? */
  readonly yourTurn: boolean;
  /** Display name of whoever currently holds priority / must act. */
  readonly waitingOn: string;
  /** The current step. */
  readonly step: string;
}

/** The two steps in which sorcery-speed flashback is castable. */
function isMainPhase(step: string): boolean {
  return step === 'precombatMain' || step === 'postcombatMain';
}

/**
 * A one-line reason the given graveyard card is not castable right now, or
 * `undefined` when it actually is. Total: safe to call for every card in the
 * panel, actionable or not.
 */
export function reasonGraveyardCardIsDisabled(
  ctx: GraveyardDisabledContext,
  card: { readonly hasFlashback: boolean },
): string | undefined {
  // The permanent truth first: most graveyard cards are simply not castable
  // from there, and that must never read as "wrong moment, try later".
  if (!card.hasFlashback) return 'This card has no flashback — it stays in the graveyard.';
  if (!ctx.yourTurn) return `Waiting for ${ctx.waitingOn} — you don't have priority yet.`;
  return isMainPhase(ctx.step)
    ? "Can't flashback this yet — tap lands for mana, or it costs more than you can pay."
    : 'Only instant-speed flashback is allowed in this step.';
}
