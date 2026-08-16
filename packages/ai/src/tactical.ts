/**
 * THE TACTICAL SOLVER — combat questions answered EXACTLY, not sampled
 * (`docs/plans/superhuman-ai-program.md` §11–12, §39).
 *
 * ## Why this exists, and why now
 * Two independent branches measured the same thing: the `hybrid` pilot is limited
 * by its EVALUATOR, not by how much it searches. Its budget sweep bought +11.7
 * points going 16 → 256 simulations and **+1.7** for the next 4×; tree reuse
 * carried 217–284 inherited visits into a 160-simulation budget — a search ~2.4×
 * deeper in information — and produced *identical play*. More search is not the
 * lever. A better leaf judgement is.
 *
 * Some questions should never be answered by stochastic search at all, because a
 * tiny exact computation answers them **exactly** and far more cheaply:
 *
 *   - Can I kill this turn, whatever they block with?
 *   - Can they kill me on the crack-back, whatever I block with?
 *   - How many turns does each side's board need to finish the other?
 *
 * ## The combinatorial trap, and how this avoids it
 * Brief §39 is explicit: never blindly enumerate attacker subsets × blocker
 * assignments × damage assignments. Two structural facts collapse that space here:
 *
 * 1. **Damage assignment is not a decision in this engine.** `internal/combat.ts`
 *    assigns lethal to blockers in declared order and tramples the remainder. So
 *    there is no third dimension at all.
 * 2. **Block legality is *nested*, which makes the assignment problem trivial.**
 *    core's `canBlock` rejects exactly one thing — a flier blocked by a creature
 *    with neither flying nor reach. So the blockers that may block a flier are a
 *    SUBSET of the blockers that may block a ground creature. A set of attackers
 *    `S` can therefore all be blocked simultaneously if and only if
 *    `fliers(S) ≤ (flying-or-reach blockers)` and `|S| ≤ (blockers)` — Hall's
 *    condition, with only two tight sets. The feasible sets form a matroid, so
 *    **greedy by damage-prevented descending is exactly optimal** and no matching
 *    algorithm is needed. `blockLegalityMatchesEngine` in the tests pins that
 *    equivalence against the real engine rather than against this comment.
 *
 * And the attacker subset is not searched either: adding an attacker can never
 * *lower* the damage that gets through optimal blocks (it adds power on one side
 * and a constraint on the other), so "attack with everything eligible" maximises
 * guaranteed damage by construction. The only interesting attack question — which
 * subset trades best when the kill is NOT there — stays with the policy and the
 * search, which is what they are good at.
 *
 * ## Conservative by construction, in one direction, on purpose
 * Every bound here **over**-estimates what the defender can prevent (a trampler's
 * prevention is priced as if every legal blocker could gang up on it, which no
 * 1:1 assignment can actually achieve). So `guaranteedDamage` is a LOWER bound on
 * the damage that really gets through, and `lethal` therefore never fires on a
 * kill that is not there. It can miss one; it cannot invent one. That asymmetry is
 * what makes it safe to *act* on the answer rather than merely score it.
 *
 * ## What it deliberately does NOT model
 * Cards. No combat trick, removal spell, blocker the opponent could flash in, or
 * activated pump is considered — this is a solver over the board as it stands. A
 * pilot that acts on a "lethal" here is making the same bet a human makes when
 * they attack into open mana, and the search above it is still free to disagree.
 */

import type {
  CardInstance,
  ContinuousIndex,
  GameState,
  InstanceId,
  KeywordFlags,
  PlayerId,
} from '@jonny-boi/core';
import {
  effectiveKeywords,
  effectivePower,
  isCreature,
  NO_MOD,
  opponentOf,
  remainingToughness,
} from '@jonny-boi/core';

/**
 * Tunable bounds for the solver (DESIGN §1 — no magic numbers, even in a helper).
 */
export interface TacticalConfig {
  /**
   * Ceiling on a reported clock, in attack steps. A board that cannot force
   * damage through has an infinite clock, and infinity poisons every arithmetic
   * term downstream of it, so "slower than this" saturates here instead. It is
   * also the honest modelling claim: past a dozen turns the difference between
   * "20 turns" and "never" is not information an evaluator can use.
   */
  readonly maxClockTurns: number;
}

/** The shipped bounds. */
export const DEFAULT_TACTICAL_CONFIG: TacticalConfig = Object.freeze({
  maxClockTurns: 12,
});

/**
 * WHICH attack is being asked about. The distinction is load-bearing rather than
 * cosmetic — the two questions have different answers on the same board.
 *
 *   - `'now'` — "if I swing with what is legally able to attack *right now*".
 *     Inside a combat that has already been declared this is the DECLARED set, so
 *     the answer does not change the instant attackers tap.
 *   - `'next'` — "what can this player force through on their next attack step".
 *     Their tapped and summoning-sick creatures are counted (they will untap and
 *     settle), while the *defender's* blockers are counted as they stand now.
 *     That asymmetry is the point: creatures that just attacked are tapped and
 *     will still be tapped during the opponent's turn, so a player who alpha
 *     strikes really does have no blockers for the crack-back, and this is the
 *     term that lets an evaluator see it.
 */
export type AttackHorizon = 'now' | 'next';

/** What the solver knows about one side's attack. */
export interface CombatAssessment {
  /** Total power that would reach the defender's face if nothing blocked. */
  readonly maxDamage: number;
  /**
   * Damage that reaches the face even against the defender's BEST blocks — a
   * lower bound, never an optimistic one. See the file header.
   */
  readonly guaranteedDamage: number;
  /** `guaranteedDamage >= defender life`: a kill no block can prevent. */
  readonly lethal: boolean;
  /**
   * Attack steps needed to finish the defender at this guaranteed rate, saturated
   * at {@link TacticalConfig.maxClockTurns}. The §10 "inevitability" signal: which
   * board wins the long game if nothing else changes.
   */
  readonly turnsToKill: number;
  /** How many creatures the assessed set contains (0 ⇒ no attack is possible). */
  readonly attackerCount: number;
}

/** An assessment of an empty board — allocated once, never mutated. */
const NO_ATTACK: CombatAssessment = Object.freeze({
  maxDamage: 0,
  guaranteedDamage: 0,
  lethal: false,
  turnsToKill: DEFAULT_TACTICAL_CONFIG.maxClockTurns,
  attackerCount: 0,
});

// --- reusable scratch --------------------------------------------------------------
//
// `evaluateState` runs once per simulation and the hybrid's default budget is 160
// simulations per decision, so this must not allocate per call. The buffers are
// module-level and grown on demand — the same technique `packages/core`'s mana
// planner used to cut 86% of its allocation, and for the same reason.
//
// Reused buffers can leak state between calls, so every one of them is written
// before it is read within a single `assess` and never read past its live count.

const INITIAL_CAPACITY = 16;
/** Power of each candidate attacker. */
let attackerPower = new Int32Array(INITIAL_CAPACITY);
/** Maximum damage the defence could stop by blocking this attacker. */
let attackerPrevented = new Int32Array(INITIAL_CAPACITY);
/** 1 when this attacker may only be blocked by flying/reach creatures. */
let attackerEvasive = new Uint8Array(INITIAL_CAPACITY);
/** 1 when this attacker's damage spills past its blocker. */
let attackerTrample = new Uint8Array(INITIAL_CAPACITY);
/** 1 when any damage from this attacker is lethal, so a blocker absorbs only 1. */
let attackerDeathtouch = new Uint8Array(INITIAL_CAPACITY);
/** Battlefield instance id, so a caller can turn an assessment into a declaration. */
let attackerInstance = new Int32Array(INITIAL_CAPACITY);
/** Indices into the above, sorted by `attackerPrevented` descending. */
let attackerOrder = new Int32Array(INITIAL_CAPACITY);
/** Remaining toughness of each attacker — what a first-striking blocker must beat. */
let attackerToughness = new Int32Array(INITIAL_CAPACITY);
/** Damage each available blocker absorbs before dying (deathtouch is applied later). */
let blockerAbsorb = new Int32Array(INITIAL_CAPACITY);
/** 1 when this blocker can block a flier. */
let blockerCanBlockEvasive = new Uint8Array(INITIAL_CAPACITY);
/**
 * Damage this blocker deals in the FIRST-STRIKE step, or 0 if it deals none.
 * Only first-strike damage can stop an attacker before it assigns its own.
 */
let blockerFirstStrikePower = new Int32Array(INITIAL_CAPACITY);
/** 1 when this blocker's first-strike damage is lethal at any amount. */
let blockerFirstStrikeDeathtouch = new Uint8Array(INITIAL_CAPACITY);

function growTo(capacity: number): void {
  if (capacity <= attackerPower.length) return;
  let next = attackerPower.length;
  while (next < capacity) next *= 2;
  attackerPower = new Int32Array(next);
  attackerPrevented = new Int32Array(next);
  attackerEvasive = new Uint8Array(next);
  attackerTrample = new Uint8Array(next);
  attackerDeathtouch = new Uint8Array(next);
  attackerInstance = new Int32Array(next);
  attackerOrder = new Int32Array(next);
  attackerToughness = new Int32Array(next);
  blockerAbsorb = new Int32Array(next);
  blockerCanBlockEvasive = new Uint8Array(next);
  blockerFirstStrikePower = new Int32Array(next);
  blockerFirstStrikeDeathtouch = new Uint8Array(next);
}

/**
 * Everything the solver read out of the battlefield on its single pass, kept as
 * counts into the module buffers rather than as objects.
 */
interface Combatants {
  readonly attackers: number;
  readonly blockers: number;
  /** How many of those blockers may legally block a flier. */
  readonly evasiveBlockers: number;
}

// --- the public questions -----------------------------------------------------------

/**
 * Assess what `attacker` can force through `defender`'s blocks.
 *
 * `index` is the continuous-effects layer (anthems, auras, until-EOT pumps). It is
 * OPTIONAL and the two call sites pass different things on purpose: the decision
 * path — where the answer is *acted on* — builds the real index, while the leaf
 * evaluator omits it and reads base + counters, exactly as every other term in
 * `evaluator.ts` already does. Building the index costs a `Map` per call, and a
 * per-leaf `Map` is precisely the kind of allocation this pilot cannot afford.
 */
export function assessAttack(
  state: GameState,
  attacker: PlayerId,
  horizon: AttackHorizon = 'now',
  index?: ContinuousIndex,
  config: TacticalConfig = DEFAULT_TACTICAL_CONFIG,
  eligible?: readonly InstanceId[],
): CombatAssessment {
  const defender = opponentOf(attacker);
  const restrictTo = eligible ?? declaredAttackersFor(state, attacker, horizon);
  const counts = collectCombatants(state, attacker, defender, horizon, restrictTo, index);
  if (counts.attackers === 0) return NO_ATTACK;

  const maxDamage = sumAttackerPower(counts.attackers);
  const prevented = maximumPreventableDamage(counts);
  const guaranteed = Math.max(0, maxDamage - prevented);
  const life = state.players[defender].life;
  return {
    maxDamage,
    guaranteedDamage: guaranteed,
    lethal: guaranteed > 0 && guaranteed >= life,
    turnsToKill: clockFor(life, guaranteed, config),
    attackerCount: counts.attackers,
  };
}

/**
 * The attack that kills, or `undefined` when the board cannot force one.
 *
 * Returns EVERY eligible attacker, which is not laziness: adding an attacker adds
 * power to one side and a blocking constraint to the other, so the all-in
 * declaration maximises guaranteed damage by construction. Holding a creature back
 * is a trade-off that only matters when the kill is NOT available — and that
 * position is handed to the search, which is what search is for.
 *
 * `eligible` restricts the candidates to a list the caller already knows the
 * engine will accept — the `attackers` field of the offered `declareAttackers`.
 * Pass it whenever the answer will be PLAYED: the engine, not this module, is the
 * authority on who may attack, and computing the guarantee over the engine's own
 * list is what stops the guarantee being weakened by an intersection afterwards.
 *
 * The caller gets a plain id list rather than an action so this stays usable by
 * an evaluator, a pilot and a test alike.
 */
export function lethalAttackers(
  state: GameState,
  attacker: PlayerId,
  index?: ContinuousIndex,
  config: TacticalConfig = DEFAULT_TACTICAL_CONFIG,
  eligible?: readonly InstanceId[],
): readonly InstanceId[] | undefined {
  const assessment = assessAttack(state, attacker, 'now', index, config, eligible);
  if (!assessment.lethal) return undefined;
  const out: InstanceId[] = new Array(assessment.attackerCount);
  for (let i = 0; i < assessment.attackerCount; i++) out[i] = attackerInstance[i] as InstanceId;
  return out;
}

/**
 * The tactical picture from one seat: what I can do to them, and what they can do
 * to me, as one object so an evaluator pays for one battlefield pass per side
 * rather than four.
 */
export interface TacticalPicture {
  /** What this player can force through, attacking with what is legal now. */
  readonly offence: CombatAssessment;
  /**
   * What the OPPONENT can force through on their next attack step, against the
   * blockers this player has available as the board stands. The anti-lethal
   * question of §11, and the §12 "what is the strongest thing they can do".
   */
  readonly threat: CombatAssessment;
}

/** Both halves of the tactical picture for `player`. */
export function assessPosition(
  state: GameState,
  player: PlayerId,
  index?: ContinuousIndex,
  config: TacticalConfig = DEFAULT_TACTICAL_CONFIG,
): TacticalPicture {
  return {
    offence: assessAttack(state, player, 'now', index, config),
    threat: assessAttack(state, opponentOf(player), 'next', index, config),
  };
}

// --- the machinery -------------------------------------------------------------------

/**
 * The attackers already declared this combat, or `undefined` to derive them.
 *
 * Reading the declared set is what keeps the lethal signal STABLE across a combat.
 * Without it, the answer changes the moment attackers tap: a board that reads
 * "lethal on the table" before the declaration reads "no attack at all" one ply
 * later, because every attacker is now tapped. An evaluator built that way
 * actively discourages the search from taking a kill it can see — it prices
 * attacking as *losing* the lethal bonus.
 */
function declaredAttackersFor(
  state: GameState,
  attacker: PlayerId,
  horizon: AttackHorizon,
): readonly InstanceId[] | undefined {
  if (horizon !== 'now') return undefined;
  const combat = state.combat;
  if (!combat || !combat.attackersDeclared) return undefined;
  if (state.activePlayer !== attacker) return undefined;
  return combat.attackers;
}

/**
 * One battlefield pass filling the scratch buffers. Returns the counts; the data
 * lives in the module arrays.
 */
function collectCombatants(
  state: GameState,
  attacker: PlayerId,
  defender: PlayerId,
  horizon: AttackHorizon,
  restrictTo: readonly InstanceId[] | undefined,
  index?: ContinuousIndex,
): Combatants {
  const battlefield = state.battlefield;
  growTo(battlefield.length);
  let attackers = 0;
  let blockers = 0;
  let evasiveBlockers = 0;

  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (!isCreature(perm.def)) continue;
    const mod = index?.get(perm.instanceId) ?? NO_MOD;
    const keywords = effectiveKeywords(perm, mod);

    if (perm.controller === attacker) {
      if (!canAttack(perm, keywords, horizon, restrictTo)) continue;
      const power = effectivePower(perm, mod);
      if (power <= 0) continue;
      attackerPower[attackers] = power;
      attackerEvasive[attackers] = keywords.flying ? 1 : 0;
      attackerTrample[attackers] = keywords.trample ? 1 : 0;
      attackerInstance[attackers] = perm.instanceId;
      // Deathtouch belongs to the attacker rather than the blocker: it changes how
      // much damage a blocker can ABSORB from *this* attacker, not the blocker's
      // own toughness.
      attackerDeathtouch[attackers] = keywords.deathtouch ? 1 : 0;
      attackerToughness[attackers] = Math.max(0, remainingToughness(perm, mod));
      attackers++;
      continue;
    }
    if (perm.controller !== defender) continue;
    // A tapped creature cannot block (core's `canBlock`). Summoning sickness does
    // NOT stop a creature blocking, which is why it is not tested here.
    if (perm.tapped) continue;
    blockerAbsorb[blockers] = Math.max(0, remainingToughness(perm, mod));
    const canFace = Boolean(keywords.flying || keywords.reach);
    blockerCanBlockEvasive[blockers] = canFace ? 1 : 0;
    const strikesFirst = Boolean(keywords.firstStrike || keywords.doubleStrike);
    blockerFirstStrikePower[blockers] = strikesFirst ? Math.max(0, effectivePower(perm, mod)) : 0;
    blockerFirstStrikeDeathtouch[blockers] = strikesFirst && keywords.deathtouch ? 1 : 0;
    if (canFace) evasiveBlockers++;
    blockers++;
  }
  return { attackers, blockers, evasiveBlockers };
}

/**
 * Can this creature attack in the window `horizon` describes?
 *
 * A `restrictTo` list is the ENGINE's answer — the declared attackers, or the
 * offered eligibility list — and it wins outright: re-deriving eligibility on top
 * of a list the engine already produced can only ever disagree with it.
 * Otherwise, `'next'` deliberately ignores tapped and summoning-sick (both resolve
 * before that attack happens) while `'now'` honours them.
 */
function canAttack(
  perm: CardInstance,
  keywords: KeywordFlags,
  horizon: AttackHorizon,
  restrictTo: readonly InstanceId[] | undefined,
): boolean {
  if (restrictTo) return restrictTo.includes(perm.instanceId);
  if (keywords.defender) return false;
  if (horizon === 'next') return true;
  if (perm.tapped) return false;
  return !perm.summoningSick || Boolean(keywords.haste);
}

/** Total power of the collected attackers. */
function sumAttackerPower(count: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += attackerPower[i] as number;
  return total;
}

/**
 * The most damage the defence can stop, as an upper bound.
 *
 * Prevention per attacker is computed first (it depends only on the attacker and
 * on what the blocker pool looks like), then the greedy runs. Greedy is exactly
 * optimal here because the blockable sets form a transversal matroid over a NESTED
 * bipartite graph — see the file header.
 */
function maximumPreventableDamage(counts: Combatants): number {
  const { attackers, blockers, evasiveBlockers } = counts;
  if (blockers === 0) return 0;

  for (let i = 0; i < attackers; i++) {
    const power = attackerPower[i] as number;
    const usable = attackerEvasive[i] === 1 ? evasiveBlockers : blockers;
    if (usable === 0) {
      attackerPrevented[i] = 0;
      continue;
    }
    if (attackerTrample[i] === 0) {
      // One blocker eats the whole hit; nothing reaches the player.
      attackerPrevented[i] = power;
      continue;
    }
    attackerPrevented[i] = Math.min(power, tramplePrevention(i, counts));
  }

  sortAttackersByPreventionDescending(attackers);

  let prevented = 0;
  let usedBlockers = 0;
  let usedEvasiveBlockers = 0;
  for (let k = 0; k < attackers; k++) {
    const i = attackerOrder[k] as number;
    const gain = attackerPrevented[i] as number;
    if (gain <= 0) continue;
    if (usedBlockers >= blockers) break;
    if (attackerEvasive[i] === 1) {
      if (usedEvasiveBlockers >= evasiveBlockers) continue;
      usedEvasiveBlockers++;
    }
    usedBlockers++;
    prevented += gain;
  }
  return prevented;
}

/**
 * How much of a trampler's damage the defence could absorb, priced as if every
 * legal blocker gang-blocked it.
 *
 * That is a genuine over-estimate — a 1:1 assignment cannot achieve it, and the
 * greedy above then assumes it *and* re-uses those blockers elsewhere. It is
 * chosen deliberately: over-estimating prevention makes `guaranteedDamage` a lower
 * bound, so a claimed lethal is always real. A trampler is the one shape where an
 * exact answer would need a real assignment search, and paying for one on the leaf
 * path to sharpen a bound that is already safe is the wrong trade.
 */
function tramplePrevention(attackerIndex: number, counts: Combatants): number {
  const deathtouch = attackerDeathtouch[attackerIndex] === 1;
  const evasive = attackerEvasive[attackerIndex] === 1;
  const toughness = attackerToughness[attackerIndex] as number;
  const power = attackerPower[attackerIndex] as number;
  let total = 0;
  for (let b = 0; b < counts.blockers; b++) {
    if (evasive && blockerCanBlockEvasive[b] === 0) continue;
    // FIRST STRIKE IS THE ONE THING THAT STOPS A TRAMPLER COMPLETELY. A blocker
    // that deals lethal damage in the first-strike step kills the attacker before
    // it ever assigns, so nothing tramples over — and a solver that priced this as
    // "absorbs its toughness, the rest spills through" would claim a lethal that
    // does not exist. Every other bound here is generous to the defence; this one
    // has to be, or the guarantee stops being a guarantee.
    const firstStrike = blockerFirstStrikePower[b] as number;
    if (firstStrike > 0 && (blockerFirstStrikeDeathtouch[b] === 1 || firstStrike >= toughness)) return power;
    // Deathtouch means one point IS lethal, so a deathtouch trampler is absorbed by
    // exactly 1 per blocker no matter how large the blocker is (CR 702.2c) — which
    // is why this is the attacker's property and not the blocker's.
    total += deathtouch ? 1 : (blockerAbsorb[b] as number);
  }
  return total;
}

/**
 * Insertion sort of `attackerOrder` by prevention descending.
 *
 * Insertion sort rather than `Array.prototype.sort` because this runs on the leaf
 * path: a comparator sort allocates a closure and boxes the indices, and the input
 * is a handful of creatures where an O(n²) pass over a typed array is faster than
 * the call overhead of the generic sort.
 */
function sortAttackersByPreventionDescending(count: number): void {
  for (let i = 0; i < count; i++) attackerOrder[i] = i;
  for (let i = 1; i < count; i++) {
    const value = attackerOrder[i] as number;
    const key = attackerPrevented[value] as number;
    let j = i - 1;
    while (j >= 0 && (attackerPrevented[attackerOrder[j] as number] as number) < key) {
      attackerOrder[j + 1] = attackerOrder[j] as number;
      j--;
    }
    attackerOrder[j + 1] = value;
  }
}

/** Attack steps to finish `life` at `perTurn` damage, saturated at the cap. */
function clockFor(life: number, perTurn: number, config: TacticalConfig): number {
  if (perTurn <= 0 || life <= 0) return config.maxClockTurns;
  return Math.min(config.maxClockTurns, Math.ceil(life / perTurn));
}
