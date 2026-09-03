/**
 * The `lookahead` pilot — the heuristic everywhere, and a forecast-searched
 * combat step (DESIGN §3.47).
 *
 * ## What it is
 * Composition, not a fork: every decision that is not an attack declaration is
 * delegated to an unmodified `createHeuristicPilot`, so this pilot inherits the
 * heuristic's spell choice, land sequencing, block policy (§3.45's fight-maths
 * blocks included) and choice answering, byte for byte. The one decision §3.45
 * measured the heuristic getting wrong — WHO ATTACKS — is decided instead by
 * `combat-forecast.ts`: a bounded, deterministic adversarial search over attack
 * plans, each played forward in closed form through the defender's best-response
 * blocks, the crack-back it leaves open, and the multi-turn race it buys.
 *
 * ## Order of the attack decision
 *   1. **The proven kill first.** `lethalAttackers` (the exact tactical solver,
 *      over the engine's own eligibility list) — a kill no block assignment can
 *      stop is taken without a forecast, for the same reason the hybrid routes
 *      around its search (§3.4a brief §45): a proof does not go to the judge.
 *   2. **Otherwise, the forecast argmax** — including the empty plan, so
 *      "hold everything back" is always on the menu and wins whenever tapping
 *      the board forecasts worse than keeping the blockers up.
 *
 * ## Why no engine-stepping search
 * Measured in this branch: the `hybrid` search pilot plays 0.105 games/sec where
 * the heuristic plays 57.8 on the same matchup and seeds (~550×). A pilot that
 * costs three orders of magnitude cannot be the gauntlet/A-B default, whatever
 * it wins. The forecast spends a few thousand integer operations once per attack
 * step, which keeps this pilot in the heuristic's own throughput class — the
 * `pilot-ab` run that judges it also times it.
 *
 * ## Determinism
 * No RNG is consumed by the forecast (pure arithmetic, fixed tie-breaks), and
 * delegated decisions consume exactly the draws the heuristic would have — so a
 * seed reproduces the same game on any machine, which the Lab's paired verdicts
 * require.
 *
 * ## Debug observability
 * Every attack decision emits a `DecisionTrace` through the standard trace seam
 * (the sim log / inspector's channel): the plan, and the forecast's face damage,
 * expected trades, crack-back exposure and both clocks — "why did it attack"
 * as data, not console spam.
 */

import type { GameAction, GameState, InstanceId } from '@jonny-boi/core';
import type { DecisionContext, Pilot } from './pilot.js';
import { boardIndex } from './board-stats.js';
import type { ForecastWeights } from './combat-forecast.js';
import { chooseAttackPlan, DEFAULT_FORECAST_WEIGHTS } from './combat-forecast.js';
import type { HeuristicFeatures } from './heuristic.js';
import { createHeuristicPilot, planWalkerAttack } from './heuristic.js';
import { DEFAULT_TACTICAL_CONFIG, lethalAttackers } from './tactical.js';
import { withRequiredAttackers } from './attack-requirements.js';
import type { HeuristicWeights } from './weights.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';

/** The id the lookahead pilot registers under and is selected by from data. */
export const LOOKAHEAD_PILOT_ID = 'lookahead';

/**
 * Build the lookahead pilot. Both weight sets are data (DESIGN §1): the
 * heuristic weights drive every delegated decision AND the defender model inside
 * the forecast; the forecast weights price what only the forecast can see.
 */
export function createLookaheadPilot(
  weights: HeuristicWeights = DEFAULT_HEURISTIC_WEIGHTS,
  forecastWeights: ForecastWeights = DEFAULT_FORECAST_WEIGHTS,
  /**
   * The heuristic's A/B switches, passed straight through to the delegate —
   * a blocking or pricing feature reaches this pilot only this way, and
   * `bench/forecast-ab.mjs --feature` is how it is judged here (§3.108).
   */
  features: HeuristicFeatures = {},
): Pilot {
  const inner = createHeuristicPilot(weights, features);
  return {
    id: LOOKAHEAD_PILOT_ID,
    description:
      'The heuristic pilot with a forecast-searched combat step: attacks are chosen by playing each ' +
      'candidate plan through the defender\'s best-response blocks, the crack-back, and the race — ' +
      'several turns ahead in closed form, at heuristic speed.',
    chooseAction(ctx: DecisionContext): GameAction {
      try {
        const attack = decideAttack(ctx, weights, forecastWeights);
        if (attack) return attack;
      } catch {
        // Robustness (engineering rule 6): a forecast that trips on a state it
        // has never seen must cost one delegated decision, never a crash — the
        // heuristic below answers everything.
      }
      return inner.chooseAction(ctx);
    },
    /*
     * BOTH HARNESS SEAMS ARE DELEGATED, and it is safe by construction (§3.108):
     * the only window this pilot decides itself is the active seat's UNDECLARED
     * attack, and the heuristic's gate refuses exactly that window, so a `true`
     * from it is always about a window the heuristic would have answered anyway.
     * Until this delegation existed the DEFAULT pilot never fast-passed at all —
     * every one of its 550 windows a game built a full menu — which is why it ran
     * 15% slower than the pilot it is composed from.
     */
    willPassPriority(view: GameState): boolean {
      return inner.willPassPriority!(view);
    },
    chooseActions(ctx: DecisionContext): readonly GameAction[] {
      try {
        const attack = decideAttack(ctx, weights, forecastWeights);
        if (attack) return [attack];
      } catch {
        // As above: one delegated decision, never a crash.
      }
      return inner.chooseActions!(ctx);
    },
  };
}

/**
 * The one intercepted decision: this seat's attack declaration. Returns
 * `undefined` everywhere else — including every window the heuristic handles
 * specially (a parked choice, a madness window, a combat already declared) —
 * so delegation, not interception, is the default.
 */
function decideAttack(
  ctx: DecisionContext,
  weights: HeuristicWeights,
  forecastWeights: ForecastWeights,
): GameAction | undefined {
  const { view, legalActions } = ctx;
  if (view.pendingChoice != null) return undefined;
  if (view.step !== 'declareAttackers') return undefined;
  const me = view.priorityPlayer;
  if (me !== view.activePlayer) return undefined;
  const madness = view.madnessWindow;
  if (madness && madness.controller === me) return undefined;

  const offered = legalActions.find((a) => a.kind === 'declareAttackers') as
    | Extract<GameAction, { kind: 'declareAttackers' }>
    | undefined;
  if (!offered || offered.attackers.length === 0) return undefined;

  const state = view as GameState;
  const index = boardIndex(state);
  const opp = me === 'A' ? 'B' : 'A';

  // 1. The proven kill — exact, engine-eligible, no judgement involved.
  const kill = lethalAttackers(state, me, index, DEFAULT_TACTICAL_CONFIG, offered.attackers);
  if (kill && kill.length > 0) {
    // Plus the required attackers (CR 508.1d, §3.107) — see `withRequiredAttackers`.
    const roster = withRequiredAttackers(view, index, kill, offered.attackers);
    const action: GameAction = { kind: 'declareAttackers', player: me, attackers: [...roster] };
    ctx.trace?.({ action, reason: 'lookahead: proven lethal — unblockable by any assignment' });
    return action;
  }

  // 2. The forecast argmax over attack plans (the empty plan included).
  const choice = chooseAttackPlan(view, offered.attackers, weights, forecastWeights, index);
  const f = choice.forecast;
  // A plan that leaves a creature which "attacks each combat if able" at home
  // is not one the engine accepts (CR 508.1d, §3.107) — including the EMPTY
  // plan, so "hold everything back" becomes "send only what must go".
  const forecastRoster = withRequiredAttackers(view, index, choice.attackers, offered.attackers);
  if (forecastRoster.length === 0) {
    const pass: GameAction = { kind: 'passPriority', player: me };
    ctx.trace?.({
      action: pass,
      reason:
        `lookahead: holding back — attacking forecasts worse than keeping blockers up ` +
        `(their counterattack ${f.crackBack}, clocks me ${f.myClock} vs them ${f.theirClock})`,
      score: f.score,
    });
    return pass;
  }

  // The same planeswalker/battle diversion the heuristic makes for its chosen
  // set, so objects stay attackable under the forecast pilot too.
  const attackTargets = planWalkerAttack(view, opp, forecastRoster, weights, index);
  const action: GameAction = {
    kind: 'declareAttackers',
    player: me,
    attackers: forecastRoster as InstanceId[],
    ...(attackTargets !== undefined ? { attackTargets } : {}),
  };
  ctx.trace?.({
    action,
    reason:
      `lookahead: attack with ${choice.attackers.length}/${offered.attackers.length} — ` +
      `forecast ${f.faceDamage} to face` +
      (f.lethalNow ? ' (modelled lethal)' : '') +
      `, trades +${f.theirDeadStats}/-${f.myDeadStats} stats, ` +
      `crack-back ${f.crackBack}${f.facingLethalAfter ? ' (LETHAL — outraced)' : ''}, ` +
      `clocks me ${f.myClock} vs them ${f.theirClock}`,
    score: f.score,
  });
  return action;
}
