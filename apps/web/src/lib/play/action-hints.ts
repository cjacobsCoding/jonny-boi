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

const MAIN_PHASE_HINTS: Readonly<Record<HintContext['mainPhaseFlavor'], string>> = Object.freeze({
  hotseat: 'Play a land or cast a spell from your hand, or pass to advance.',
  online: 'Play a land, tap your sources for mana, then cast from your hand — or pass to advance.',
});

const RESPONSE_HINT = 'Cast instants in response, or pass priority to continue.';

/** The per-step action-bar hint (see the module doc). */
export function actionBarHint(step: string, ctx: HintContext): string {
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
      return 'Tap an attacker, then your creature, to block. Confirm when done.';
    default:
      return RESPONSE_HINT;
  }
}
