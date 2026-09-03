/**
 * The ACTION-BAR HINT rule (pure, unit-tested) — one copy of the per-step hint
 * for BOTH boards, so the two can't drift (they had already drifted on the
 * main-phase line, which is why the wording is a parameter, not a fork).
 *
 * The §3.57 fix lives in the declare-attackers branch: the old hint said
 * "…or attack with none" even when the seat had NO creatures and the only
 * button on screen was "Pass priority" — the engine offers no declare-attackers
 * action at all for an empty board, so the copy described a button that did
 * not exist. The hint now matches reality.
 *
 * §3.59 fixes the same defect on the OTHER side of combat, found by driving the
 * shipped build: a defender with an empty board read "Tap an attacker, then
 * your creature, to block", which names a creature they do not have. Both
 * combat steps now follow one shape — am I the one DECLARING (else I am merely
 * responding), and do I have anything to declare WITH (else say so plainly) —
 * because two branches written to the same shape cannot drift apart the way the
 * attack and block copy silently did.
 */

/** What the hint needs to know about the frame. */
export interface HintContext {
  /**
   * This viewer is the ACTIVE player in their own declare-attackers window —
   * false for the defender holding priority in the same step, who is
   * RESPONDING, not declaring.
   */
  readonly isAttackWindow: boolean;
  /** The engine/server offered at least one eligible attacker. */
  readonly hasAttackers: boolean;
  /**
   * This viewer is the DEFENDER in their own declare-blockers window — false
   * for the attacking seat holding priority in the same step, who is
   * RESPONDING, not blocking. (The mirror of `isAttackWindow`.)
   */
  readonly isBlockWindow: boolean;
  /** This viewer controls at least one creature that could be assigned to block. */
  readonly hasBlockers: boolean;
  /** The defender controls at least one attackable planeswalker. */
  readonly hasEnemyWalkers: boolean;
  /**
   * Which main-phase wording this board uses. The two boards teach slightly
   * different flows on purpose (online explains manual tapping); everything
   * else is shared copy.
   */
  readonly mainPhaseFlavor: 'hotseat' | 'online';
}

/** The copy shown when the seat has nothing to attack with (§3.57 report 4). */
export const NO_ATTACKERS_HINT = 'You have no attackers — pass to continue.';

/**
 * The copy shown when the DEFENDER has nothing to block with (§3.59). It names
 * the "No blocks" button rather than "pass", because that button is the one
 * both boards render for the whole block step — including this case, which is
 * exactly why the old copy was misleading rather than merely useless.
 */
export const NO_BLOCKERS_HINT = 'You have no creatures to block with — confirm no blocks.';

const MAIN_PHASE_HINTS: Readonly<Record<HintContext['mainPhaseFlavor'], string>> = Object.freeze({
  hotseat: 'Play a land or cast a spell from your hand, or pass to advance.',
  online: 'Play a land, tap your sources for mana, then cast from your hand — or pass to advance.',
});

const RESPONSE_HINT = 'Cast instants in response, or pass priority to continue.';

/**
 * What the hint needs to know about the STACK (§3.119). Bug reports
 * 20260901_212245 and 20260901_213414: a spell or trigger of the player's own
 * sat on the stack waiting for a pass while the bar read "Play a land or cast a
 * spell from your hand" — copy for an empty stack, shown over a full one. A
 * non-empty stack is its own situation and gets its own copy, whatever the
 * step: the player has to know that the next click RESOLVES something.
 */
export interface StackHintContext {
  /** The top object's display name ("Thragtusk", "Enters: you gain 5 life"). */
  readonly topName: string;
  /** Whether the top object is the viewer's own. */
  readonly topIsMine: boolean;
  /** Whether the viewer has an instant-speed play they could respond with. */
  readonly canRespond: boolean;
}

/** The copy shown when the stack is non-empty and the viewer holds priority. */
export function stackHint(ctx: StackHintContext): string {
  const whose = ctx.topIsMine ? 'Your' : 'Their';
  const respond = ctx.canRespond ? ' — or respond first with an instant or an ability' : '';
  return `${whose} ${ctx.topName} is waiting to resolve. Resolve it${respond}.`;
}

/** The pass button's label — it RESOLVES when something is on the stack. */
export function passButtonLabel(step: string, stackNonEmpty: boolean): string {
  if (stackNonEmpty) return 'Resolve';
  if (step === 'declareAttackers' || step === 'declareBlockers') return 'Pass priority';
  return 'Pass / advance';
}

/** The per-step action-bar hint (see the module doc). */
export function actionBarHint(step: string, ctx: HintContext, stack?: StackHintContext): string {
  // The stack outranks the step: whatever step we are in, a full stack means
  // the next pass resolves something, and that is what the copy must say.
  if (stack) return stackHint(stack);
  switch (step) {
    case 'precombatMain':
    case 'postcombatMain':
      return MAIN_PHASE_HINTS[ctx.mainPhaseFlavor];
    case 'declareAttackers':
      // The defender (or anyone who is not declaring) is just responding here.
      if (!ctx.isAttackWindow) return RESPONSE_HINT;
      if (!ctx.hasAttackers) return NO_ATTACKERS_HINT;
      return ctx.hasEnemyWalkers
        ? 'Tap your creatures to attack, then click an enemy planeswalker to attack it instead of the player. Confirm when done.'
        : 'Tap your creatures to attack, then confirm — or attack with none.';
    case 'declareBlockers':
      // Same shape as the attack branch above: declaring, or just responding?
      if (!ctx.isBlockWindow) return RESPONSE_HINT;
      if (!ctx.hasBlockers) return NO_BLOCKERS_HINT;
      return 'Tap an attacker, then your creature, to block. Confirm when done.';
    default:
      return RESPONSE_HINT;
  }
}
