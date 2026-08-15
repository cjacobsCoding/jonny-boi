/**
 * Tunable knobs for the `hybrid` pilot (DESIGN §1 "data-driven, no magic numbers").
 *
 * Every dial that shapes the search — the budget, how fast it widens, how much it
 * trusts the policy prior, how deep it looks before evaluating — is a named field
 * here, so retuning the AI is a data edit rather than a code edit.
 */

import type { EvaluationWeights } from './evaluator.js';
import { DEFAULT_EVALUATION_WEIGHTS } from './evaluator.js';

/**
 * ⚠️ **THE TWO BUDGET POLICIES, AND WHY THEY MUST STAY SEPARATE.**
 *
 * `MctsConfig.maxDecisionMillis` documents a trap this project already fell into:
 * a wall-clock budget makes the search machine-dependent, so the same seed can
 * pick a different action on a second run — and in the Lab's paired A/B swap test
 * the base and variant arms can then receive *different* search budgets, which
 * destroys the common-random-numbers property the entire verdict rests on.
 *
 * The brief (§24) nevertheless wants time-based search, and it is right — for
 * PLAY. The resolution is that these are two different consumers with two
 * different requirements, so they get two explicitly named budget kinds rather
 * than one knob that quietly means both:
 *
 *   - `simulations` — deterministic, reproducible, the ONLY kind the Lab's
 *     evaluation path may use. Same seed ⇒ same action, on any machine.
 *   - `millis` — for interactive play, where a bounded response matters more
 *     than reproducibility. It still carries `maxSimulations` so a fast machine
 *     cannot run away, and it must never be used to produce statistics.
 *
 * Making the kind a discriminated union means a caller cannot *accidentally* be
 * time-based: `DEFAULT_HYBRID_CONFIG` is simulation-budgeted, and reaching for
 * the clock is a visible, deliberate choice at the call site.
 */
export type SearchBudget =
  | {
      readonly kind: 'simulations';
      /** Iterations per decision. The strength/speed dial for the Lab. */
      readonly simulations: number;
    }
  | {
      readonly kind: 'millis';
      /** Wall-clock cap per decision. NON-DETERMINISTIC — play only. */
      readonly millis: number;
      /** Hard ceiling so a fast machine still terminates predictably. */
      readonly maxSimulations: number;
    };

/** The complete, tunable knob set the hybrid pilot reads. Pure data. */
export interface HybridConfig {
  // --- budget ---------------------------------------------------------------
  readonly budget: SearchBudget;

  // --- selection (PUCT, brief §28) -------------------------------------------
  /**
   * `c_puct` in `U(s,a) = Q(s,a) + c_puct · P(s,a) · sqrt(N(s)) / (1 + N(s,a))`.
   * Higher ⇒ the prior holds sway for longer before visit counts take over.
   */
  readonly explorationConstant: number;
  /**
   * Softmax temperature converting the heuristic's raw scores into a prior:
   * `P(a) ∝ exp(score(a) / temperature)`. LOW ⇒ the policy is nearly a hard
   * choice; HIGH ⇒ the prior flattens and the search does more of the deciding.
   * It must never reach zero — brief §8: "a bad heuristic must never permanently
   * eliminate an action".
   */
  readonly policyTemperature: number;
  /**
   * The floor every candidate's prior is raised to before normalisation, as a
   * fraction of a uniform prior. This is the mechanical guarantee behind §8: even
   * an option the heuristic scores at negative infinity keeps a real, non-zero
   * probability of being searched.
   */
  readonly minPriorFraction: number;

  // --- progressive widening (brief §7) ---------------------------------------
  /** `numChildren = ceil(wideningCoefficient · visits^wideningExponent)`. */
  readonly wideningCoefficient: number;
  readonly wideningExponent: number;
  /** Never widen below this many children (so a node always has a real choice). */
  readonly minChildren: number;
  /**
   * Hard cap on candidates considered at one node — the brief's §5 "top K".
   * Deliberately generous: Phase 1 measured mean root branching of 4.8 and a max
   * of 9 *after* equivalence collapsing, so this almost never binds, and cutting
   * candidates the search might want is a worse failure than searching a few
   * extra. It exists as a guard against a pathological board, not as the focusing
   * mechanism — progressive widening is the focusing mechanism.
   */
  readonly maxCandidates: number;

  // --- depth + leaf evaluation (brief §9) -------------------------------------
  /**
   * How deep the tree itself may go, in strategic decisions. Beyond this the leaf
   * is evaluated instead of expanded.
   */
  readonly maxTreeDepth: number;
  /**
   * How many plies of fast-policy play to run at a leaf BEFORE evaluating it.
   * **Zero by default, and that is the Phase-4 change**: Phase 1 measured that
   * 95% of a vanilla decision's engine work is rollout plies and that 75% of
   * those rollouts never reach a terminal anyway, so they pay a hundred plies to
   * arrive at exactly the kind of static judgement `evaluateState` gives for
   * free. A small non-zero value is available for anyone who wants to re-measure
   * the trade.
   */
  readonly leafRolloutDepth: number;
  /**
   * How many engine actions the search may auto-resolve between two strategic
   * decisions (forced actions, empty priority windows — brief §4 Level 0). A
   * bound rather than a `while (true)`: a rules bug that produced an unadvancing
   * state must cost one decision, not hang the sim.
   */
  readonly maxAutoResolveSteps: number;
  /** Positional weights the leaf evaluator blends. */
  readonly evaluation: EvaluationWeights;
  /**
   * Per-decision discount pulling a terminal reward toward the draw line by how
   * many plies it took. Makes the pilot close won games out instead of dithering
   * into a timeout — the same reasoning as `MctsConfig.winSpeedDiscount`.
   */
  readonly winSpeedDiscount: number;
}

/**
 * The shipped hybrid configuration: a deterministic simulation budget, PUCT with
 * a moderately trusting prior, widening that reaches a fourth child at ~16 visits,
 * and NO rollout — the leaf evaluator does the judging.
 */
export const DEFAULT_HYBRID_CONFIG: HybridConfig = Object.freeze({
  budget: Object.freeze({ kind: 'simulations', simulations: 160 } as const),
  // sqrt(2) is the UCB1 default and a reasonable c_puct for [0,1] rewards; the
  // prior term makes it behave far less like uniform exploration than UCB1 did.
  explorationConstant: Math.SQRT2,
  // The heuristic's scores span roughly 0..40 (pass ~0, a creature ~5-10, removal
  // ~10-20, lethal ~100), so a temperature of 8 keeps a 10-point gap at about a
  // 3.5:1 prior ratio — a clear preference the search can still overturn.
  policyTemperature: 8,
  minPriorFraction: 0.1,
  wideningCoefficient: 1.2,
  wideningExponent: 0.5,
  minChildren: 2,
  maxCandidates: 12,
  maxTreeDepth: 24,
  leafRolloutDepth: 0,
  maxAutoResolveSteps: 64,
  evaluation: DEFAULT_EVALUATION_WEIGHTS,
  winSpeedDiscount: 0.005,
});

/**
 * A light configuration for tests and speed-sensitive sims. Exported so tests
 * never hard-code knob values (DESIGN §1 applies to tests too).
 */
export const FAST_HYBRID_CONFIG: HybridConfig = Object.freeze({
  ...DEFAULT_HYBRID_CONFIG,
  budget: Object.freeze({ kind: 'simulations', simulations: 32 } as const),
  maxTreeDepth: 12,
});

/**
 * An INTERACTIVE configuration for the web app / hotseat, where a bounded
 * response time matters more than reproducibility.
 *
 * ⚠️ **Never use this for the Lab, a gauntlet, or any A/B verdict.** It is
 * time-budgeted, therefore machine-dependent, therefore not reproducible, and the
 * paired swap test's whole premise is that both arms saw identical conditions.
 * See {@link SearchBudget}.
 */
export const PLAY_HYBRID_CONFIG: HybridConfig = Object.freeze({
  ...DEFAULT_HYBRID_CONFIG,
  budget: Object.freeze({ kind: 'millis', millis: 250, maxSimulations: 20000 } as const),
});
