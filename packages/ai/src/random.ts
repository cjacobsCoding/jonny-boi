/**
 * The `random` pilot — the determinism baseline and a control in sims.
 *
 * It picks a uniformly random legal action using the *injected seeded RNG*, so a
 * given seed reproduces the exact same sequence of choices (no `Math.random`).
 * It only ever returns an action straight from `legalActions`, so it can never
 * produce an illegal move; if the list is empty it falls back to passing priority
 * for whoever holds it, which the engine accepts or harmlessly rejects.
 */

import type { GameAction, GameState } from '@jonny-boi/core';
import { safeFallbackAction } from './choices.js';
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
        // Defensive: nothing offered. Take the move that is always accepted — a
        // priority pass normally, or the default answer while a choice is parked
        // (where passing would be rejected).
        const fallback = safeFallbackAction(view as unknown as GameState);
        ctx.trace?.({ action: fallback, reason: 'no legal actions — forced move' });
        return fallback;
      }
      const index = rng.nextInt(legalActions.length);
      // index is always in [0, length) so this element exists.
      const choice = legalActions[index] as GameAction;
      // Guarded rather than `ctx.trace?.({...})`: the optional call still builds
      // the trace object and formats its reason first, and this pilot is one of
      // MCTS's rollout policies — thousands of calls per look-ahead decision,
      // every one of them with no trace sink attached.
      if (ctx.trace) ctx.trace({ action: choice, reason: `random pick ${index + 1}/${legalActions.length}` });
      return choice;
    },
  };
}
