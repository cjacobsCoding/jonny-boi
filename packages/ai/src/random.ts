/**
 * The `random` pilot — the determinism baseline and a control in sims.
 *
 * It picks a uniformly random legal action using the *injected seeded RNG*, so a
 * given seed reproduces the exact same sequence of choices (no `Math.random`).
 * It only ever returns an action straight from `legalActions`, so it can never
 * produce an illegal move; if the list is empty it falls back to passing priority
 * for whoever holds it, which the engine accepts or harmlessly rejects.
 */

import type { GameAction } from '@jonny-boi/core';
import type { DecisionContext, Pilot } from './pilot.js';

/** The id the random pilot registers under and is selected by from data. */
export const RANDOM_PILOT_ID = 'random';

/**
 * Build the random pilot. A factory (not a singleton) to match the registry's
 * factory model, though the random pilot is stateless.
 */
export function createRandomPilot(): Pilot {
  return {
    id: RANDOM_PILOT_ID,
    description: 'Picks a uniformly random legal action (seeded). Determinism baseline / control.',
    chooseAction(ctx: DecisionContext): GameAction {
      const { legalActions, rng, view } = ctx;
      if (legalActions.length === 0) {
        // Defensive: nothing offered. Pass priority for the current holder.
        const fallback: GameAction = { kind: 'passPriority', player: view.priorityPlayer };
        ctx.trace?.({ action: fallback, reason: 'no legal actions — passing' });
        return fallback;
      }
      const index = rng.nextInt(legalActions.length);
      // index is always in [0, length) so this element exists.
      const choice = legalActions[index] as GameAction;
      ctx.trace?.({ action: choice, reason: `random pick ${index + 1}/${legalActions.length}` });
      return choice;
    },
  };
}
