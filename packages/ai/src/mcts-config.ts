/**
 * Tunable knobs for the `mcts` pilot (DESIGN §1 "data-driven, no magic numbers").
 *
 * Every constant that shapes the search — how many playouts to run, how deep a
 * rollout goes, the UCB1 exploration weight, the terminal/heuristic eval weights,
 * and the wall-clock safety cap — is a *named* field here. A designer can re-tune
 * the AI (trade strength for speed, or vice-versa) from one frozen data object
 * without touching search code. This mirrors `HeuristicWeights`: pure data only.
 *
 * Why these defaults: MCTS is strictly slower than the heuristic (it plays many
 * simulated games per decision). The defaults aim for "clearly stronger than
 * random, competitive with heuristic, still fast enough for a few-hundred-game
 * sanity sim". Bump `simulationsPerDecision` for strength, drop it for speed.
 */

/** The complete, tunable knob set the MCTS pilot reads. Pure data. */
export interface MctsConfig {
  // --- search budget -------------------------------------------------------
  /**
   * How many MCTS iterations (select → expand → rollout → backprop) to run per
   * decision. The dominant strength/speed dial: more sims ⇒ stronger but slower.
   */
  readonly simulationsPerDecision: number;
  /**
   * A wall-clock safety cap (ms) per decision. Even with a generous sim budget a
   * pathological position must never hang the sim, so we stop searching once this
   * elapses and return the best action found so far. Determinism note: the *count*
   * budget is what reproduces choices; the clock is only a backstop that, in
   * practice, never trips before the count budget on normal positions. Set to a
   * value comfortably above a normal decision's cost so it stays inert (and so
   * runs stay reproducible). Use `Infinity` to disable.
   */
  readonly maxDecisionMillis: number;

  // --- rollout -------------------------------------------------------------
  /**
   * Maximum number of *plies* (engine actions) a single rollout plays out before
   * we stop and evaluate the non-terminal position with the heuristic eval. Bounds
   * rollout cost and guarantees termination even if a game would otherwise loop.
   */
  readonly rolloutDepth: number;
  /**
   * Which fast default policy drives rollouts: `'random'` (cheap, high variance) or
   * `'heuristic'` (a little slower per ply, lower variance, usually stronger play).
   * DRY: this reuses the existing `random`/`heuristic` pilots rather than
   * re-implementing a playout policy.
   */
  readonly rolloutPolicy: 'random' | 'heuristic';

  // --- selection -----------------------------------------------------------
  /**
   * The UCB1 exploration constant (the classic `c` in
   * `value + c * sqrt(ln(parentVisits) / childVisits)`). Higher ⇒ explore more;
   * lower ⇒ exploit the current best more. `sqrt(2)` is the textbook default for
   * rewards normalised to [0, 1].
   */
  readonly explorationConstant: number;

  // --- evaluation ----------------------------------------------------------
  /**
   * Reward for a rollout that ends in a win for the deciding player (and the
   * negation for a loss). Rollouts are scored from the deciding player's
   * perspective and the reward is squashed into [0, 1] for UCB1 (see the pilot).
   */
  readonly winReward: number;
  readonly lossReward: number;
  /** Reward for a draw / timeout terminal (neither player has won). */
  readonly drawReward: number;
  /**
   * Per-ply discount that makes the pilot prefer *faster* wins and *slower* losses
   * — decisive play. A terminal reward reached after `plies` rollout steps is pulled
   * toward the draw reward by `winSpeedDiscount * plies` (clamped so it never crosses
   * the draw line): a win in 4 plies scores higher than a win in 40, so the search
   * actually closes out won games instead of dithering (which otherwise stalls games
   * into timeouts and adds sim noise). Set to 0 to score every win/loss equally
   * regardless of speed.
   */
  readonly winSpeedDiscount: number;
  /**
   * When a rollout stops at the depth cap (non-terminal), we evaluate the position
   * with a cheap heuristic: a weighted blend of life differential and board
   * presence, from the deciding player's perspective. These weights scale each
   * term; the blended score is squashed into [0, 1] like the terminal rewards so
   * the two are comparable in backprop.
   */
  readonly evalLifeWeight: number;
  /** Weight per point of (power + toughness) of board presence differential. */
  readonly evalBoardWeight: number;
  /**
   * The half-saturation constant for the logistic squash of the heuristic eval:
   * an advantage of this many "eval points" maps to roughly a 0.73 reward. Keeps
   * the non-terminal eval on the same [0, 1] scale as win/loss without any term
   * dominating. Named so the squash steepness is tunable, not a magic number.
   */
  readonly evalScale: number;
}

/**
 * Default MCTS knobs: clearly stronger than random, competitive with heuristic,
 * and fast enough for a few-hundred-game sim. All values are justified above;
 * the *relative* shape (budget vs depth vs exploration) is the design.
 */
export const DEFAULT_MCTS_CONFIG: MctsConfig = Object.freeze({
  // search budget
  simulationsPerDecision: 160,
  maxDecisionMillis: 1000,

  // rollout
  rolloutDepth: 120,
  rolloutPolicy: 'heuristic',

  // selection — sqrt(2), the canonical UCB1 exploration constant for [0,1] rewards.
  explorationConstant: Math.SQRT2,

  // evaluation
  winReward: 1,
  lossReward: 0,
  drawReward: 0.5,
  // A small per-ply nudge: a win ~10 plies sooner is worth ~0.05 reward, enough to
  // break "both lines win" ties toward the faster kill without distorting strategy.
  winSpeedDiscount: 0.005,
  evalLifeWeight: 1,
  evalBoardWeight: 1,
  evalScale: 12,
});

/**
 * A light, fast config for tests and speed-sensitive sims: fewer sims and a
 * shallower rollout cap so a suite of short games stays quick while the pilot is
 * still clearly better than random. Exported so tests don't hard-code knob values
 * (no magic numbers in tests either).
 */
export const FAST_MCTS_CONFIG: MctsConfig = Object.freeze({
  ...DEFAULT_MCTS_CONFIG,
  simulationsPerDecision: 40,
  rolloutDepth: 60,
});
