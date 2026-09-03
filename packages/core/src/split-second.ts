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

/**
 * §3.123 — THE MENU WITH EVERYTHING CR 702.61 LOCKS REMOVED.
 *
 * `generateLegalActions` has TWO exits — the ordinary one and the early return
 * for an open madness / suspend / cascade / ripple window — and only the
 * ordinary one applied the lock. A window's cast is a cast, so a split-second
 * spell standing while a window is open produced a menu entry
 * `applyCastSpell` then refused: the §3.36 offer/apply disagreement, in the
 * engine itself. One filter, both exits, so a third exit cannot be added
 * without meeting it.
 *
 * WHAT SURVIVES: mana abilities (`tapForMana`), passing, the combat
 * declarations, and a land play — none of them is a spell or a non-mana
 * ability, so 702.61 does not reach them. The land play is listed for
 * completeness rather than because it is reachable: CR 305.1 lets you play a
 * land only with an EMPTY stack, and this lock only holds with a non-empty one,
 * so the two never actually coexist. Written down because the first draft of
 * §3.123's pilot gate carved out an exception for exactly that case, and a test
 * proved the exception could never fire.
 *
 * Returns the array unchanged when the lock does not hold, so the common case
 * pays one length check and a walk of an almost-always-empty stack.
 */
export function withoutSplitSecondLocked<T extends { readonly kind: string }>(
  state: GameState,
  actions: readonly T[],
): readonly T[] {
  if (state.stack.length === 0 || !splitSecondOnStack(state)) return actions;
  return actions.filter((a) => a.kind !== 'castSpell' && a.kind !== 'activateAbility' && a.kind !== 'cycleCard');
}

/** The rejection every locked action reports — one wording, three apply paths. */
export const SPLIT_SECOND_REJECTION =
  'a spell with split second is on the stack: players can\'t cast spells or activate abilities that aren\'t mana abilities (CR 702.61)';
