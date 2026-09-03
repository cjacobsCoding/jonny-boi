/**
 * SPLIT SECOND (CR 702.61) — "as long as this spell is on the stack, players
 * can't cast spells or activate abilities that aren't mana abilities."
 *
 * One predicate, read from both sides of the engine (DESIGN §3.107):
 *   - the OFFER pass (`generateLegalActions`) filters casts, cyclings and
 *     non-mana activations out of the menu while it holds;
 *   - the APPLY paths (`applyCastSpell`, `applyActivateAbility`,
 *     `applyCycleCard`) refuse the same actions, because the engine — not the
 *     menu — is the authority, and a pilot or UI that builds its own action
 *     must meet the same wall.
 *
 * What it does NOT lock, and why (CR 702.61b): mana abilities (`tapForMana` is
 * its own action kind and is never filtered), special actions, and triggered
 * abilities — those still trigger and resolve, so nothing here touches the
 * trigger collector or the stack.
 *
 * PERF: a walk of the stack, which is almost always empty and never more than
 * a few objects deep. The keyword is read off the spell's own definition — a
 * spell on the stack is not a permanent, so the continuous layer does not
 * apply to it (CR 613 modifies objects on the battlefield).
 */

import type { GameState } from './state.js';

/** Whether a spell with split second is currently on the stack. */
export function splitSecondOnStack(state: GameState): boolean {
  const stack = state.stack;
  for (let i = 0; i < stack.length; i++) {
    const object = stack[i]!;
    if (object.kind === 'spell' && object.card.def.keywords?.splitSecond === true) return true;
  }
  return false;
}

/** The rejection every locked action reports — one wording, three apply paths. */
export const SPLIT_SECOND_REJECTION =
  'a spell with split second is on the stack: players can\'t cast spells or activate abilities that aren\'t mana abilities (CR 702.61)';
