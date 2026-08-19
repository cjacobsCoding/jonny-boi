/**
 * Pure helpers that derive the in-game UI's affordances from the server's
 * `legalActions` list. The server is authoritative — we ONLY ever offer a control for
 * an action it sent, so an illegal move can't be constructed client-side. Keeping
 * this pure makes it trivially testable and keeps the board component thin.
 */
import type { CardDefinition, CastZone, GameAction, InstanceId, PlayerId } from '@jonny-boi/core';
import type { AbilityOption, AbilityTargetChoice } from '../play/session.js';

/** A castable spell offered by the server, with whatever targets it sent. */
export interface CastChoice {
  readonly instanceId: InstanceId;
  /** Distinct legal target sets the server already enumerated for this spell. */
  readonly targetSets: readonly ReadonlyArray<InstanceId | PlayerId>[];
  /** True if a no-target cast is legal. */
  readonly canCastUntargeted: boolean;
  /**
   * The zone the cast leaves from. `'hand'` for an ordinary cast (the action's
   * omitted default), `'graveyard'` for a flashback cast — the submitted action
   * must echo it back or the server looks for the card in the wrong zone.
   */
  readonly fromZone: CastZone;
}

/** The set of hand-card instance ids the viewer may play as a land. */
export function playableLandIds(actions: readonly GameAction[]): ReadonlySet<InstanceId> {
  const ids = new Set<InstanceId>();
  for (const a of actions) if (a.kind === 'playLand') ids.add(a.instanceId);
  return ids;
}

/** Group the legal `castSpell` actions cast from `zone` by the spell's instance. */
function castChoicesFrom(
  actions: readonly GameAction[],
  zone: CastZone,
): ReadonlyMap<InstanceId, CastChoice> {
  const byInstance = new Map<InstanceId, { sets: ReadonlyArray<InstanceId | PlayerId>[]; untargeted: boolean }>();
  for (const a of actions) {
    if (a.kind !== 'castSpell') continue;
    if ((a.fromZone ?? 'hand') !== zone) continue;
    const entry = byInstance.get(a.instanceId) ?? { sets: [], untargeted: false };
    const targets = a.targets ?? [];
    if (targets.length === 0) entry.untargeted = true;
    else entry.sets.push(targets);
    byInstance.set(a.instanceId, entry);
  }
  const out = new Map<InstanceId, CastChoice>();
  for (const [instanceId, { sets, untargeted }] of byInstance) {
    out.set(instanceId, { instanceId, targetSets: sets, canCastUntargeted: untargeted, fromZone: zone });
  }
  return out;
}

/**
 * The legal HAND casts, grouped per card. Deliberately excludes flashback offers:
 * a graveyard cast's instance is not in the hand, so a mixed map would silently
 * hide those offers behind hand-only rendering (which is exactly what happened —
 * flashback was legal online and invisible).
 */
export function castChoices(actions: readonly GameAction[]): ReadonlyMap<InstanceId, CastChoice> {
  return castChoicesFrom(actions, 'hand');
}

/** The legal GRAVEYARD (flashback) casts, grouped per card. */
export function graveyardCastChoices(
  actions: readonly GameAction[],
): ReadonlyMap<InstanceId, CastChoice> {
  return castChoicesFrom(actions, 'graveyard');
}

/**
 * The activatable abilities in the server's menu, grouped per source permanent —
 * the ONLINE twin of `GameSession.abilityOptions()` (same folding rule: one
 * offered action per legal target folds into one option carrying a target menu).
 * `findDef` resolves an instance id to its definition from the PUBLIC battlefield
 * of the masked view, which is where every activatable permanent lives; `nameFor`
 * labels a target id the same way. Driven by the server's `legalActions` alone,
 * so an ability the engine did not offer can never appear.
 */
export function abilityChoices(
  actions: readonly GameAction[],
  findDef: (id: InstanceId) => CardDefinition | undefined,
  nameFor: (target: InstanceId | PlayerId) => string,
): readonly AbilityOption[] {
  const byAbility = new Map<string, AbilityOption>();
  for (const action of actions) {
    if (action.kind !== 'activateAbility') continue;
    const key = `${action.instanceId}:${action.abilityIndex}`;
    const def = findDef(action.instanceId);
    const printed = def?.activated?.[action.abilityIndex];
    const base = {
      instanceId: action.instanceId,
      sourceName: def?.name ?? `#${action.instanceId}`,
      abilityIndex: action.abilityIndex,
      label: printed?.label ?? `Ability ${action.abilityIndex + 1}`,
    };
    const existing = byAbility.get(key);
    const offeredTarget = action.targets?.[0];
    if (offeredTarget === undefined) {
      if (!existing) byAbility.set(key, { ...base, targets: null });
      continue;
    }
    const choice: AbilityTargetChoice = { target: offeredTarget, label: nameFor(offeredTarget) };
    byAbility.set(key, { ...base, targets: [...(existing?.targets ?? []), choice] });
  }
  return [...byAbility.values()];
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
