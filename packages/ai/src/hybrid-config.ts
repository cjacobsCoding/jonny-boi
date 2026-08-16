/**
 * Tunable knobs for the `hybrid` pilot (DESIGN §1 "data-driven, no magic numbers").
 *
 * Every dial that shapes the search — the budget, how fast it widens, how much it
 * trusts the policy prior, how deep it looks before evaluating — is a named field
 * here, so retuning the AI is a data edit rather than a code edit.
 */

import type { EvaluationWeights } from './evaluator.js';
import { DEFAULT_EVALUATION_WEIGHTS, TACTICAL_EVALUATION_WEIGHTS } from './evaluator.js';
import type { TacticalConfig } from './tactical.js';
import { DEFAULT_TACTICAL_CONFIG } from './tactical.js';

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

/**
 * TREE REUSE between decisions (`docs/plans/superhuman-ai-program.md` §21–22).
 *
 * The search matches the live position against the tree it built last time and
 * re-roots onto it instead of starting from nothing. See `tree-reuse.ts` for why
 * the match is by POSITION rather than by action, and for the determinism
 * argument that makes history-dependence safe for the Lab's paired A/B verdict.
 */
export interface TreeReuseConfig {
  /**
   * Off restores the previous behaviour EXACTLY — no fingerprints are computed,
   * no tree is retained — which is what makes an honest A/B of the feature a
   * config flip rather than a rebuild.
   */
  readonly enabled: boolean;
  /**
   * How many tree edges below the retained root the live position is looked for,
   * and equivalently how deep positions are recorded.
   *
   * Real play moves one or two strategic decisions between two calls to the same
   * seat, so a small bound finds everything findable while keeping both the
   * per-node fingerprint cost and the per-decision walk small.
   */
  readonly maxDepth: number;
  /**
   * Multiplier applied to every reused visit count and reward at promotion —
   * `1` reuses statistics as they stand.
   *
   * Visits and reward are scaled together, so a node's MEAN is preserved exactly
   * and only its CONFIDENCE shrinks: the inherited search becomes a prior the
   * fresh simulations can outvote rather than a verdict they cannot. The right
   * value is an empirical question (`mcts-bench.mjs reuse`), not a matter of
   * taste.
   */
  readonly decay: number;
  /**
   * Hard cap on the retained subtree, in nodes. Over it the tree is dropped
   * whole rather than trimmed, so the pilot's footprint is bounded by
   * construction over an arbitrarily long game.
   */
  readonly maxNodes: number;
}

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

  // --- tactical solver (brief §11–12, §39) ------------------------------------
  /**
   * Bounds the exact combat solver reads (`tactical.ts`).
   */
  readonly tactical: TacticalConfig;
  /**
   * The decision router's `if (IsImmediateLethal)` branch (brief §45): play a
   * proven-unblockable lethal attack instead of searching the position.
   *
   * A separate flag from the evaluator's tactical weights because they are two
   * distinct claims that deserve two distinct measurements — "the evaluator judges
   * combat better" and "some positions should bypass the search entirely" can be
   * true independently, and bundling them would leave nobody able to say which one
   * paid. Measured alone on Mono-Red vs Boros, n=120: **72/120, identical to the
   * control**. Ships off with the rest; see {@link TACTICAL_HYBRID_CONFIG}.
   */
  readonly takeProvenLethal: boolean;

  // --- reuse between decisions (brief §21–22) ---------------------------------
  readonly reuse: TreeReuseConfig;
}

/**
 * Reuse turned ON, with the settings that measured best.
 *
 * `decay: 1` (inherit statistics as they stand) is the MEASURED answer rather
 * than the lazy one: `decay: 0.5` was run on the identical 120 seeded games and
 * finished one game apart (73/120 vs 72/120), i.e. indistinguishable. The knob
 * stays because the question is worth re-asking whenever the evaluator changes —
 * it is the evaluator, not the search, that this pilot is currently limited by.
 *
 * `maxDepth: 4` is generous for what it has to do: the live position was found
 * in the retained tree on **94–96%** of decisions across both measured matchups,
 * so the bound is not what limits reuse.
 */
export const TREE_REUSE_ON: TreeReuseConfig = Object.freeze({
  enabled: true,
  maxDepth: 4,
  decay: 1,
  maxNodes: 8192,
});

/** Reuse turned off — the shipped default, and the A/B control. */
export const TREE_REUSE_OFF: TreeReuseConfig = Object.freeze({
  ...TREE_REUSE_ON,
  enabled: false,
});

/**
 * The shipped hybrid configuration: a deterministic simulation budget, PUCT with
 * a moderately trusting prior, widening that reaches a fourth child at ~16 visits,
 * and NO rollout — the leaf evaluator does the judging.
 *
 * ⚠️ **`reuse` is OFF here, and that is a MEASURED decision — read this before
 * flipping it.** Tree reuse (brief §21–22) is fully implemented and tested, and
 * on the same protocol that produced this pilot's recorded numbers it did not
 * make it play better *at the same budget*, while making every decision cost
 * appreciably more:
 *
 * | matchup | reuse OFF | reuse ON | mean decision OFF → ON |
 * |---|---|---|---|
 * | Mono-Red vs Boros, n=120 | 60.0% [51.1, 68.3] | 60.0% [51.1, 68.3] | 6.49 → 8.76 ms |
 * | UW Control vs Golgari, n=80 | 53.8% [42.9, 64.3] | 56.3% [45.3, 66.6] | 10.52 → 16.71 ms |
 *
 * Turning it on at this budget would therefore be a rule-7 throughput regression
 * bought with a strength gain that is not there, so the default keeps the pilot
 * exactly as it was measured. What reuse *does* buy is a cheaper search — see
 * {@link THRIFTY_HYBRID_CONFIG}.
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
  tactical: DEFAULT_TACTICAL_CONFIG,
  // ⚠️ OFF, and measured — see `TACTICAL_HYBRID_CONFIG` and DESIGN §3.4c. With
  // this false and the evaluation weights at their defaults, the pilot is the one
  // §3.4a/§3.4b measured, to the byte.
  takeProvenLethal: false,
  reuse: TREE_REUSE_OFF,
});

/**
 * The pilot with the **tactical solver switched on** — the exact combat evaluation
 * plus the decision router's proven-lethal branch (brief §11–12, §39, §45).
 *
 * ⚠️ **Built, measured, and NOT the default.** It is the more *correct* evaluator
 * by a wide margin (5/5 against 0/5 on the curated ordering suite, with two of the
 * default's five answers actively backwards) and it is **free or slightly cheaper**
 * — and on every strength measurement taken it is a wash:
 *
 * | measurement | default | this |
 * |---|---|---|
 * | Mono-Red vs Boros, n=120, vs heuristic | 60.0% [51.1, 68.3] | 60.0% [51.1, 68.3] |
 * | UW Control vs Golgari, n=80, vs heuristic | 53.8% [42.9, 64.3] | 55.0% [44.1, 65.4] |
 * | head to head, aggro, n=120 | — | 48.3% [39.6, 57.2] |
 * | mean decision, aggro / control | 6.83 / 14.33 ms | 6.70–6.97 / 13.63 ms |
 *
 * The full argument — including the per-term ablation that put every arm on the
 * identical 72/120 — is on {@link TACTICAL_EVALUATION_WEIGHTS}. A test pins that
 * the default keeps it off.
 *
 * It exists as a shipped export rather than a bench-local literal for a second
 * reason too: an A/B on this box is only trustworthy INTERLEAVED IN ONE PROCESS
 * (wall clock drifts ±19% between runs of identical code, and a sequential
 * comparison here has already produced a confident wrong answer). An arm you
 * cannot construct from the library is an arm you cannot interleave.
 */
export const TACTICAL_HYBRID_CONFIG: HybridConfig = Object.freeze({
  ...DEFAULT_HYBRID_CONFIG,
  evaluation: TACTICAL_EVALUATION_WEIGHTS,
  takeProvenLethal: true,
});

/**
 * The same pilot, run CHEAP: tree reuse on, and the simulation budget cut to a
 * fraction of the default because the retained tree supplies the rest.
 *
 * This is the one thing §21–22 measurably bought here, and it is a real thing to
 * have. Head to head against {@link DEFAULT_HYBRID_CONFIG} on the same 120 seeded
 * games, seat and play rotated:
 *
 * | reuse ON budget | win rate vs the 160-simulation default | its share of the default's decision time |
 * |---|---|---|
 * | 64 sims (this config) | 46.7% [38.0%, 55.6%] | 44% |
 * | 96 sims | 48.3% [39.6%, 57.2%] | 74% |
 *
 * Both intervals include 50%: at 40% of the budget the pilot is **not measurably
 * weaker** than the full-budget one, for roughly half the decision time. Read it
 * as "no measurable loss at half the cost", NOT as "stronger" — the point
 * estimates sit just under 50% and the honest claim is the one the interval
 * supports.
 *
 * Still deterministic (a `simulations` budget), so the Lab may use it. It is the
 * beginning of a throughput case for making a search pilot the default, which the
 * hybrid does not yet have on its own.
 */
export const THRIFTY_HYBRID_CONFIG: HybridConfig = Object.freeze({
  ...DEFAULT_HYBRID_CONFIG,
  budget: Object.freeze({ kind: 'simulations', simulations: 64 } as const),
  reuse: TREE_REUSE_ON,
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
