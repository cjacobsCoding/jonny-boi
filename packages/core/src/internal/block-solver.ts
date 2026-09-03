/**
 * BLOCK REQUIREMENTS (CR 509.1c/d) — the half of declare-blockers that a per-pair
 * check cannot answer.
 *
 * ## Why this is a solver and not a check
 * A block RESTRICTION says what the defender may not do ("can't be blocked by
 * creatures with flying"), and two creatures are all it needs to look at.
 * `canBlock` answers it.
 *
 * A block REQUIREMENT says what the defender MUST do ("~ must be blocked if
 * able", "all creatures able to block ~ do so"), and CR 509.1d resolves the two
 * TOGETHER: the declaration must satisfy the **maximum possible number of
 * requirements without violating any restriction**. "Maximum possible" is a
 * statement about every legal declaration, not about this one — so answering it
 * means comparing the declaration in hand against the best one available. That is
 * a search, and it is why the previous blocking work stopped here rather than
 * shipping a requirement that only sometimes forces a block.
 *
 * ## It is INERT when nothing requires anything
 * {@link blockRequirementProblem} returns `undefined` after a single pass over the
 * attackers when none of them carries a requirement keyword — the same empty-check
 * discipline `isLegalTarget` and `manaExtrasOf` use. No allocation, no board walk,
 * no map. The overwhelming majority of combats in a sim never reach the search at
 * all, which is what keeps a rules-complete implementation off the hot path.
 *
 * ## The search, and why it is small
 * Only two things can change the score:
 *   - which of the DEFENDER'S creatures are assigned to a requirement-carrying
 *     attacker (every other creature contributes nothing to any requirement, so
 *     it is never enumerated);
 *   - how many are assigned to each, because a restriction may demand a minimum
 *     (menace: a lone blocker is not a block at all, so it satisfies nothing).
 *
 * That makes the state a vector of "creatures committed to attacker A so far,
 * capped at the minimum A needs" — a number in `[0, required(A)]`, where
 * `required(A)` is 1 for almost every creature and at most a small printed count.
 * A rolling dynamic program over the involved creatures then computes the exact
 * maximum in `involvedCreatures × stateSpace` steps, with `stateSpace` the product
 * of `(required(A) + 1)`.
 *
 * The scoring trick that keeps the state that small: a creature assigned to an
 * attacker that has not yet met its minimum scores NOTHING YET, and the whole
 * group scores together at the moment the minimum is reached. After that each
 * further creature scores immediately. That is exactly what the printed rule says
 * ("able to block" already accounts for restrictions) and it means the state never
 * has to remember counts beyond the minimum.
 *
 * ## The one bound, stated honestly
 * `stateSpace` is `2^n` for `n` attackers that each simply require a blocker. It
 * is capped at {@link MAX_REQUIREMENT_STATE_SPACE}; past the cap the solver
 * maximises over the FIRST attackers that fit and leaves the rest requiring
 * nothing. Reaching it takes twenty attackers carrying a block requirement in one
 * combat, which no card in this pool can produce (the compiler is the gate on what
 * may print one, and nothing grants a requirement to a group). The bound is
 * documented rather than hidden because a limit nobody wrote down is a limit
 * nobody can check.
 */

import type { CardInstance, InstanceId } from '../state.js';
import type { ContinuousIndex } from './continuous.js';
import { canBlock, requiredBlockerCount } from './combat.js';
import { effectiveKeywords } from './stats.js';
import { NO_MOD } from './continuous.js';

/** One assignment in a proposed (or constructed) block declaration. */
export interface BlockAssignment {
  readonly blocker: InstanceId;
  readonly attacker: InstanceId;
}

/**
 * The largest state space the requirement search will build. See the module
 * comment: twenty simultaneous requirement-carrying attackers is past what this
 * card pool can print, and the cap is what stops a hostile or hand-built board
 * from turning a rules check into an unbounded search.
 */
const MAX_REQUIREMENT_STATE_SPACE = 1 << 20;

/**
 * The board handed to `canBlock` when a caller passes none — "the defender
 * controls no lands", which only LANDWALK reads (DESIGN §3.107). Every real
 * caller (the engine, the pilot) passes the live battlefield.
 */
const NO_PERMANENTS: readonly CardInstance[] = Object.freeze([]);

/** An attacker carrying a block requirement, with everything the search needs. */
interface RequirementAttacker {
  readonly attacker: CardInstance;
  /** How many blockers it takes before ANY of them is legally blocking it. */
  readonly minimum: number;
  /** True for "all creatures able to block ~ do so"; false for "must be blocked". */
  readonly everyAbleBlocker: boolean;
  /** The defender's creatures that could legally be assigned to it. */
  readonly candidates: readonly CardInstance[];
  /** Radix multiplier for packing this attacker's count into the state number. */
  readonly stride: number;
}

/**
 * The attackers that carry a block requirement AND could actually be blocked,
 * or `undefined` when there are none.
 *
 * "Could actually be blocked" is CR 509.1c's "if able": an attacker nobody can
 * legally block generates no requirement at all, so it is dropped here rather than
 * making every declaration illegal.
 */
function collectRequirements(
  attackers: readonly CardInstance[],
  defenders: readonly CardInstance[],
  index: ContinuousIndex,
  // Threaded to `canBlock` for LANDWALK (DESIGN §3.107): "able to block" must
  // read the same board the pair check reads, or a lure with islandwalk facing
  // an Island would demand a block the pair check then refuses.
  battlefield: readonly CardInstance[],
): RequirementAttacker[] | undefined {
  // THE EMPTY CHECK. One pass, no allocation, and it is what almost every combat
  // in a simulated game pays in total.
  let any = false;
  for (let i = 0; i < attackers.length; i++) {
    const keywords = effectiveKeywords(attackers[i]!, index.get(attackers[i]!.instanceId) ?? NO_MOD);
    if (keywords.mustBeBlocked === true || keywords.blockedByAllAble === true) {
      any = true;
      break;
    }
  }
  if (!any) return undefined;

  const out: RequirementAttacker[] = [];
  let stateSpace = 1;
  for (const attacker of attackers) {
    const keywords = effectiveKeywords(attacker, index.get(attacker.instanceId) ?? NO_MOD);
    const everyAbleBlocker = keywords.blockedByAllAble === true;
    if (!everyAbleBlocker && keywords.mustBeBlocked !== true) continue;
    const candidates = defenders.filter((defender) => canBlock(attacker, defender, index, battlefield));
    // "If able": a minimum this defender cannot meet means nobody is able to block
    // it, so it requires nothing (a menacing lure facing one untapped creature).
    const minimum = Math.max(1, requiredBlockerCount(attacker, index));
    if (candidates.length < minimum) continue;
    const stride = stateSpace;
    stateSpace *= minimum + 1;
    // The documented bound. Attackers past it require nothing, which is the same
    // answer this engine gave before requirements existed at all — never a
    // declaration wrongly refused.
    if (stateSpace > MAX_REQUIREMENT_STATE_SPACE) break;
    out.push({ attacker, minimum, everyAbleBlocker, candidates, stride });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Score one candidate assignment of counts: how many requirements it satisfies.
 *
 * A group that has not met the attacker's minimum is not blocking at all, so it
 * scores zero — that is what makes a lone blocker on a menacing lure worth nothing
 * rather than worth one.
 */
function scoreCounts(requirements: readonly RequirementAttacker[], counts: readonly number[]): number {
  let score = 0;
  for (let i = 0; i < requirements.length; i++) {
    const requirement = requirements[i]!;
    const count = counts[i]!;
    if (count < requirement.minimum) continue;
    // "All creatures able to block" is one requirement PER creature, so every
    // assigned blocker counts; "must be blocked" is a single requirement met by
    // the group.
    score += requirement.everyAbleBlocker ? count : 1;
  }
  return score;
}

/** The per-creature options: which requirement attackers it may be committed to. */
function optionsFor(
  requirements: readonly RequirementAttacker[],
  creature: CardInstance,
): number[] {
  const options: number[] = [];
  for (let i = 0; i < requirements.length; i++) {
    if (requirements[i]!.candidates.includes(creature)) options.push(i);
  }
  return options;
}

/**
 * The maximum number of requirements ANY legal declaration could satisfy, and one
 * assignment that achieves it.
 *
 * The dynamic program is over the involved creatures — the defender's creatures
 * that could block at least one requirement-carrying attacker. Every other
 * creature is free, because nothing it does changes any requirement.
 */
function solve(requirements: readonly RequirementAttacker[]): {
  readonly best: number;
  readonly assignment: readonly BlockAssignment[];
} {
  // The involved creatures, de-duplicated in a stable order (the order they appear
  // in the first requirement that can use them), so the reconstructed assignment
  // is deterministic — two engines replaying the same game must build the same one.
  const involved: CardInstance[] = [];
  for (const requirement of requirements) {
    for (const candidate of requirement.candidates) {
      if (!involved.includes(candidate)) involved.push(candidate);
    }
  }

  // State = the counts committed to each requirement attacker so far, each capped
  // at that attacker's minimum, packed into one number by mixed radix.
  let stateSpace = 1;
  for (const requirement of requirements) stateSpace *= requirement.minimum + 1;

  // `reachable[s]` is the best score with which state `s` can be reached, or -1.
  let reachable = new Int32Array(stateSpace).fill(-1);
  reachable[0] = 0;
  // The choice taken to reach each state at each step, for reconstruction. One
  // row per creature; `-1` means "this creature was not committed to anything".
  const choices: Int8Array[] = [];
  const from: Int32Array[] = [];

  for (const creature of involved) {
    const options = optionsFor(requirements, creature);
    const next = new Int32Array(stateSpace).fill(-1);
    const choiceRow = new Int8Array(stateSpace).fill(-1);
    const fromRow = new Int32Array(stateSpace).fill(-1);
    for (let state = 0; state < stateSpace; state++) {
      const score = reachable[state]!;
      if (score < 0) continue;
      // Option 0: leave this creature free (block something else, or nothing).
      if (score > next[state]!) {
        next[state] = score;
        choiceRow[state] = -1;
        fromRow[state] = state;
      }
      for (const option of options) {
        const requirement = requirements[option]!;
        const current = Math.floor(state / requirement.stride) % (requirement.minimum + 1);
        // Past the minimum the count stops mattering to LEGALITY, so the state
        // saturates — but the SCORE keeps growing for an "all able blockers"
        // requirement, which is why the gain is computed before the cap.
        const gain =
          current + 1 < requirement.minimum ? 0
          : current + 1 === requirement.minimum
            ? requirement.everyAbleBlocker
              ? requirement.minimum // the whole group starts blocking at once
              : 1
            : requirement.everyAbleBlocker
              ? 1
              : 0;
        const nextState = current < requirement.minimum ? state + requirement.stride : state;
        const nextScore = score + gain;
        if (nextScore > next[nextState]!) {
          next[nextState] = nextScore;
          choiceRow[nextState] = option;
          fromRow[nextState] = state;
        }
      }
    }
    reachable = next;
    choices.push(choiceRow);
    from.push(fromRow);
  }

  let best = 0;
  let bestState = 0;
  for (let state = 0; state < stateSpace; state++) {
    if (reachable[state]! > best) {
      best = reachable[state]!;
      bestState = state;
    }
  }

  // Walk the choice rows backwards to recover ONE assignment achieving `best`.
  const assignment: BlockAssignment[] = [];
  let state = bestState;
  for (let i = involved.length - 1; i >= 0; i--) {
    const option = choices[i]![state]!;
    if (option >= 0) {
      assignment.push({
        blocker: involved[i]!.instanceId,
        attacker: requirements[option]!.attacker.instanceId,
      });
    }
    state = from[i]![state]!;
  }
  assignment.reverse();
  return { best, assignment };
}

/** How many requirements a PROPOSED declaration actually satisfies. */
function scoreDeclaration(
  requirements: readonly RequirementAttacker[],
  blocks: readonly BlockAssignment[],
): number {
  const counts = new Array<number>(requirements.length).fill(0);
  for (const block of blocks) {
    for (let i = 0; i < requirements.length; i++) {
      if (requirements[i]!.attacker.instanceId !== block.attacker) continue;
      // Only creatures the rule counts as ABLE to block it contribute — a blocker
      // the declaration put there illegally is caught by `canBlock` anyway, and
      // must not also earn credit here.
      if (!requirements[i]!.candidates.some((c) => c.instanceId === block.blocker)) continue;
      counts[i] = counts[i]! + 1;
    }
  }
  return scoreCounts(requirements, counts);
}

/**
 * Why this declaration fails CR 509.1d, or `undefined` if it stands.
 *
 * Restrictions must already have been checked: this asks only "could the defender
 * have satisfied more requirements?", and a declaration that violates a
 * restriction is illegal for a different reason and is rejected before reaching
 * here.
 */
export function blockRequirementProblem(
  attackers: readonly CardInstance[],
  defenders: readonly CardInstance[],
  blocks: readonly BlockAssignment[],
  index: ContinuousIndex,
  battlefield: readonly CardInstance[] = NO_PERMANENTS,
): string | undefined {
  const requirements = collectRequirements(attackers, defenders, index, battlefield);
  if (!requirements) return undefined;
  const { best } = solve(requirements);
  if (best === 0) return undefined;
  const satisfied = scoreDeclaration(requirements, blocks);
  if (satisfied >= best) return undefined;
  const names = requirements.map((requirement) => requirement.attacker.def.name).join(', ');
  return (
    `blocks must satisfy as many blocking requirements as possible ` +
    `(${satisfied} of ${best} satisfied; ${names} must be blocked if able)`
  );
}

/**
 * ONE maximum-satisfying assignment of the defender's creatures to
 * requirement-carrying attackers, or `undefined` when nothing requires anything.
 *
 * This is the seam an AI uses: a pilot that starts from this assignment and then
 * blocks freely with its REMAINING creatures can never propose a declaration the
 * engine refuses on requirement grounds, because the creatures this returns are
 * exactly the ones whose choice was not free. Sharing the solver — rather than
 * having the pilot reimplement the rule — is what keeps the two from disagreeing.
 */
export function forcedBlockAssignment(
  attackers: readonly CardInstance[],
  defenders: readonly CardInstance[],
  index: ContinuousIndex,
  battlefield: readonly CardInstance[] = NO_PERMANENTS,
): readonly BlockAssignment[] | undefined {
  const requirements = collectRequirements(attackers, defenders, index, battlefield);
  if (!requirements) return undefined;
  const { best, assignment } = solve(requirements);
  return best > 0 ? assignment : undefined;
}
