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
 * Keywords and P/T are read through the continuous-effects layer (internal/
 * continuous.ts): a `ContinuousIndex` is built once per combat pass and threaded so
 * an "until end of turn" pump, a granted keyword (e.g. temporary trample), and any
 * anthem-style STATIC on the battlefield all affect this combat through one path.
 * Combat damage is assigned and then dealt; SBAs (run by the engine afterward)
 * destroy lethally-damaged creatures.
 *
 * The index is built at the START of a damage step and used for that whole step,
 * which is exactly right: a creature that dies during the step — an anthem included
 * — is still on the battlefield while damage is being assigned. Its departure is
 * observed by the SBA pass that follows, which rebuilds the index from scratch, so a
 * creature the dead anthem was propping up dies in that same pass.
 */

import type { CardInstance, GameState, InstanceId, PlayerId } from '../state.js';
import type { GameEvent } from '../events.js';
import type { KeywordFlags } from '../card.js';
import {
  defenseOf,
  effectivePower,
  effectiveKeywords,
  loyaltyOf,
  remainingToughness,
  removeDefense,
  removeLoyalty,
} from './stats.js';
import { isBattle, isPlaneswalker } from '../card.js';
import { protectionBlocksSource } from '../protection.js';
import { findOnBattlefield } from './zones.js';
import type { ContinuousIndex } from './continuous.js';
import { indexContinuous, NO_MOD } from './continuous.js';

/** Effective keywords for an instance under the given continuous index. */
function kw(inst: CardInstance, index: ContinuousIndex): KeywordFlags {
  return effectiveKeywords(inst, index.get(inst.instanceId) ?? NO_MOD);
}

/** Effective power for an instance under the given continuous index. */
function power(inst: CardInstance, index: ContinuousIndex): number {
  return effectivePower(inst, index.get(inst.instanceId) ?? NO_MOD);
}

/**
 * Whether `blocker` may legally block `attacker` given evasion keywords.
 *
 * The index is REQUIRED, not optional: evasion can be granted by an until-EOT effect
 * *or* by an anthem-style static, and a caller that omitted the index would silently
 * judge legality against printed keywords only — letting a groundling block a
 * creature that a static has given flying. Build it once with `indexContinuous` and
 * thread it through (the engine already does, for exactly this reason).
 */
export function canBlock(attacker: CardInstance, blocker: CardInstance, index: ContinuousIndex): boolean {
  if (blocker.tapped) return false;
  const idx = index;
  const ak = kw(attacker, idx);
  const bk = kw(blocker, idx);
  // "~ can't block" disqualifies the BLOCKER whatever it would be blocking, so it
  // is asked first and independently of anything about the attacker.
  if (bk.cantBlock) return false;
  // "Can't be blocked" is absolute — checked before evasion, which it subsumes.
  if (ak.unblockable) return false;
  if (ak.flying && !(bk.flying || bk.reach)) return false;
  // Protection's fourth half: an attacker with protection from [quality] can't
  // be blocked by creatures having that quality (protection from creatures
  // therefore makes it unblockable, since every blocker is a creature).
  if (ak.protectionFrom !== undefined && protectionBlocksSource(ak.protectionFrom, blocker.def)) {
    return false;
  }
  return true;
}

/**
 * The minimum number of creatures that must block this attacker TOGETHER for the
 * block to be legal, or 0 when it prints no such requirement.
 *
 * Menace and `minBlockers` are the same printed rule at two values — "can't be
 * blocked except by two or more creatures" and Pathrazer of Ulamog's "except by
 * three or more" — so they are folded here by taking the LARGER, which is the
 * only reading under which both restrictions hold at once.
 */
function requiredBlockerCount(attacker: CardInstance, index: ContinuousIndex): number {
  const k = kw(attacker, index);
  const menaceMinimum = k.menace ? MENACE_MINIMUM_BLOCKERS : 0;
  return Math.max(menaceMinimum, k.minBlockers ?? 0);
}

/** Menace is the N = 2 printing of the "except by N or more creatures" rule. */
const MENACE_MINIMUM_BLOCKERS = 2;

/**
 * Why this whole block DECLARATION is illegal, or `undefined` if it stands.
 *
 * Menace lives here rather than in {@link canBlock} because it constrains the
 * assignment as a whole: each blocker individually *can* block a menacing
 * creature, and what the rule forbids is exactly one of them doing it. A
 * per-pair check cannot see that, so it would let a single blocker through.
 * Every "can't be blocked except by N or more creatures" printing has that same
 * shape, which is why they share this check rather than getting a flag each.
 *
 * ⚠️ This function enforces block RESTRICTIONS only. Block REQUIREMENTS ("~ must
 * be blocked if able", "all creatures able to block ~ do so") are the other half
 * of CR 509.1c/d and are NOT implemented — satisfying the maximum number of
 * requirements without violating any restriction is a solver, not a check. Cards
 * printing a requirement are reported by the compiler rather than played with the
 * requirement silently ignored.
 */
export function illegalBlockDeclaration(
  attackers: readonly CardInstance[],
  blocks: ReadonlyArray<{ readonly blocker: InstanceId; readonly attacker: InstanceId }>,
  index: ContinuousIndex,
): string | undefined {
  for (const attacker of attackers) {
    const required = requiredBlockerCount(attacker, index);
    if (required === 0) continue;
    const assigned = blocks.filter((b) => b.attacker === attacker.instanceId).length;
    // Zero is fine — the rule forbids being blocked by TOO FEW, not being unblocked.
    if (assigned > 0 && assigned < required) {
      return required === MENACE_MINIMUM_BLOCKERS
        ? `${attacker.def.name} has menace and can't be blocked by exactly one creature`
        : `${attacker.def.name} can't be blocked except by ${required} or more creatures`;
    }
  }
  return undefined;
}

/** Does this creature deal damage in the first-strike step? */
function dealsFirstStrike(inst: CardInstance, index: ContinuousIndex): boolean {
  const k = kw(inst, index);
  return Boolean(k.firstStrike || k.doubleStrike);
}

/** Does this creature deal damage in the normal step? */
function dealsNormal(inst: CardInstance, index: ContinuousIndex): boolean {
  const k = kw(inst, index);
  // First-strikers (without double strike) deal only in the first step.
  return !k.firstStrike || Boolean(k.doubleStrike);
}

/** Is there any first-striker among the combatants this combat? */
export function hasAnyFirstStrike(state: GameState, combat: GameState['combat']): boolean {
  if (!combat) return false;
  const index = indexContinuous(state);
  for (const id of combat.attackers) {
    const a = findOnBattlefield(state, id);
    if (a && dealsFirstStrike(a, index)) return true;
  }
  for (const blockerIdStr of Object.keys(combat.blocks)) {
    const b = findOnBattlefield(state, Number(blockerIdStr));
    if (b && dealsFirstStrike(b, index)) return true;
  }
  return false;
}

/** Lethal-damage threshold for a creature (deathtouch makes any damage lethal). */
function lethalNeeded(target: CardInstance, source: CardInstance, index: ContinuousIndex): number {
  if (kw(source, index).deathtouch) return 1;
  return Math.max(remainingToughness(target, index.get(target.instanceId) ?? NO_MOD), 0);
}

function applyDamage(
  state: GameState,
  source: CardInstance,
  target: CardInstance | PlayerId,
  amount: number,
  index: ContinuousIndex,
  emit: (e: GameEvent) => void,
): void {
  if (amount <= 0) return;
  if (typeof target === 'string') {
    const player = state.players[target];
    player.life -= amount;
    emit({ type: 'damageDealt', source: source.instanceId, target, amount, combat: true });
    emit({ type: 'lifeChanged', player: target, delta: -amount, to: player.life });
  } else if (isPlaneswalker(target.def)) {
    // Damage to a planeswalker removes that many loyalty counters immediately
    // (CR 120.3c) — loyalty is its life total, not marked damage cleared at
    // cleanup. The 0-loyalty death is the SBA pass that follows the damage step.
    const removed = removeLoyalty(target, amount);
    emit({ type: 'damageDealt', source: source.instanceId, target: target.instanceId, amount, combat: true });
    if (removed > 0) {
      emit({ type: 'loyaltyChanged', instanceId: target.instanceId, delta: -removed, to: loyaltyOf(target) });
    }
  } else if (isBattle(target.def)) {
    // Damage to a battle removes that many DEFENSE counters immediately
    // (CR 120.3d) — the exact shape of walker loyalty, and the 0-defense
    // defeat is likewise the SBA pass that follows the damage step.
    const removed = removeDefense(target, amount);
    emit({ type: 'damageDealt', source: source.instanceId, target: target.instanceId, amount, combat: true });
    if (removed > 0) {
      emit({ type: 'defenseChanged', instanceId: target.instanceId, delta: -removed, to: defenseOf(target) });
    }
  } else {
    // Protection's second half: damage from a source with a protected quality
    // is PREVENTED (CR 702.16e). Lifelink below is skipped with it — no damage
    // was dealt, so there is nothing to link.
    const protection = kw(target, index).protectionFrom;
    if (protection !== undefined && protectionBlocksSource(protection, source.def)) {
      emit({
        type: 'damagePrevented',
        source: source.instanceId,
        target: target.instanceId,
        amount,
        combat: true,
      });
      return;
    }
    target.damageMarked += amount;
    if (kw(source, index).deathtouch) target.markedByDeathtouch = true;
    emit({ type: 'damageDealt', source: source.instanceId, target: target.instanceId, amount, combat: true });
  }
  if (kw(source, index).lifelink) {
    const controller = state.players[source.controller];
    controller.life += amount;
    emit({ type: 'gainLife', player: source.controller, amount });
    emit({ type: 'lifeChanged', player: source.controller, delta: amount, to: controller.life });
  }
}

/**
 * Deal an attacker's player-facing damage to WHAT IT WAS DECLARED ATTACKING —
 * the defending player, or an attacked permanent (a planeswalker).
 *
 * Three rules live here, and only here, so every damage site agrees:
 *   - an attacked permanent that has LEFT the battlefield absorbs nothing and
 *     redirects nothing: the attacker was attacking that object, the object is
 *     gone, and it deals no combat damage (CR 506.4c / 510.1a — the old
 *     planeswalker damage-redirection rule was removed in 2017);
 *   - a TRAMPLING attacker attacking a planeswalker assigns at most the
 *     walker's remaining loyalty to it and the excess to the defending player
 *     (CR 702.19i);
 *   - everything else goes to the attacked object whole.
 */
function dealToAttackedObject(
  state: GameState,
  attacker: CardInstance,
  attacked: InstanceId | PlayerId,
  amount: number,
  index: ContinuousIndex,
  defendingPlayer: PlayerId,
  emit: (e: GameEvent) => void,
): void {
  if (amount <= 0) return;
  if (typeof attacked === 'string') {
    applyDamage(state, attacker, attacked, amount, index, emit);
    return;
  }
  const object = findOnBattlefield(state, attacked);
  if (!object) return; // the attacked permanent is gone — no damage, no redirect
  if (kw(attacker, index).trample && (isPlaneswalker(object.def) || isBattle(object.def))) {
    // CR 702.19i/702.19j: trampling past an attacked walker (its loyalty is
    // lethal) or an attacked battle (its remaining defense is lethal) carries
    // the excess to the defending player — who, for a battle, IS its protector.
    const lethal = isBattle(object.def) ? defenseOf(object) : loyaltyOf(object);
    const toObject = Math.min(amount, lethal);
    applyDamage(state, attacker, object, toObject, index, emit);
    applyDamage(state, attacker, defendingPlayer, amount - toObject, index, emit);
    return;
  }
  applyDamage(state, attacker, object, amount, index, emit);
}

/** What this attacker was declared attacking (the defending player by default). */
export function attackedObjectOf(
  combat: NonNullable<GameState['combat']>,
  attackerId: InstanceId,
  defendingPlayer: PlayerId,
): InstanceId | PlayerId {
  return combat.attackTargets?.[attackerId] ?? defendingPlayer;
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
  index: ContinuousIndex,
  emit: (e: GameEvent) => void,
): void {
  const participates = (inst: CardInstance): boolean =>
    firstStep ? dealsFirstStrike(inst, index) : dealsNormal(inst, index);

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
    const atkPower = power(attacker, index);
    if (atkPower <= 0) continue;
    const blockers = blockersByAttacker.get(attackerId);
    const wasBlocked = blockedAttackers.has(attackerId);
    // The player-facing half of this attacker's damage goes to what it was
    // DECLARED attacking — the defending player, or that player's planeswalker.
    const attacked = attackedObjectOf(combat, attackerId, defendingPlayer);
    if (!blockers || blockers.length === 0) {
      if (wasBlocked) {
        // Blocked, but no living blocker remains (blocker died earlier this
        // combat). A blocked creature stays blocked: without trample it deals
        // no damage; with trample it tramples its full power through (all
        // "lethal" was absorbed by the now-dead blocker = 0 remaining to assign).
        if (kw(attacker, index).trample) {
          dealToAttackedObject(state, attacker, attacked, atkPower, index, defendingPlayer, emit);
        }
        continue;
      }
      // Genuinely unblocked → straight to the attacked player/permanent.
      dealToAttackedObject(state, attacker, attacked, atkPower, index, defendingPlayer, emit);
      continue;
    }
    // Blocked → assign lethal to each blocker in order, trample overflow.
    let remaining = atkPower;
    for (const blocker of blockers) {
      if (remaining <= 0) break;
      const need = lethalNeeded(blocker, attacker, index);
      const assign = Math.min(remaining, need);
      applyDamage(state, attacker, blocker, assign, index, emit);
      remaining -= assign;
    }
    if (remaining > 0 && kw(attacker, index).trample) {
      dealToAttackedObject(state, attacker, attacked, remaining, index, defendingPlayer, emit);
    }
  }

  // Blockers deal damage back to the attacker they block.
  for (const [blockerIdStr, attackerId] of Object.entries(combat.blocks)) {
    const blocker = findOnBattlefield(state, Number(blockerIdStr));
    const attacker = findOnBattlefield(state, attackerId);
    if (!blocker || !attacker || !participates(blocker)) continue;
    const blkPower = power(blocker, index);
    if (blkPower <= 0) continue;
    applyDamage(state, blocker, attacker, blkPower, index, emit);
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
  const index = indexContinuous(state);
  const defendingPlayer = defendingPlayerOf(state);
  runDamageStep(state, combat, defendingPlayer, step === 'firstStrike', index, emit);
}

/** The non-active player is the defender in this 2-player MVP. */
export function defendingPlayerOf(state: GameState): PlayerId {
  return state.activePlayer === 'A' ? 'B' : 'A';
}

/** Tap attackers that lack vigilance when they're declared. */
export function tapAttackers(state: GameState, attackerIds: readonly InstanceId[], emit: (e: GameEvent) => void): void {
  const index = indexContinuous(state);
  for (const id of attackerIds) {
    const a = findOnBattlefield(state, id);
    if (!a) continue;
    if (!kw(a, index).vigilance) {
      a.tapped = true;
      emit({ type: 'tapped', instanceId: a.instanceId });
    }
  }
}
