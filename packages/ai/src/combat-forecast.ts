/**
 * THE COMBAT FORECAST — attack plans searched against the defender's answer, the
 * crack-back, and the race (DESIGN §3.47).
 *
 * ## Why this exists — the measured gap, and the two failures it must not repeat
 * §3.45 measured exactly where the heuristic pilot loses games: the ATTACK
 * declaration. It also measured, and REJECTED, the two obvious fixes, and this
 * module is designed around those two post-mortems rather than around theory:
 *
 *   1. Teaching `attackIsProfitable` the fight maths alone makes both seats
 *      refuse every attack into a deathtoucher — the board locks (51% → 27% vs
 *      Mono-Green, timeout draws 10 → 29). The missing piece was ALLOCATION: one
 *      1/2 can only actually block one attacker.
 *   2. Adding allocation un-stalls it and then LOSES the deck-neutral A/B
 *      1406–1422, because freeing marginal attackers taps out a pilot with no
 *      model of the CRACK-BACK. The ⚠️ on `attackIsProfitable` names that model
 *      as the honest next step. This file is that model.
 *
 * ## What a forecast is
 * For one candidate attack plan (a subset of the engine's own eligibility list),
 * play the whole exchange forward in closed form — no state clone, no engine
 * call, pure arithmetic over the board:
 *
 *   1. **The defender's answer.** Predict the blocks with the SAME code the
 *      defending pilot runs — `forcedBlockAssignment`, then `pickBlocker` per
 *      attacker in the same order with the same weights — so the model and the
 *      modelled defender cannot drift apart. Who dies is `resolveFight`'s answer.
 *   2. **The crack-back.** After the exchange, what can the opponent force
 *      through the blockers I have LEFT — my survivors minus everything this
 *      plan taps (vigilance excepted)? A port of the tactical solver's greedy
 *      prevention bound (`tactical.ts` proves greedy exact for this nested
 *      blocking structure), so the number is a floor on their counterattack,
 *      never a guess.
 *   3. **The race.** Both clocks after the exchange — how many attack steps each
 *      side needs at its guaranteed rate. This is the several-turns-ahead term:
 *      it is the closed-form value of the alternating attack-step game under
 *      static boards, which is what "who wins if we just race" means.
 *
 * The plan chosen is the argmax over a bounded, deterministic candidate family
 * (empty, singletons, greedy prefixes, all-in, plus local toggle refinement) —
 * an adversarial search over combat plans, NOT a full-width game-tree search.
 * The full-width alternative was measured in this branch at ~550× the
 * heuristic's whole-game cost (`hybrid`, 0.105 games/sec vs 57.8 on the same
 * matchup); this module's whole search costs a few thousand integer operations
 * once per attack step.
 *
 * ## What it deliberately does not model
 * Cards. No combat trick, removal spell, or flashed-in blocker — the same bet
 * the tactical solver documents. The defender model is the shipped heuristic
 * block policy; a different pilot may block differently, and the meta this pilot
 * is measured against IS that policy. Gang blocks appear only where a block
 * REQUIREMENT forces them, exactly as in the modelled defender.
 */

import type { CardInstance, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import {
  forcedBlockAssignment,
  indexReplacements,
  isCreature,
  projectDamage,
} from '@jonny-boi/core';
import type { ContinuousIndex } from './board-stats.js';
import { keywordsOf, power, statTotal, toughnessLeft } from './board-stats.js';
import { resolveFight } from './combat-math.js';
import { pickBlocker, saboteurTriggerCount, totalIncomingDamage } from './heuristic.js';
import type { PilotView } from './pilot.js';
import type { HeuristicWeights } from './weights.js';
import { DEFAULT_TACTICAL_CONFIG } from './tactical.js';

/**
 * The forecast's own tunable knobs (DESIGN §1 — every number that shapes play is
 * named data). They price the two things the plain heuristic cannot see at all —
 * exposure to the counterattack, and the multi-turn race — on the same scale the
 * heuristic already uses (`faceDamageValue` = 1 per point of face damage).
 */
export interface ForecastWeights {
  /**
   * Penalty per point of the opponent's GUARANTEED counterattack damage next
   * turn, given the blockers this plan leaves untapped. Below 1 on purpose: a
   * point of damage taken next turn is worth less than a point dealt now (they
   * may not attack, I may have answers, and their guarantee is a floor computed
   * for them, not a promise). At 0 the crack-back is invisible — which is
   * exactly the §3.45 build that lost 1406–1422.
   */
  readonly crackBackPerPoint: number;
  /**
   * Penalty when the plan leaves the opponent a PROVEN lethal counterattack —
   * their guaranteed damage through my remaining blockers meets my life. Sized
   * to dominate any ordinary combat gain (the heuristic scores lethal burn ~100
   * on the same scale), because no trade is worth handing back a forced kill.
   * Not applied when the plan itself is modelled lethal first — killing them
   * now beats fearing a turn they will not get.
   */
  readonly crackBackLethalPenalty: number;
  /**
   * Value per attack step of race advantage after the exchange — the opponent's
   * clock minus mine, each at its guaranteed rate, saturated by the tactical
   * solver's `maxClockTurns`. Positive when the exchange leaves me the faster
   * board. Small relative to a point of damage: clocks are a coarse, saturated
   * signal and should steer ties, not overrule concrete damage and trades.
   */
  readonly racePerTurn: number;
  /**
   * Bonus when the plan's forecast face damage — AFTER the modelled defender's
   * best answer — meets the opponent's life. On the heuristic's lethal-burn
   * scale (~100) so a modelled kill outbids every holding pattern. The PROVEN
   * kill (unblockable by any assignment) is taken before any forecast runs, via
   * `lethalAttackers`; this bonus covers the kill the model expects through the
   * predicted blocks, which is a bet on the block model rather than a proof.
   */
  readonly modeledLethalBonus: number;
  /**
   * Local-refinement passes over the chosen plan (toggle each attacker in/out,
   * keep improvements). Two passes reach a local optimum on every board the
   * candidate family does not already solve; more buys nothing measurable and
   * this bound keeps the whole search O(passes · n · cost(forecast)).
   */
  readonly refinePasses: number;
}

/** The shipped blend. See each field for why it is the size it is. */
export const DEFAULT_FORECAST_WEIGHTS: ForecastWeights = Object.freeze({
  crackBackPerPoint: 0.5,
  crackBackLethalPenalty: 100,
  racePerTurn: 1.5,
  modeledLethalBonus: 100,
  refinePasses: 2,
});

/** Everything one plan's forecast concluded — kept for the decision trace. */
export interface PlanForecast {
  /** Face damage expected through the modelled defence (trample included). */
  readonly faceDamage: number;
  /** Stats (power+toughness) of my attackers the model expects to die. */
  readonly myDeadStats: number;
  /** Stats of the defender's blockers the model expects to die. */
  readonly theirDeadStats: number;
  /** Combat-damage-to-player triggers expected to connect. */
  readonly saboteurs: number;
  /** The opponent's guaranteed counterattack next turn, after this plan. */
  readonly crackBack: number;
  /** `crackBack` meets my life — the plan hands back a forced kill. */
  readonly facingLethalAfter: boolean;
  /** My attack steps to finish them at my post-exchange guaranteed rate. */
  readonly myClock: number;
  /** Their attack steps to finish me at the crack-back rate. */
  readonly theirClock: number;
  /** The forecast face damage meets their life — a modelled kill. */
  readonly lethalNow: boolean;
  /** The blended score the plan was ranked by. */
  readonly score: number;
}

/** The planner's answer: the attackers to declare (empty = hold), plus why. */
export interface AttackPlanChoice {
  /** In the eligibility list's order — the order the declaration will carry. */
  readonly attackers: readonly InstanceId[];
  readonly forecast: PlanForecast;
}

// --- the per-decision context ---------------------------------------------------

/**
 * Everything the forecast reads that does not change between candidate plans,
 * gathered once per decision. Plans differ only in which attackers tap.
 */
interface ForecastContext {
  readonly view: PilotView;
  readonly state: GameState;
  readonly me: PlayerId;
  readonly opp: PlayerId;
  readonly index: ContinuousIndex;
  readonly weights: HeuristicWeights;
  readonly forecast: ForecastWeights;
  /** The engine's eligibility list, as instances, in the engine's order. */
  readonly eligible: readonly CardInstance[];
  /** The defender's untapped creatures — the block pool the model draws from. */
  readonly defenders: readonly CardInstance[];
  /** Every creature the defender controls (crack-back attacker pool). */
  readonly theirCreatures: readonly CardInstance[];
  /** Every creature I control (crack-back blocker pool). */
  readonly myCreatures: readonly CardInstance[];
  readonly myLife: number;
  readonly theirLife: number;
  /** True when the state carries any damage replacement — the projection gate. */
  readonly hasReplacements: boolean;
}

/**
 * Choose the attack plan: forecast a bounded candidate family and take the best.
 *
 * `eligible` MUST be the engine's own offered `declareAttackers.attackers` list —
 * the returned subset is then a legal narrowing by construction. Returns the
 * empty plan when holding everything back forecasts best.
 */
export function chooseAttackPlan(
  view: PilotView,
  eligibleIds: readonly InstanceId[],
  weights: HeuristicWeights,
  forecastWeights: ForecastWeights,
  index: ContinuousIndex,
): AttackPlanChoice {
  const state = view as GameState;
  const me = view.activePlayer;
  const opp: PlayerId = me === 'A' ? 'B' : 'A';

  const eligible: CardInstance[] = [];
  for (const id of eligibleIds) {
    const inst = findOnBattlefield(state, id);
    // A 0-power attacker deals nothing, deters nothing in this model, and only
    // soaks a plan slot — same rule the heuristic applies per attacker.
    if (inst && power(inst, index) > 0) eligible.push(inst);
  }

  const defenders: CardInstance[] = [];
  const theirCreatures: CardInstance[] = [];
  const myCreatures: CardInstance[] = [];
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (!isCreature(perm.def)) continue;
    if (perm.controller === opp) {
      theirCreatures.push(perm);
      if (!perm.tapped) defenders.push(perm);
    } else if (perm.controller === me) {
      myCreatures.push(perm);
    }
  }

  const ctx: ForecastContext = {
    view,
    state,
    me,
    opp,
    index,
    weights,
    forecast: forecastWeights,
    eligible,
    defenders,
    theirCreatures,
    myCreatures,
    myLife: state.players[me].life,
    theirLife: state.players[opp].life,
    hasReplacements: indexReplacements(state).length > 0,
  };

  // The empty plan is evaluated first and is the standing answer ties fall back
  // to: when attacking buys nothing the forecast can see, hold the board.
  const empty = forecastPlan(ctx, []);
  let bestPlan: CardInstance[] = [];
  let best = empty;

  if (eligible.length === 0) return { attackers: [], forecast: empty };

  // Every candidate is normalised to ELIGIBILITY order before it is forecast.
  // The declaration is submitted in that order, `chooseBlock` re-sorts the
  // declared attackers by power with a STABLE sort, and the forecast's defender
  // model does the same — so equal-power ties resolve identically in the model
  // and at the table only if both start from the same sequence.
  const eligibilityIndex = new Map<CardInstance, number>();
  for (let i = 0; i < eligible.length; i++) eligibilityIndex.set(eligible[i] as CardInstance, i);
  const normalize = (plan: readonly CardInstance[]): CardInstance[] =>
    [...plan].sort(
      (a, b) => (eligibilityIndex.get(a) as number) - (eligibilityIndex.get(b) as number),
    );

  // Singletons — both candidates in their own right and the ordering signal for
  // the prefix family below.
  const singleScores = new Array<number>(eligible.length);
  for (let i = 0; i < eligible.length; i++) {
    const plan = [eligible[i] as CardInstance];
    const f = forecastPlan(ctx, plan);
    singleScores[i] = f.score;
    if (f.score > best.score) {
      best = f;
      bestPlan = plan;
    }
  }

  // Greedy prefixes of the singleton ordering (best individual attackers first),
  // which includes the all-in plan as the final prefix. Deterministic: ties keep
  // the engine's eligibility order.
  const order = eligible
    .map((_, i) => i)
    .sort((a, b) => (singleScores[b] as number) - (singleScores[a] as number) || a - b);
  const prefix: CardInstance[] = [];
  for (let k = 0; k < order.length; k++) {
    prefix.push(eligible[order[k] as number] as CardInstance);
    if (prefix.length < 2) continue; // singletons already evaluated
    const plan = normalize(prefix);
    const f = forecastPlan(ctx, plan);
    if (f.score > best.score) {
      best = f;
      bestPlan = plan;
    }
  }

  // Local refinement: toggle each eligible attacker in or out of the best plan,
  // keep strict improvements. Escapes prefix-order artifacts (e.g. the right
  // plan is "first and third but not second") at bounded cost.
  for (let pass = 0; pass < forecastWeights.refinePasses; pass++) {
    let improved = false;
    for (let i = 0; i < eligible.length; i++) {
      const inst = eligible[i] as CardInstance;
      const inPlan = bestPlan.includes(inst);
      const candidate = inPlan
        ? bestPlan.filter((c) => c !== inst)
        : normalize([...bestPlan, inst]);
      const f = forecastPlan(ctx, candidate);
      if (f.score > best.score) {
        best = f;
        bestPlan = candidate;
        improved = true;
      }
    }
    if (!improved) break;
  }

  // Attacking must clear the same margin over holding that the heuristic's own
  // per-attacker rule demanded (`attackValueThreshold`), so a hair's-width of
  // modelled gain does not tap the board — the model is not that precise.
  if (bestPlan.length > 0 && best.score < empty.score + weights.attackValueThreshold) {
    return { attackers: [], forecast: empty };
  }

  // Submit in the ENGINE's eligibility order — also the order the modelled
  // defender saw (via the power-descending re-sort both sides share), so the
  // declaration the engine carries is the declaration that was forecast.
  const chosen: InstanceId[] = [];
  for (const inst of eligible) {
    if (bestPlan.includes(inst)) chosen.push(inst.instanceId);
  }
  return { attackers: chosen, forecast: best };
}

// --- one plan, forecast --------------------------------------------------------

/** Forecast one candidate plan. Pure; the state is never touched. */
function forecastPlan(ctx: ForecastContext, plan: readonly CardInstance[]): PlanForecast {
  const { index, weights, forecast } = ctx;

  // -- 1. the defender's answer -------------------------------------------------
  // Exactly `chooseBlock`'s procedure: incoming damage decides desperation, the
  // attackers are considered biggest first (stable), requirements are satisfied
  // first, then `pickBlocker` chooses per attacker with the defender's weights.
  const myDead = new Set<InstanceId>();
  const theirDead = new Set<InstanceId>();
  let faceDamage = 0;
  let myDeadStats = 0;
  let theirDeadStats = 0;
  let saboteurs = 0;
  let lifelinkGain = 0;

  if (plan.length > 0) {
    const planIds: InstanceId[] = new Array(plan.length);
    for (let i = 0; i < plan.length; i++) planIds[i] = (plan[i] as CardInstance).instanceId;
    const incoming = totalIncomingDamage(ctx.view, planIds, index);
    const desperate =
      incoming >= ctx.theirLife || ctx.theirLife <= weights.desperateLifeThreshold;

    const sorted = [...plan].sort((a, b) => power(b, index) - power(a, index));
    const used = new Set<InstanceId>();
    // blockersOf[i] parallels sorted[i]; a requirement can force extras.
    const blockersOf: CardInstance[][] = new Array(sorted.length);
    for (let i = 0; i < sorted.length; i++) blockersOf[i] = [];

    const forced = forcedBlockAssignment(sorted, ctx.defenders, index);
    if (forced) {
      for (const assignment of forced) {
        const at = sorted.findIndex((a) => a.instanceId === assignment.attacker);
        const blocker = findIn(ctx.defenders, assignment.blocker);
        if (at >= 0 && blocker) {
          (blockersOf[at] as CardInstance[]).push(blocker);
          used.add(assignment.blocker);
        }
      }
    }
    for (let i = 0; i < sorted.length; i++) {
      const attacker = sorted[i] as CardInstance;
      const blocker = pickBlocker(attacker, ctx.defenders, used, desperate, weights, index);
      if (blocker) {
        (blockersOf[i] as CardInstance[]).push(blocker);
        used.add(blocker.instanceId);
      }
    }

    // -- 2. the exchange ---------------------------------------------------------
    for (let i = 0; i < sorted.length; i++) {
      const attacker = sorted[i] as CardInstance;
      const assigned = blockersOf[i] as CardInstance[];
      if (assigned.length === 0) {
        const damage = projectedPower(ctx, attacker, ctx.opp);
        faceDamage += damage;
        if (keywordsOf(attacker, index).lifelink === true) lifelinkGain += damage;
        saboteurs += saboteurTriggerCount(attacker, ctx.view);
        continue;
      }
      const primary = assigned[0] as CardInstance;
      const outcome = resolveFight(attacker, primary, index);
      let attackerDies = outcome.attackerDies;
      // A gang block exists here only when a REQUIREMENT forced it (the modelled
      // defender never volunteers one). The extras' damage still lands on the
      // attacker; their own fates are approximated as survival — the engine
      // assigns lethal to the first blocker before any extra sees damage.
      for (let x = 1; x < assigned.length; x++) {
        if (resolveFight(attacker, assigned[x] as CardInstance, index).attackerDies) {
          attackerDies = true;
        }
      }
      if (attackerDies) {
        myDead.add(attacker.instanceId);
        myDeadStats += statTotal(attacker, index);
      }
      if (outcome.blockerDies) {
        theirDead.add(primary.instanceId);
        theirDeadStats += statTotal(primary, index);
      }
      faceDamage += outcome.damageThrough;
    }
  }

  const lethalNow = faceDamage > 0 && faceDamage >= ctx.theirLife;

  // -- 3. the crack-back ----------------------------------------------------------
  // Their whole surviving board attacks next turn ('next' horizon: tapped and
  // summoning-sick creatures untap and settle before that step); my blockers are
  // my survivors that this plan does not tap — vigilance keeps a body on defence,
  // and anything already tapped stays tapped until MY untap step, which comes
  // after their whole turn.
  const myLifeAfter = ctx.myLife + lifelinkGain;
  const crackBack = guaranteedDamage(
    ctx,
    ctx.theirCreatures,
    theirDead,
    ctx.me,
    (mine) =>
      !myDead.has(mine.instanceId) &&
      !mine.tapped &&
      (!planContains(plan, mine) || keywordsOf(mine, index).vigilance === true),
  );
  const facingLethalAfter = crackBack > 0 && crackBack >= myLifeAfter;

  // -- 4. the race ------------------------------------------------------------------
  // My rate next turn: my survivors (everything untaps by my next attack step)
  // against their surviving blocker pool. Their rate: the crack-back guarantee.
  // Clocks saturate at the tactical solver's bound, for the same reason it has one.
  const myRate = guaranteedDamage(
    ctx,
    ctx.myCreatures,
    myDead,
    ctx.opp,
    (theirs) => !theirDead.has(theirs.instanceId),
  );
  const theirLifeAfter = ctx.theirLife - faceDamage;
  const myClock = lethalNow ? 0 : clockFor(theirLifeAfter, myRate);
  const theirClock = facingLethalAfter ? 1 : clockFor(myLifeAfter, crackBack);

  // -- 5. the blend -----------------------------------------------------------------
  let score =
    weights.faceDamageValue * faceDamage +
    weights.attackSaboteurTriggerValue * saboteurs +
    weights.killEnemyPerStat * theirDeadStats -
    weights.ownCreatureLossPerStat * myDeadStats -
    forecast.crackBackPerPoint * crackBack +
    forecast.racePerTurn * (theirClock - myClock);
  if (lethalNow) {
    score += forecast.modeledLethalBonus;
  } else if (facingLethalAfter) {
    score -= forecast.crackBackLethalPenalty;
  }

  return {
    faceDamage,
    myDeadStats,
    theirDeadStats,
    saboteurs,
    crackBack,
    facingLethalAfter,
    myClock,
    theirClock,
    lethalNow,
    score,
  };
}

// --- the guaranteed-damage bound (the tactical solver's greedy, over hypotheticals) --

/**
 * Damage `attackerPool` (minus `dead`) can force through the blockers that pass
 * `defenderKeeps`. Tapped-ness is deliberately NOT read off the attackers: every
 * attacker considered here attacks on a FUTURE turn, after its untap step (the
 * tactical solver's 'next' horizon) — the tactical solver's lower bound (`maximumPreventableDamage`)
 * computed over a HYPOTHETICAL board the forecast describes with predicates
 * instead of with a mutated state. Same structure, same conservatism: prevention
 * is over-estimated (a trampler priced as if ganged, first strike stops a
 * trampler outright, unblockable is never "prevented"), so the answer is a floor.
 */
function guaranteedDamage(
  ctx: ForecastContext,
  attackerPool: readonly CardInstance[],
  dead: ReadonlySet<InstanceId>,
  defendingSeat: PlayerId,
  defenderKeeps: (blocker: CardInstance) => boolean,
): number {
  const { index } = ctx;
  // Blockers first — their counts gate every prevention figure.
  let blockers = 0;
  let evasiveBlockers = 0;
  const absorb: number[] = [];
  const canBlockEvasive: boolean[] = [];
  const fsPower: number[] = [];
  const fsDeathtouch: boolean[] = [];
  const blockerSource =
    defendingSeat === ctx.me ? ctx.myCreatures : ctx.theirCreatures;
  for (const perm of blockerSource) {
    if (!defenderKeeps(perm)) continue;
    const kw = keywordsOf(perm, index);
    absorb.push(Math.max(0, toughnessLeft(perm, index)));
    const evasiveCapable = kw.flying === true || kw.reach === true;
    canBlockEvasive.push(evasiveCapable);
    if (evasiveCapable) evasiveBlockers++;
    const first = kw.firstStrike === true || kw.doubleStrike === true;
    fsPower.push(first ? Math.max(0, power(perm, index)) : 0);
    fsDeathtouch.push(first && kw.deathtouch === true);
    blockers++;
  }

  let total = 0;
  const gains: number[] = [];
  const gainIsEvasive: boolean[] = [];
  for (const perm of attackerPool) {
    if (dead.has(perm.instanceId)) continue;
    const kw = keywordsOf(perm, index);
    if (kw.defender === true) continue;
    const raw = power(perm, index);
    if (raw <= 0) continue;
    const damage = projectedPower(ctx, perm, defendingSeat);
    total += damage;
    if (kw.unblockable === true) continue; // nothing prevents it — no gain entry
    const evasive = kw.flying === true;
    const usable = evasive ? evasiveBlockers : blockers;
    if (usable === 0) continue;
    let prevented: number;
    if (kw.trample !== true) {
      prevented = damage; // one blocker eats the whole hit
    } else {
      prevented = Math.min(
        damage,
        tramplePrevention(
          kw.deathtouch === true,
          evasive,
          Math.max(0, toughnessLeft(perm, index)),
          damage,
          blockers,
          absorb,
          canBlockEvasive,
          fsPower,
          fsDeathtouch,
        ),
      );
    }
    if (prevented <= 0) continue;
    gains.push(prevented);
    gainIsEvasive.push(evasive);
  }

  // Greedy by prevention descending — exact for this nested blocking structure
  // (the matroid argument in `tactical.ts`'s header). Deterministic tie-break by
  // collection order.
  const order = gains.map((_, i) => i).sort((a, b) => (gains[b] as number) - (gains[a] as number) || a - b);
  let prevented = 0;
  let usedBlockers = 0;
  let usedEvasive = 0;
  for (const i of order) {
    if (usedBlockers >= blockers) break;
    if (gainIsEvasive[i] === true) {
      if (usedEvasive >= evasiveBlockers) continue;
      usedEvasive++;
    }
    usedBlockers++;
    prevented += gains[i] as number;
  }
  return Math.max(0, total - prevented);
}

/**
 * How much of a trampler the described defence could absorb — the tactical
 * solver's deliberately generous bound: every legal blocker gangs it, deathtouch
 * makes each absorb exactly one, and a first-striker that kills it outright
 * stops the whole hit.
 */
function tramplePrevention(
  deathtouch: boolean,
  evasive: boolean,
  attackerToughness: number,
  attackerDamage: number,
  blockers: number,
  absorb: readonly number[],
  canBlockEvasive: readonly boolean[],
  fsPower: readonly number[],
  fsDeathtouch: readonly boolean[],
): number {
  let totalAbsorbed = 0;
  for (let b = 0; b < blockers; b++) {
    if (evasive && canBlockEvasive[b] !== true) continue;
    const first = fsPower[b] as number;
    if (first > 0 && (fsDeathtouch[b] === true || first >= attackerToughness)) return attackerDamage;
    totalAbsorbed += deathtouch ? 1 : (absorb[b] as number);
  }
  return totalAbsorbed;
}

// --- small helpers ----------------------------------------------------------------

/** A creature's power as the REPLACEMENT layer would deliver it to `recipient`. */
function projectedPower(ctx: ForecastContext, perm: CardInstance, recipient: PlayerId): number {
  const raw = power(perm, ctx.index);
  if (!ctx.hasReplacements || raw <= 0) return raw;
  return projectDamage(
    ctx.state,
    indexReplacements(ctx.state),
    perm,
    perm.controller,
    undefined,
    recipient,
    raw,
    true,
  ).amount;
}

/**
 * Attack steps to finish `life` at `perTurn` guaranteed damage, saturated at the
 * tactical solver's own clock bound so "cannot break through" reads as slow, not
 * as infinity.
 */
function clockFor(life: number, perTurn: number): number {
  if (life <= 0) return 0;
  if (perTurn <= 0) return DEFAULT_TACTICAL_CONFIG.maxClockTurns;
  return Math.min(DEFAULT_TACTICAL_CONFIG.maxClockTurns, Math.ceil(life / perTurn));
}

function planContains(plan: readonly CardInstance[], inst: CardInstance): boolean {
  for (let i = 0; i < plan.length; i++) if (plan[i] === inst) return true;
  return false;
}

function findIn(pool: readonly CardInstance[], id: InstanceId): CardInstance | undefined {
  for (let i = 0; i < pool.length; i++) {
    if ((pool[i] as CardInstance).instanceId === id) return pool[i] as CardInstance;
  }
  return undefined;
}

function findOnBattlefield(state: GameState, id: InstanceId): CardInstance | undefined {
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    if (perm.instanceId === id) return perm;
  }
  return undefined;
}
