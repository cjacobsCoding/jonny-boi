/**
 * Combat system. Reads keyword flags as data and applies pure-combat rules:
 *   - flying: an attacker with flying can only be blocked by reach/flying.
 *   - vigilance: attacking doesn't tap.
 *   - haste: can attack the turn it enters (handled by clearing sickness, but
 *     legality also checks it).
 *   - first strike / double strike: a first-strike damage step precedes the
 *     normal step; double strike deals in both.
 *   - deathtouch: any damage > 0 from a deathtouch source is lethal.
 *   - trample: excess damage beyond a blocker's lethal threshold tramples to the
 *     defending player.
 *   - lifelink: damage dealt also gains its controller that much life.
 *
 * Combat damage is assigned and then dealt; SBAs (run by the engine afterward)
 * destroy lethally-damaged creatures.
 */

import type { CardInstance, GameState, InstanceId, PlayerId } from '../state.js';
import type { GameEvent } from '../events.js';
import { effectivePower, remainingToughness } from './stats.js';
import { findOnBattlefield } from './zones.js';

function kw(inst: CardInstance) {
  return inst.def.keywords ?? {};
}

/** Whether `blocker` may legally block `attacker` given evasion keywords. */
export function canBlock(attacker: CardInstance, blocker: CardInstance): boolean {
  if (blocker.tapped) return false;
  const ak = kw(attacker);
  const bk = kw(blocker);
  if (ak.flying && !(bk.flying || bk.reach)) return false;
  return true;
}

/** Does this creature deal damage in the first-strike step? */
function dealsFirstStrike(inst: CardInstance): boolean {
  const k = kw(inst);
  return Boolean(k.firstStrike || k.doubleStrike);
}

/** Does this creature deal damage in the normal step? */
function dealsNormal(inst: CardInstance): boolean {
  const k = kw(inst);
  // First-strikers (without double strike) deal only in the first step.
  return !k.firstStrike || Boolean(k.doubleStrike);
}

/** Is there any first-striker among the combatants this combat? */
export function hasAnyFirstStrike(state: GameState, combat: GameState['combat']): boolean {
  if (!combat) return false;
  for (const id of combat.attackers) {
    const a = findOnBattlefield(state, id);
    if (a && dealsFirstStrike(a)) return true;
  }
  for (const blockerIdStr of Object.keys(combat.blocks)) {
    const b = findOnBattlefield(state, Number(blockerIdStr));
    if (b && dealsFirstStrike(b)) return true;
  }
  return false;
}

/** Lethal-damage threshold for a creature (deathtouch makes any damage lethal). */
function lethalNeeded(target: CardInstance, source: CardInstance): number {
  if (kw(source).deathtouch) return 1;
  return Math.max(remainingToughness(target), 0);
}

function applyDamage(
  state: GameState,
  source: CardInstance,
  target: CardInstance | PlayerId,
  amount: number,
  emit: (e: GameEvent) => void,
): void {
  if (amount <= 0) return;
  if (typeof target === 'string') {
    const player = state.players[target];
    player.life -= amount;
    emit({ type: 'damageDealt', source: source.instanceId, target, amount, combat: true });
    emit({ type: 'lifeChanged', player: target, delta: -amount, to: player.life });
  } else {
    target.damageMarked += amount;
    if (kw(source).deathtouch) target.markedByDeathtouch = true;
    emit({ type: 'damageDealt', source: source.instanceId, target: target.instanceId, amount, combat: true });
  }
  if (kw(source).lifelink) {
    const controller = state.players[source.controller];
    controller.life += amount;
    emit({ type: 'gainLife', player: source.controller, amount });
    emit({ type: 'lifeChanged', player: source.controller, delta: amount, to: controller.life });
  }
}

/**
 * Run one combat-damage step (first-strike or normal), determined by `firstStep`.
 * Each unblocked attacker hits the defending player; blocked attackers split
 * damage to their blocker(s), trampling overflow when applicable; blockers deal
 * back to their attacker. Mutates the draft; emits damage/life events.
 */
function runDamageStep(
  state: GameState,
  combat: NonNullable<GameState['combat']>,
  defendingPlayer: PlayerId,
  firstStep: boolean,
  emit: (e: GameEvent) => void,
): void {
  const participates = firstStep ? dealsFirstStrike : dealsNormal;

  // "Was this attacker blocked this combat?" is determined from the DECLARED
  // blocks, not from whether a blocker is currently alive. Once a creature is
  // blocked it stays blocked for the whole combat (CR 509.1b/510.1c): even if
  // its blocker dies (e.g. to a first-strike step before the normal step), a
  // non-trample attacker assigns no damage in later steps, and a trample
  // attacker tramples its full power through (the dead blocker absorbs 0 lethal).
  const blockedAttackers = new Set<InstanceId>(Object.values(combat.blocks));

  // Group *living* blockers by the attacker they block, for lethal assignment.
  const blockersByAttacker = new Map<InstanceId, CardInstance[]>();
  for (const [blockerIdStr, attackerId] of Object.entries(combat.blocks)) {
    const blocker = findOnBattlefield(state, Number(blockerIdStr));
    if (!blocker) continue;
    const list = blockersByAttacker.get(attackerId) ?? [];
    list.push(blocker);
    blockersByAttacker.set(attackerId, list);
  }

  // Attackers deal damage.
  for (const attackerId of combat.attackers) {
    const attacker = findOnBattlefield(state, attackerId);
    if (!attacker || !participates(attacker)) continue;
    const power = effectivePower(attacker);
    if (power <= 0) continue;
    const blockers = blockersByAttacker.get(attackerId);
    const wasBlocked = blockedAttackers.has(attackerId);
    if (!blockers || blockers.length === 0) {
      if (wasBlocked) {
        // Blocked, but no living blocker remains (blocker died earlier this
        // combat). A blocked creature stays blocked: without trample it deals
        // no damage; with trample it tramples its full power through (all
        // "lethal" was absorbed by the now-dead blocker = 0 remaining to assign).
        if (kw(attacker).trample) {
          applyDamage(state, attacker, defendingPlayer, power, emit);
        }
        continue;
      }
      // Genuinely unblocked → straight to the defending player.
      applyDamage(state, attacker, defendingPlayer, power, emit);
      continue;
    }
    // Blocked → assign lethal to each blocker in order, trample overflow.
    let remaining = power;
    for (const blocker of blockers) {
      if (remaining <= 0) break;
      const need = lethalNeeded(blocker, attacker);
      const assign = Math.min(remaining, need);
      applyDamage(state, attacker, blocker, assign, emit);
      remaining -= assign;
    }
    if (remaining > 0 && kw(attacker).trample) {
      applyDamage(state, attacker, defendingPlayer, remaining, emit);
    }
  }

  // Blockers deal damage back to the attacker they block.
  for (const [blockerIdStr, attackerId] of Object.entries(combat.blocks)) {
    const blocker = findOnBattlefield(state, Number(blockerIdStr));
    const attacker = findOnBattlefield(state, attackerId);
    if (!blocker || !attacker || !participates(blocker)) continue;
    const power = effectivePower(blocker);
    if (power <= 0) continue;
    applyDamage(state, blocker, attacker, power, emit);
  }
}

/**
 * Deal all combat damage. If any first-striker is present, a first-strike step
 * runs first; SBAs between steps are run by the engine. Returns whether a
 * first-strike step was performed (the engine then runs SBAs and the normal step).
 */
export function assignAndDealCombatDamage(
  state: GameState,
  emit: (e: GameEvent) => void,
  step: 'firstStrike' | 'normal',
): void {
  const combat = state.combat;
  if (!combat) return;
  const defendingPlayer = defendingPlayerOf(state);
  runDamageStep(state, combat, defendingPlayer, step === 'firstStrike', emit);
}

/** The non-active player is the defender in this 2-player MVP. */
export function defendingPlayerOf(state: GameState): PlayerId {
  return state.activePlayer === 'A' ? 'B' : 'A';
}

/** Tap attackers that lack vigilance when they're declared. */
export function tapAttackers(state: GameState, attackerIds: readonly InstanceId[], emit: (e: GameEvent) => void): void {
  for (const id of attackerIds) {
    const a = findOnBattlefield(state, id);
    if (!a) continue;
    if (!kw(a).vigilance) {
      a.tapped = true;
      emit({ type: 'tapped', instanceId: a.instanceId });
    }
  }
}
