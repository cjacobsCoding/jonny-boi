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
  /**
   * Life this cast pays toward the cost's Phyrexian symbols (§3.143). Absent —
   * never `0` — for the all-mana reading, which is every cast bar a handful.
   *
   * Echoed on the submitted action for exactly the reason `fromZone` is. The
   * server offers one `castSpell` PER fundable life amount, so a cast that
   * dropped the field would ask for a reading the server may never have
   * offered: Dismember off a lone Wastes is offered at 4 life and at nothing
   * else, and submitting it at 0 is an action the server itself refuses.
   */
  readonly phyrexianLife?: number;
}

/** The reading that pays a cost entirely in mana — every cast bar §3.143's few. */
const ALL_MANA_READING = 0;

/** The set of hand-card instance ids the viewer may play as a land. */
export function playableLandIds(actions: readonly GameAction[]): ReadonlySet<InstanceId> {
  const ids = new Set<InstanceId>();
  // FRONT FACE ONLY. A modal DFC offers a land play for its BACK face
  // (`face: 'back'`), and this set carries only an instance id — so including it
  // would render a land button whose click submits a face-less `playLand` that
  // the engine rejects ("that card is not a land"). Until the board can offer
  // two faces per card, the back-face offer is not shown rather than shown
  // broken. See COORDINATION for the named gap.
  for (const a of actions) if (a.kind === 'playLand' && a.face === undefined) ids.add(a.instanceId);
  return ids;
}

/** Group the legal `castSpell` actions cast from `zone` by the spell's instance. */
function castChoicesFrom(
  actions: readonly GameAction[],
  zone: CastZone,
): ReadonlyMap<InstanceId, CastChoice> {
  const byInstance = new Map<
    InstanceId,
    { phyrexianLife: number; sets: ReadonlyArray<InstanceId | PlayerId>[]; untargeted: boolean }
  >();
  for (const a of actions) {
    if (a.kind !== 'castSpell') continue;
    if ((a.fromZone ?? 'hand') !== zone) continue;
    // FRONT FACE ONLY, for the same reason as `playableLandIds`: this map is
    // keyed on the instance alone, so a modal DFC's two offers would MERGE —
    // the back face's legal targets would appear on a menu that submits the
    // front face, which is a wrong action, not merely a missing one. The same
    // now applies to a SPLIT card's right half, an AFTERMATH half and an
    // ADVENTURE: this board offers the LEFT/primary half only. That is a
    // missing option rather than a wrong one, and the hotseat board (whose
    // options carry a face) offers both. Widening this map's key to
    // `instanceId:face` is what lifts the restriction.
    if (a.face !== undefined) continue;
    // §3.143 — the server offers one cast PER fundable Phyrexian life amount,
    // and this map holds ONE choice per instance, so the readings have to be
    // reconciled rather than merged. Merging them was a WRONG action, not a
    // missing one: the 4-life reading's legal targets would ride a button that
    // submits the 0-life cast the server never offered.
    //
    // The CHEAPEST reading wins — the least life — because this board has no
    // menu to ask on (see `auto-tap.ts`'s closing note) and life is not a
    // resource to spend on a player's behalf. `0` whenever the all-mana reading
    // is offered, which is every card in the game but a handful, so this is the
    // choice the map has always made for them.
    const phyrexianLife = a.phyrexianLife ?? ALL_MANA_READING;
    let entry = byInstance.get(a.instanceId);
    if (entry === undefined || phyrexianLife < entry.phyrexianLife) {
      entry = { phyrexianLife, sets: [], untargeted: false };
      byInstance.set(a.instanceId, entry);
    } else if (phyrexianLife > entry.phyrexianLife) {
      continue; // a dearer reading of a card whose cheap one is already held
    }
    const targets = a.targets ?? [];
    if (targets.length === 0) entry.untargeted = true;
    else entry.sets.push(targets);
  }
  const out = new Map<InstanceId, CastChoice>();
  for (const [instanceId, { phyrexianLife, sets, untargeted }] of byInstance) {
    out.set(instanceId, {
      instanceId,
      targetSets: sets,
      canCastUntargeted: untargeted,
      fromZone: zone,
      // Written only when it is not the default, so a choice for a cast that
      // pays no life is the object every consumer has always seen.
      ...(phyrexianLife === ALL_MANA_READING ? {} : { phyrexianLife }),
    });
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
 * The legal EXILE casts, grouped per card — a madness window's discarded card, a
 * free suspend/cascade window, an adventure's creature half after its adventure
 * resolved, a defeated Siege's reward. Split out for the same reason flashback
 * is: a cast out of exile must carry `fromZone: 'exile'` or the server looks for
 * the card in the hand, and a map that mixed the zones would lose the zone the
 * action has to name.
 *
 * Nothing here decides LEGALITY — these are the server's own offers, filtered by
 * the zone they came out of.
 */
export function exileCastChoices(
  actions: readonly GameAction[],
): ReadonlyMap<InstanceId, CastChoice> {
  return castChoicesFrom(actions, 'exile');
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
