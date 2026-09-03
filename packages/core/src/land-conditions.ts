/**
 * LAND CONDITIONS — "as long as defending player controls an Island".
 *
 * ONE reader for the closed `LandCondition` table (card.ts), shared by the two
 * rules that print the phrase:
 *   - landwalk (CR 702.18b): "can't be blocked as long as defending player
 *     controls a [land of this kind]";
 *   - the attack restriction (CR 508.1c): "can't attack unless defending
 *     player controls an Island".
 *
 * One reader so a row added to the table is understood by both in the same
 * edit (rule 12), and so "an Island" cannot come to mean two different things
 * — a Tropical Island is an Island for both, and a Wastes is nonbasic for both.
 *
 * PERF: this runs inside `canBlock`, which the block solver calls per
 * (attacker, blocker) pair. It is a single indexed walk of the battlefield with
 * no allocation, and it is only reached when the attacker actually prints a
 * land condition — the common case pays one `undefined` check.
 */

import type { LandCondition } from './card.js';
import { hasSubtype, isLand } from './card.js';
import type { CardInstance, PlayerId } from './state.js';

/** Whether one land satisfies one condition. */
function landMatches(land: CardInstance, condition: LandCondition): boolean {
  switch (condition.kind) {
    case 'subtype':
      // `hasSubtype` folds case, so a dual printing "Island" matches "island".
      return hasSubtype(land.def, condition.subtype);
    case 'legendary':
      return land.def.legendary === true;
    case 'nonbasic':
      return land.def.basic !== true;
    default: {
      // Closed table: a kind outside it is unreachable through the compiler.
      // Hand-built data with an unknown kind matches NOTHING, never everything —
      // a landwalk that fired on every board would be a strictly better card.
      const _exhaustive: never = condition;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * Does `player` control at least one land satisfying `condition`?
 *
 * The battlefield is passed in rather than a state, because both callers
 * (`canBlock`, `attackDeclarationProblem`) are pure functions over the
 * creatures and the board — and one of them is mirrored in the AI pilot, which
 * holds a read-only view rather than a `GameState`.
 */
export function controlsLandMatching(
  battlefield: readonly CardInstance[],
  player: PlayerId,
  condition: LandCondition,
): boolean {
  for (let i = 0; i < battlefield.length; i++) {
    const permanent = battlefield[i] as CardInstance;
    if (permanent.controller !== player || !isLand(permanent.def)) continue;
    if (landMatches(permanent, condition)) return true;
  }
  return false;
}

/**
 * Does `player` control a land satisfying ANY of `conditions`?
 *
 * The landwalk reading: a creature printing "islandwalk, swampwalk" is
 * unblockable when the defender controls EITHER.
 */
export function controlsLandMatchingAny(
  battlefield: readonly CardInstance[],
  player: PlayerId,
  conditions: readonly LandCondition[],
): boolean {
  for (let i = 0; i < conditions.length; i++) {
    if (controlsLandMatching(battlefield, player, conditions[i] as LandCondition)) return true;
  }
  return false;
}

/**
 * Does `player` control a land satisfying EVERY one of `conditions`?
 *
 * The attack-restriction reading: each printed "can't attack unless …" line is
 * its own restriction, and all of them must be satisfied.
 */
export function controlsLandMatchingAll(
  battlefield: readonly CardInstance[],
  player: PlayerId,
  conditions: readonly LandCondition[],
): boolean {
  for (let i = 0; i < conditions.length; i++) {
    if (!controlsLandMatching(battlefield, player, conditions[i] as LandCondition)) return false;
  }
  return true;
}

/** The printed name of a condition, for rejection messages and the inspector. */
export function describeLandCondition(condition: LandCondition): string {
  switch (condition.kind) {
    case 'subtype':
      return condition.subtype === 'island' ? 'an Island' : `a ${capitalize(condition.subtype)}`;
    case 'legendary':
      return 'a legendary land';
    case 'nonbasic':
      return 'a nonbasic land';
    default:
      return 'a land';
  }
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
}

/**
 * Structural equality, for the keyword-merge paths: two grants of "islandwalk"
 * are one islandwalk, not two.
 */
export function sameLandCondition(a: LandCondition, b: LandCondition): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'subtype' || a.subtype === (b as { subtype: string }).subtype;
}

/**
 * Union two land-condition lists without duplicates — the merge rule for
 * `landwalk` grants, in the shape of `unionProtection`. Returns the first list
 * unchanged when the second adds nothing, so the no-grant path allocates
 * nothing.
 */
export function unionLandConditions(
  base: readonly LandCondition[] | undefined,
  granted: readonly LandCondition[] | undefined,
): readonly LandCondition[] | undefined {
  if (granted === undefined || granted.length === 0) return base;
  if (base === undefined || base.length === 0) return granted;
  const extra = granted.filter((condition) => !base.some((known) => sameLandCondition(known, condition)));
  return extra.length === 0 ? base : [...base, ...extra];
}
