/**
 * Shared, pure copy for the GRAVEYARD panel both play UIs open (hotseat and
 * online) — the flashback affordance's why-disabled treatment (DESIGN §3.11's
 * "an affordance must explain itself" rule, extended from the hand to the
 * graveyard).
 *
 * Honesty rule, same as `why-disabled.ts`: every message must be TRUE from the
 * information the board actually has. The board knows whether the card HAS a
 * flashback cost, whose priority it is, and the step — it cannot always tell
 * timing from mana for a card it merely failed to fund, so that case names both.
 */

/** The badge stamped on a graveyard card the player can flashback right now. */
export const GRAVEYARD_CAST_BADGE = 'flashback';

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
