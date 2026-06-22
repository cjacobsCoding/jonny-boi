/**
 * Pure helpers that derive the in-game UI's affordances from the server's
 * `legalActions` list. The server is authoritative — we ONLY ever offer a control for
 * an action it sent, so an illegal move can't be constructed client-side. Keeping
 * this pure makes it trivially testable and keeps the board component thin.
 */
import type { GameAction, InstanceId, PlayerId } from '@jonny-boi/core';

/** A castable spell offered by the server, with whatever targets it sent. */
export interface CastChoice {
  readonly instanceId: InstanceId;
  /** Distinct legal target sets the server already enumerated for this spell. */
  readonly targetSets: readonly ReadonlyArray<InstanceId | PlayerId>[];
  /** True if a no-target cast is legal. */
  readonly canCastUntargeted: boolean;
}

/** The set of hand-card instance ids the viewer may play as a land. */
export function playableLandIds(actions: readonly GameAction[]): ReadonlySet<InstanceId> {
  const ids = new Set<InstanceId>();
  for (const a of actions) if (a.kind === 'playLand') ids.add(a.instanceId);
  return ids;
}

/** Group the legal `castSpell` actions by the spell's hand instance. */
export function castChoices(actions: readonly GameAction[]): ReadonlyMap<InstanceId, CastChoice> {
  const byInstance = new Map<InstanceId, { sets: ReadonlyArray<InstanceId | PlayerId>[]; untargeted: boolean }>();
  for (const a of actions) {
    if (a.kind !== 'castSpell') continue;
    const entry = byInstance.get(a.instanceId) ?? { sets: [], untargeted: false };
    const targets = a.targets ?? [];
    if (targets.length === 0) entry.untargeted = true;
    else entry.sets.push(targets);
    byInstance.set(a.instanceId, entry);
  }
  const out = new Map<InstanceId, CastChoice>();
  for (const [instanceId, { sets, untargeted }] of byInstance) {
    out.set(instanceId, { instanceId, targetSets: sets, canCastUntargeted: untargeted });
  }
  return out;
}

/** The single legal `declareAttackers` action (the full eligible set), if offered. */
export function declareAttackersAction(
  actions: readonly GameAction[],
): Extract<GameAction, { kind: 'declareAttackers' }> | null {
  for (const a of actions) if (a.kind === 'declareAttackers') return a;
  return null;
}

/** The single legal `declareBlockers` action template, if offered. */
export function declareBlockersAction(
  actions: readonly GameAction[],
): Extract<GameAction, { kind: 'declareBlockers' }> | null {
  for (const a of actions) if (a.kind === 'declareBlockers') return a;
  return null;
}

/** True if passing priority / advancing is currently legal. */
export function canPass(actions: readonly GameAction[]): boolean {
  return actions.some((a) => a.kind === 'passPriority');
}

/** The pass action's owning player, if a pass is legal. */
export function passAction(
  actions: readonly GameAction[],
): Extract<GameAction, { kind: 'passPriority' }> | null {
  for (const a of actions) if (a.kind === 'passPriority') return a;
  return null;
}
