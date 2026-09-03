/**
 * ATTACK REQUIREMENTS, mirrored for the pilots (DESIGN §3.107).
 *
 * "~ attacks each combat if able" (CR 508.1d) makes a declaration that leaves
 * the creature home ILLEGAL, and the engine rejects it wholesale — the pilot
 * would then lose every other attacker in the same action and, after the
 * harness's rejection limit, attack with nothing but the forced minimum the
 * engine declares on its behalf. So every place a pilot BUILDS an attack roster
 * runs it through {@link withRequiredAttackers} before submitting.
 *
 * The answer comes from core's own `requiredAttackerIds`, not a re-statement of
 * the rule here, for the reason `forcedBlockAssignment` is shared with the block
 * solver: two readers of one rule eventually disagree, and the bug is
 * attributed to neither.
 */

import type { CardInstance, ContinuousIndex, GameState, InstanceId } from '@jonny-boi/core';
import { requiredAttackerIds } from '@jonny-boi/core';
import type { PilotView } from './pilot.js';

/**
 * The battlefield a read-only view holds, typed for the core helpers that take
 * one. One cast, here, rather than one at every call site.
 */
export function boardOf(view: PilotView | GameState): readonly CardInstance[] {
  return (view as GameState).battlefield;
}

/**
 * `chosen`, plus every creature in `eligible` the active player is REQUIRED to
 * attack with. Returns `chosen` itself (same reference) when nothing had to be
 * added, so the common board — no requirement anywhere — allocates nothing.
 *
 * `eligible` must be the engine's own offered `declareAttackers.attackers`
 * list: a required creature the engine did not offer is one it judged unable
 * to attack, and "if able" says it is then not required at all.
 */
export function withRequiredAttackers(
  view: PilotView | GameState,
  index: ContinuousIndex,
  chosen: readonly InstanceId[],
  eligible: readonly InstanceId[],
): readonly InstanceId[] {
  const state = view as GameState;
  const defender = state.activePlayer === 'A' ? 'B' : 'A';
  const required = requiredAttackerIds(state, index, defender);
  if (required.length === 0) return chosen;
  let roster: InstanceId[] | undefined;
  for (let i = 0; i < required.length; i++) {
    const id = required[i] as InstanceId;
    if (chosen.includes(id) || !eligible.includes(id)) continue;
    (roster ??= [...chosen]).push(id);
  }
  return roster ?? chosen;
}
