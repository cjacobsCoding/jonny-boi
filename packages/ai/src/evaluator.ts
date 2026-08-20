/**
 * THE EVALUATION SEAM — `evaluateState` / `evaluatePolicy`
 * (`docs/plans/superhuman-ai-program.md` §29–31, and Brief A's "PV-net").
 *
 * The brief is explicit that a neural network **must not be a prerequisite** for
 * the first implementation: the interface goes in now, backed by the heuristic
 * engine that already encodes real MTG knowledge, and a learned model drops into
 * the same two methods later without the search knowing anything changed.
 *
 *   evaluateState(state, player) -> number in [0,1]   "how good is this for me?"
 *   evaluatePolicy(view, legal)  -> scored candidates "what would you consider?"
 *
 * ## Why this exists at all: it is the measured highest-leverage change
 * Phase 1 measured, on this repo, that a vanilla-MCTS decision spends **105.8
 * engine plies per simulation, of which 100.8 are rollout plies** — 95% of all
 * search work is playing games out with a fast policy. Cost is linear in that
 * depth (0.75 MB/decision at depth 1 → 18.9 MB at depth 120). And only **25% of
 * those rollouts ever reach a terminal**; the other three-quarters hit the depth
 * cap and get evaluated positionally anyway. So three-quarters of the time the
 * search pays for a hundred plies of simulation and then falls back on exactly the
 * kind of static judgement this file provides. Replacing the rollout attacks the
 * multiplier, not the constant.
 *
 * ## What the evaluator must NOT be
 * Brief §9: "Do NOT reduce MTG to life total + card count." The vanilla pilot's
 * leaf evaluation is literally life differential + summed power/toughness, and it
 * cannot see a hand full of removal, a mana screw, or a board it cannot deploy.
 * {@link DEFAULT_EVALUATION_WEIGHTS} names one weight per term so the blend is
 * data, tunable, and — per §10 — learnable later rather than hand-tuned forever.
 *
 * ## The tactical half (`tactical.ts`) — built, measured, shipped OFF
 * Four of the terms are not positional counts at all: they are answers from an
 * exact combat solver — can I force lethal through their best blocks, can they
 * force it through mine, how much damage does each board push per turn, and how
 * many turns each side needs. Those are the §11–12 questions, and they were built
 * because the search was measured to be limited by *this* function rather than by
 * its budget (256 → 1024 simulations bought +1.7 points; a 2.4×-deeper reused tree
 * bought nothing at all).
 *
 * ⚠️ They make the evaluator **measurably more correct and not measurably
 * stronger**, so they are a named non-default blend rather than the default. The
 * whole argument, with the table, is on {@link TACTICAL_EVALUATION_WEIGHTS}.
 * Do not turn them on without reading it.
 */

import type { CardInstance, GameState, PlayerId } from '@jonny-boi/core';
import { bestManaYield, isCreature, isLand, MANA_COLORS } from '@jonny-boi/core';
import type { ContinuousIndex } from './board-stats.js';
import { boardIndex, power as effPower, statTotal } from './board-stats.js';
import type { PolicyCandidate } from './heuristic.js';
import { policyCandidates } from './heuristic.js';
import type { PilotView } from './pilot.js';
import type { GameAction } from '@jonny-boi/core';
import type { HeuristicWeights } from './weights.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';
import { assessPosition } from './tactical.js';

/**
 * The two questions a search asks about a position. Named exactly as the brief
 * names them so the eventual learned implementation is a drop-in.
 */
export interface StateEvaluator {
  /** Stable id, so a run can record WHICH evaluator produced its numbers. */
  readonly id: string;
  /**
   * A win-probability-shaped score in [0,1] for `player`. 0.5 is an even
   * position; 1 is won; 0 is lost. Terminal positions are recognised here so the
   * search never has to special-case them.
   */
  evaluateState(state: GameState, player: PlayerId): number;
  /**
   * The strategic options at this decision with the policy's score attached —
   * the `P(s,a)` source for PUCT. Advisory only: the search may explore anything
   * in this list, and the list always contains every option, never a pruned set.
   */
  evaluatePolicy(view: PilotView, legalActions: readonly GameAction[]): PolicyCandidate[];
}

/**
 * The tunable blend of positional terms. One named weight per concept — DESIGN §1
 * forbids a magic number in a formula that shapes play, and every one of these is
 * a candidate for self-play tuning later (§10).
 */
export interface EvaluationWeights {
  /** Per point of life differential. */
  readonly lifeWeight: number;
  /** Per point of (power + toughness) of creature differential on board. */
  readonly boardWeight: number;
  /** Per card of hand-size differential — raw card advantage. */
  readonly cardAdvantageWeight: number;
  /**
   * Per mana source of differential. Mana development is the resource the
   * life-and-board evaluator is completely blind to, and it is what separates a
   * position that is behind-but-fine from one that has lost already.
   */
  readonly manaDevelopmentWeight: number;
  /**
   * Per point of UNTAPPED mana differential. Brief §36: "4 mana" and "4 mana with
   * two untapped" are different positions — held mana is represented interaction.
   */
  readonly untappedManaWeight: number;
  /**
   * Per creature of body-count differential, on top of raw stats. Two 2/2s and
   * one 4/4 are not the same board: bodies block, race, and survive removal
   * differently.
   */
  readonly creatureCountWeight: number;
  /**
   * Bonus when our board can force lethal through the defender's BEST blocks —
   * the brief's §11 "can we kill this turn?", answered exactly by `tactical.ts`
   * rather than guessed.
   *
   * ⚠️ This used to be `sum of untapped attackers' power >= their life`, which is
   * wrong in both directions and wrong in a way that *punished the right play*.
   * It ignored blockers entirely, so a wall of chump blockers read as a kill; and
   * because attackers TAP when they are declared, the bonus vanished one ply into
   * the very combat it was recommending — the search saw attacking with a lethal
   * board as *losing* the lethal bonus. The solver reads the declared attackers
   * once combat has begun, so the signal is stable across the whole step.
   */
  readonly lethalThreatWeight: number;
  /**
   * Penalty when the OPPONENT can force lethal through our best blocks on their
   * next attack (brief §11 anti-lethal, §12 opponent-threat).
   *
   * The evaluator had no term of any kind for being dead on board. On a grindy
   * matchup that is the single most important fact about a position, and its
   * absence is a plausible reason the pilot's edge on UW Control vs Golgari never
   * cleared 50% while it was clear on aggro boards. It also prices the crack-back:
   * a player who alpha strikes is tapped out of blockers during the opponent's
   * turn, and this is the term that can see that.
   */
  readonly facingLethalWeight: number;
  /**
   * Per point of *guaranteed* combat damage differential — damage each side can
   * force through the other's best blocks (brief §9 "combat potential").
   *
   * This is what `boardWeight` cannot say. Four 0/4 walls are 16 points of stats
   * and zero pressure; a lone 5/1 flier facing no fliers is 6 points of stats and
   * a five-turn clock. Summed power and toughness measures how much board there
   * is; this measures whether any of it can end the game.
   */
  readonly pressureWeight: number;
  /**
   * Per attack step of clock advantage — how many turns their board needs to kill
   * us, minus how many ours needs to kill them (brief §10 "inevitability", §44
   * "threat horizon"). Saturated by `TacticalConfig.maxClockTurns`, so a board
   * that cannot break through is "slow", never infinite.
   */
  readonly clockWeight: number;
  /**
   * Which "can I kill this turn" read {@link lethalThreatWeight} pays for: the
   * blocker-aware solver (`true`) or the original `untapped-power >= their life`
   * guess (`false`, the shipped default — see {@link TACTICAL_EVALUATION_WEIGHTS}
   * for why the more correct one is not the default one).
   *
   * A boolean rather than a second weight because these are two *implementations*
   * of one term, not two terms — and keeping the old one runnable is what lets the
   * claim "the solver is better" be measured on identical seeds in one process
   * instead of asserted.
   */
  readonly useTacticalLethal: boolean;
  /**
   * Half-saturation constant for the logistic squash: this many eval points maps
   * to roughly a 0.73 score. Keeps every term on one [0,1] scale so no single
   * term can dominate the reward the search backs up.
   */
  readonly scale: number;
  /** Reward for a won / lost / drawn terminal position. */
  readonly winScore: number;
  readonly lossScore: number;
  readonly drawScore: number;
}

/**
 * The shipped blend. The *relative* shape is the design: life and board dominate
 * (they are what actually ends games), card advantage and mana development are
 * worth roughly a life point each per unit, and untapped mana is a small nudge
 * rather than a strategy.
 */
export const DEFAULT_EVALUATION_WEIGHTS: EvaluationWeights = Object.freeze({
  lifeWeight: 1,
  boardWeight: 1,
  cardAdvantageWeight: 1.5,
  manaDevelopmentWeight: 1,
  untappedManaWeight: 0.25,
  creatureCountWeight: 0.5,
  lethalThreatWeight: 6,
  // ⚠️ THE TACTICAL TERMS SHIP OFF — a MEASURED decision, not an oversight. See
  // `TACTICAL_EVALUATION_WEIGHTS` for the table, and `evaluator.test.ts` for the
  // test that pins it. Zero here also means the solver is never called, so this
  // blend is the previous evaluator exactly: same play, same cost, and every
  // recorded baseline in DESIGN §3.4a/§3.4b still reproduces byte for byte.
  facingLethalWeight: 0,
  pressureWeight: 0,
  clockWeight: 0,
  useTacticalLethal: false,
  scale: 12,
  winScore: 1,
  lossScore: 0,
  drawScore: 0.5,
});

/**
 * THE TACTICAL BLEND — the solver's four terms switched on. **Built, measured,
 * and NOT the default.** Read the numbers before turning it on.
 *
 * It is unambiguously the more *correct* evaluator: on the curated ordering suite
 * (`tactical-suite.ts`) it scores **5/5** against the default's **0/5**, and two
 * of those five the default gets actively backwards — it scores taking a proven
 * kill BELOW declining it, and scores fifteen power that three walls stop ABOVE
 * six power that nothing stops.
 *
 * It is also, on every measurement taken, **not stronger**:
 *
 * | measurement | default | tactical |
 * |---|---|---|
 * | Mono-Red vs Boros, n=120, vs heuristic | 60.0% [51.1, 68.3] | 60.0% [51.1, 68.3] |
 * | UW Control vs Golgari, n=80, vs heuristic | 53.8% [42.9, 64.3] | 55.0% [44.1, 65.4] |
 * | head to head, aggro, n=120 | — | 48.3% [39.6, 57.2] |
 *
 * A per-term ablation on the aggro matchup (`bench tactical`, arms `lethal`,
 * `router`, `facing`, `pressure`, `clock` each alone) put **every single arm on the
 * identical 72/120**, so this is not one good term cancelling one bad one — no
 * term moves that matchup at all.
 *
 * Cost is NOT the reason it ships off; it is free or slightly cheaper (6.83 →
 * 6.70–6.97 ms on aggro, **14.33 → 13.63 ms on control**). The reason is simply
 * that the brief's rule applies: a change that does not measurably help does not
 * become the default. Keeping the default identical also keeps every baseline the
 * other in-flight branches measure against intact.
 *
 * 👉 **Worth re-asking when the search changes, not just when the weights do.**
 * The most likely explanation for "more correct, no stronger" is that at 160
 * simulations on these two matchups the search already reaches the terminal on the
 * positions these terms describe — which is exactly what the pilot half of the
 * tactical suite showed. A cheaper search (`THRIFTY_HYBRID_CONFIG`), a shallower
 * budget, or a deck whose games are decided further from a terminal would all move
 * that balance.
 */
export const TACTICAL_EVALUATION_WEIGHTS: EvaluationWeights = Object.freeze({
  ...DEFAULT_EVALUATION_WEIGHTS,
  facingLethalWeight: 6,
  pressureWeight: 0.6,
  clockWeight: 0.75,
  useTacticalLethal: true,
});

/**
 * Build the heuristic-backed evaluator — the initial implementation of the seam.
 *
 * It is deliberately allocation-free on its hot path: one pass over the
 * battlefield accumulating both players' terms at once, no intermediate arrays.
 * The search calls `evaluateState` once per simulation, so it sits directly on the
 * budget that decides how many simulations a decision gets.
 */
export function createHeuristicEvaluator(
  weights: EvaluationWeights = DEFAULT_EVALUATION_WEIGHTS,
  policyWeights: HeuristicWeights = DEFAULT_HEURISTIC_WEIGHTS,
): StateEvaluator {
  return {
    id: 'heuristic-eval',
    evaluateState(state, player) {
      return evaluatePosition(state, player, weights);
    },
    evaluatePolicy(view, legalActions) {
      return policyCandidates(view, legalActions, policyWeights);
    },
  };
}

/**
 * Score a position for `player`, squashed into [0,1].
 *
 * Terminal first — a decided game has no positional content — then a single
 * battlefield pass that accumulates every board-derived term for both seats at
 * once, then the zone counts, then one logistic squash.
 */
export function evaluatePosition(
  state: GameState,
  player: PlayerId,
  weights: EvaluationWeights = DEFAULT_EVALUATION_WEIGHTS,
): number {
  if (state.gameOver) {
    if (state.winner === null) return weights.drawScore;
    return state.winner === player ? weights.winScore : weights.lossScore;
  }
  const opponent: PlayerId = player === 'A' ? 'B' : 'A';

  let myStats = 0;
  let theirStats = 0;
  let myCreatures = 0;
  let theirCreatures = 0;
  let mySources = 0;
  let theirSources = 0;
  let myUntapped = 0;
  let theirUntapped = 0;
  let myPower = 0;

  // ONE index for the whole evaluation, built before the battlefield pass and
  // handed to the tactical solver below. This function used to read printed P/T,
  // so every anthem, Aura, Equipment and `*` P/T box was invisible to the search's
  // leaf evaluation — see `board-stats.ts`.
  const index = boardIndex(state);
  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    const mine = perm.controller === player;
    if (isCreature(perm.def)) {
      const power = effPower(perm, index);
      const stats = statTotal(perm, index);
      if (mine) {
        myStats += stats;
        myCreatures++;
        // Untapped, non-sick power. Feeds ONLY the legacy blocker-blind lethal
        // read, kept runnable as `PRE_TACTICAL_EVALUATION_WEIGHTS`'s control arm.
        // The shipped lethal answer comes from `tactical.ts`, which also knows
        // about blockers, evasion, trample and first strike.
        if (!perm.tapped && !perm.summoningSick) myPower += power;
      } else {
        theirStats += stats;
        theirCreatures++;
      }
    }
    // Mana development counts anything that TAPS FOR MANA, not just lands — a
    // Birds of Paradise really is a land in this respect, and a pilot that could
    // not see that would misjudge every ramp deck.
    const yield_ = isLand(perm.def) ? Math.max(1, bestManaYield(perm.def)) : bestManaYield(perm.def);
    if (yield_ > 0) {
      if (mine) {
        mySources++;
        if (!perm.tapped) myUntapped += yield_;
      } else {
        theirSources++;
        if (!perm.tapped) theirUntapped += yield_;
      }
    }
  }

  const me = state.players[player];
  const them = state.players[opponent];
  let floating = 0;
  for (const color of MANA_COLORS) floating += me.manaPool[color];

  const points =
    weights.lifeWeight * (me.life - them.life) +
    weights.boardWeight * (myStats - theirStats) +
    weights.creatureCountWeight * (myCreatures - theirCreatures) +
    weights.cardAdvantageWeight * (me.hand.length - them.hand.length) +
    weights.manaDevelopmentWeight * (mySources - theirSources) +
    weights.untappedManaWeight * (myUntapped + floating - theirUntapped) +
    tacticalPoints(state, player, weights, myPower, them.life, index);

  return 1 / (1 + Math.exp(-points / weights.scale));
}

/**
 * The combat-derived half of the score (`tactical.ts`): lethal, anti-lethal,
 * pressure, and clock.
 *
 * ## The cost gate, and why it is shaped like this
 * The solver is skipped entirely when every tactical weight is zero AND the old
 * lethal read is selected — which is the shipped {@link DEFAULT_EVALUATION_WEIGHTS}.
 * That is not a micro-optimisation, it is what makes the default a true control
 * arm: it runs the *previous* code at the previous cost, in the same process, on
 * the same seeds as {@link TACTICAL_EVALUATION_WEIGHTS}. An A/B whose control
 * still pays for the feature measures nothing useful — and a default that pays for
 * a feature it has switched off is a rule-7 regression for nothing.
 *
 * ## The continuous index, which this used to skip
 * `assessPosition` is handed the index `evaluateState` already built for its own
 * battlefield pass. It previously ran with none — the leaf evaluator solved combat
 * on printed numbers while the decision path solved it on real ones, so the search
 * scored positions its own pilot would have judged differently. Sharing the one
 * index costs nothing: it is built once per evaluation either way, and a board with
 * no anthem, attachment or pump gets core's shared empty map with no allocation.
 */
function tacticalPoints(
  state: GameState,
  player: PlayerId,
  weights: EvaluationWeights,
  untappedAttackPower: number,
  opponentLife: number,
  index: ContinuousIndex,
): number {
  const wantsSolver =
    weights.useTacticalLethal ||
    weights.facingLethalWeight !== 0 ||
    weights.pressureWeight !== 0 ||
    weights.clockWeight !== 0;
  if (!wantsSolver) {
    // The original blocker-blind read, kept runnable as the measurement control.
    return untappedAttackPower > 0 && untappedAttackPower >= opponentLife ? weights.lethalThreatWeight : 0;
  }

  const { offence, threat } = assessPosition(state, player, index);
  let points = 0;
  if (weights.useTacticalLethal) {
    if (offence.lethal) points += weights.lethalThreatWeight;
  } else if (untappedAttackPower > 0 && untappedAttackPower >= opponentLife) {
    points += weights.lethalThreatWeight;
  }
  if (threat.lethal) points -= weights.facingLethalWeight;
  points += weights.pressureWeight * (offence.guaranteedDamage - threat.guaranteedDamage);
  points += weights.clockWeight * (threat.turnsToKill - offence.turnsToKill);
  return points;
}
