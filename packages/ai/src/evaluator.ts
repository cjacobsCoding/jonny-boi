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
 */

import type { CardInstance, GameState, PlayerId } from '@jonny-boi/core';
import {
  bestManaYield,
  effectivePower,
  effectiveToughness,
  isCreature,
  isLand,
  MANA_COLORS,
} from '@jonny-boi/core';
import type { PolicyCandidate } from './heuristic.js';
import { policyCandidates } from './heuristic.js';
import type { PilotView } from './pilot.js';
import type { GameAction } from '@jonny-boi/core';
import type { HeuristicWeights } from './weights.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';

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
   * Bonus when our board can deal lethal to their remaining life this turn — the
   * cheapest possible read on the brief's §11 "can we kill this turn?", without
   * building the full tactical solver.
   */
  readonly lethalThreatWeight: number;
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
  scale: 12,
  winScore: 1,
  lossScore: 0,
  drawScore: 0.5,
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

  const battlefield = state.battlefield;
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    const mine = perm.controller === player;
    if (isCreature(perm.def)) {
      const power = effectivePower(perm);
      const stats = power + effectiveToughness(perm);
      if (mine) {
        myStats += stats;
        myCreatures++;
        // Only an untapped, non-sick creature can attack this turn. `summoningSick`
        // is the engine's own flag, so this read cannot drift from the combat rules.
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

  const lethalNow = myPower >= them.life && myPower > 0 ? weights.lethalThreatWeight : 0;

  const points =
    weights.lifeWeight * (me.life - them.life) +
    weights.boardWeight * (myStats - theirStats) +
    weights.creatureCountWeight * (myCreatures - theirCreatures) +
    weights.cardAdvantageWeight * (me.hand.length - them.hand.length) +
    weights.manaDevelopmentWeight * (mySources - theirSources) +
    weights.untappedManaWeight * (myUntapped + floating - theirUntapped) +
    lethalNow;

  return 1 / (1 + Math.exp(-points / weights.scale));
}
