/**
 * ATTACK RESTRICTIONS AND REQUIREMENTS (CR 508.1c/d) — the attacker-side mirror
 * of `internal/block-solver.ts` (DESIGN §3.107).
 *
 * ## Two halves, one reader
 * A RESTRICTION says what may NOT attack ("~ can't attack unless defending
 * player controls an Island", defender, summoning sickness); a REQUIREMENT says
 * what MUST ("~ attacks each combat if able"). CR 508.1d resolves the two
 * together: the declaration must satisfy the maximum number of requirements
 * WITHOUT violating any restriction. {@link attackDeclarationProblem} is the
 * one reader of the restrictions, used by the offer path
 * (`generateLegalActions`), the apply path (`applyDeclareAttackers`) and the
 * requirement half below — so "able to attack" cannot mean three things.
 *
 * ## Why the requirement half needs no search
 * Every requirement this engine can express is PER CREATURE and UNCONDITIONAL
 * ("attacks each combat if able"), and no restriction here depends on what
 * else is attacking. So the maximum is simply "every required creature that
 * is able", and a declaration satisfies CR 508.1d iff it contains all of them.
 * The block solver needs a dynamic program because its requirements interact
 * through shared blockers; nothing on the attacking side does yet. The day a
 * printed line makes two attack requirements compete ("attacks each combat if
 * able" plus "can't attack alone"), this becomes a solver — and this comment is
 * where the next reader learns that.
 *
 * ## The pass path
 * This engine lets the active player DECLINE to attack by passing priority in
 * the declare-attackers step. With a required creature able to attack that is
 * not a legal declaration, so `advanceStep` performs the forced minimum itself
 * — declaring exactly the required creatures at the defending player — before
 * the step can move on. That is the only legal outcome, so it is done rather
 * than refused: refusing a pass would deadlock every pilot that answers
 * "pass" to a step it does not understand.
 *
 * INERT when nothing requires anything: one keyword read per creature of the
 * active player, no allocation, which is what almost every combat pays.
 */

import type { KeywordFlags } from './card.js';
import { isCreature } from './card.js';
import type { ContinuousIndex } from './internal/continuous.js';
import { NO_MOD } from './internal/continuous.js';
import { effectiveKeywords } from './internal/stats.js';
import { controlsLandMatchingAll, describeLandCondition } from './land-conditions.js';
import type { CardInstance, GameState, InstanceId, PlayerId } from './state.js';

/**
 * Why this creature may NOT be declared as an attacker right now, or
 * `undefined` when it may.
 *
 * `keywords` is the creature's EFFECTIVE set (printed OR granted), read once by
 * the caller — a haste or defender granted until end of turn changes the
 * answer, and every caller has already built the index for other reasons.
 * `battlefield` and `defender` serve the one restriction that reads the board
 * ("unless defending player controls an Island").
 */
export function attackDeclarationProblem(
  creature: CardInstance,
  keywords: KeywordFlags,
  defender: PlayerId,
  battlefield: readonly CardInstance[],
): string | undefined {
  if (creature.tapped) return `${creature.def.name} is tapped and cannot attack`;
  if (creature.summoningSick && keywords.haste !== true) return `${creature.def.name} has summoning sickness`;
  if (keywords.defender === true) return `${creature.def.name} has defender and cannot attack`;
  const unless = keywords.cantAttackUnlessDefenderControls;
  if (unless !== undefined && !controlsLandMatchingAll(battlefield, defender, unless)) {
    return (
      `${creature.def.name} can't attack unless defending player controls ` +
      unless.map(describeLandCondition).join(' and ')
    );
  }
  return undefined;
}

/**
 * The creatures the active player is REQUIRED to attack with this combat
 * (CR 508.1d): every creature they control that prints "attacks each combat if
 * able" and is actually able. Returns the shared empty list when there are
 * none, so the common case allocates nothing.
 */
export function requiredAttackerIds(
  state: GameState,
  index: ContinuousIndex,
  defender: PlayerId,
): readonly InstanceId[] {
  let required: InstanceId[] | undefined;
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const creature = battlefield[i] as CardInstance;
    if (creature.controller !== state.activePlayer || !isCreature(creature.def)) continue;
    const keywords = effectiveKeywords(creature, index.get(creature.instanceId) ?? NO_MOD);
    if (keywords.mustAttack !== true) continue;
    if (attackDeclarationProblem(creature, keywords, defender, battlefield) !== undefined) continue;
    (required ??= []).push(creature.instanceId);
  }
  return required ?? NO_REQUIRED_ATTACKERS;
}

/** Shared, frozen "nothing is required" — returned rather than allocated. */
const NO_REQUIRED_ATTACKERS: readonly InstanceId[] = Object.freeze([]);

/**
 * Why a proposed declaration fails CR 508.1d, or `undefined` if it stands: the
 * name of the first required creature it left home.
 *
 * Restrictions must already have been checked on the DECLARED creatures; this
 * asks only "was a required creature omitted?", which is the whole of the
 * requirement half for per-creature, unconditional requirements (see the
 * module comment).
 */
export function attackRequirementProblem(
  state: GameState,
  index: ContinuousIndex,
  defender: PlayerId,
  declared: readonly InstanceId[],
): string | undefined {
  const required = requiredAttackerIds(state, index, defender);
  for (let i = 0; i < required.length; i++) {
    const id = required[i] as InstanceId;
    if (declared.includes(id)) continue;
    const creature = state.battlefield.find((permanent) => permanent.instanceId === id);
    return `${creature?.def.name ?? `creature ${id}`} attacks each combat if able and must be declared`;
  }
  return undefined;
}
