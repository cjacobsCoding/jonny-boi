/**
 * Say WHY a hand card can't be played right now.
 *
 * A greyed card that gives no reason is the difference between "the rules say not
 * yet" and "this app is broken" — and online play read as the second: the hand went
 * dead in `upkeep` with the action bar still saying "Your move", so clicking felt
 * like a dropped input rather than an illegal move. `auto-pass.ts` removes most of
 * those windows; this covers the ones that remain (a second land, a spell you can't
 * fund, an opponent's turn) by putting the reason on the card itself.
 *
 * Honesty rule: every message here must be TRUE from the information available. The
 * board knows the step, whose turn it is, and whether the server offered the action —
 * it does NOT know a card's timing restrictions or its cost, so the non-land case
 * stays deliberately general instead of guessing "not enough mana" and being wrong.
 */

/** The two steps in which a land may be played (and sorcery-speed spells cast). */
export function isMainPhase(step: string): boolean {
  return step === 'precombatMain' || step === 'postcombatMain';
}

/** Board context a disabled hand card is judged against. */
export interface DisabledContext {
  /** Does this seat hold priority? */
  readonly yourTurn: boolean;
  /** Is this seat the active player (whose turn it is)? */
  readonly yourTurnToAct: boolean;
  /** The current step. */
  readonly step: string;
  /** Display name of whoever currently holds priority. */
  readonly waitingOn: string;
  /** Did the server offer a `playLand` for ANY card this window? */
  readonly anyLandOffered: boolean;
}

/**
 * A one-line reason the given hand card is not actionable, or `undefined` when it
 * actually is playable (callers only render this for disabled cards, but returning
 * `undefined` keeps the function total and safe to call unconditionally).
 */
export function reasonCardIsDisabled(
  ctx: DisabledContext,
  card: { readonly isLand: boolean },
): string | undefined {
  if (!ctx.yourTurn) return `Waiting for ${ctx.waitingOn} — you don't have priority yet.`;

  if (card.isLand) {
    if (!ctx.yourTurnToAct) return 'You can only play a land on your own turn.';
    if (!isMainPhase(ctx.step)) return 'Lands can only be played in your main phase.';
    if (!ctx.anyLandOffered) return "You've already played a land this turn.";
    return undefined;
  }

  // Timing and cost are both plausible and we cannot tell them apart from the
  // masked view, so name both rather than assert the wrong one.
  return isMainPhase(ctx.step)
    ? "Can't cast this yet — tap lands for mana, or it costs more than you can pay."
    : 'Only instant-speed plays are allowed in this step.';
}

/**
 * The action-bar note for a seat that holds priority but has no play available —
 * the state that read as a frozen app. Returns `undefined` when the player does
 * have something to do, so the normal hint stands.
 */
export function idleTurnNote(input: {
  readonly yourTurn: boolean;
  readonly hasAnyPlay: boolean;
  readonly step: string;
}): string | undefined {
  if (!input.yourTurn || input.hasAnyPlay) return undefined;
  return isMainPhase(input.step)
    ? "Nothing you can play right now — press Pass / advance to move on."
    : `Nothing to do in this step — press Pass / advance to reach your main phase.`;
}
