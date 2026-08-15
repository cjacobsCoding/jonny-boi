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
   * An OPTIONAL wall-clock cap (ms) per decision, for interactive callers that
   * must bound a decision in real time. `Infinity` (the default) disables it.
   *
   * **A finite value makes the pilot non-deterministic** and must never be used
   * for the sim's statistics. How many simulations a decision gets then depends on
   * how fast the machine happens to be at that moment, so the same seed can pick a
   * different action on a second run — and in the paired A/B swap test the base and
   * variant arms can receive *different* search budgets, which breaks the
   * "identical conditions" premise the whole verdict rests on. (Measured on a real
   * position: decisions reached 2005 ms against a nominal 1000 ms cap, so the cap
   * was tripping routinely rather than staying inert as it was once assumed to.)
   *
   * Termination never needed the clock: `simulationsPerDecision` and
   * `rolloutDepth` are both finite, so a decision is bounded by construction.
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
   * Reward subtracted from a non-terminal evaluation for each time the DECIDING
   * player's mana pool was emptied with mana still floating during the
   * simulation — mana that was tapped and then never spent.
   *
   * Why the search needs to be told: mana pools empty at the end of every step,
   * so floating mana is simply lost, and nothing else in the evaluation can see
   * it (life and board presence are both unchanged by wasting a mana). That
   * blind spot is not theoretical. Measured on the sample gauntlet, the pilot
   * tapped and wasted mana on 0.80 of every turn against the heuristic's 0.00,
   * and the trace showed exactly one shape: tap a land during an opponent's
   * step, then pass. The tree valued "tap" through rollouts in which the
   * *heuristic* policy went on to spend the mana, while the real next mover —
   * another MCTS search, which by then treats the tapped mana as sunk — declined
   * to. Charging the waste to the deciding player closes that gap from both
   * ends: tapping speculatively costs something, and so does passing on mana
   * already floating.
   *
   * Terminal rollouts are deliberately NOT charged: once the game is decided,
   * how tidily it was played is irrelevant, and discounting a win would teach
   * the search to avoid winning lines.
   *
   * **It defaults to 0 — OFF — and that is a measured decision, not an
   * oversight.** The mechanism does what it was built to do: at 0.1 the waste
   * rate over eight seeded games falls from 0.709/turn to 0.217/turn, under the
   * 0.35 budget the sim's play-quality guard puts on a default pilot. But it
   * costs games. Head-to-head against the heuristic over the same 120 seeded
   * games (Mono-Red Aggro vs Boros Aggro, seat and play both rotated):
   *
   *     penalty 0    (waste-blind)  49/120 = 40.8%  95% CI [32.5%, 49.8%]
   *     penalty 0.1  (waste-aware)  35/120 = 29.2%  95% CI [21.8%, 37.9%]
   *
   * An 11.6-point drop, p ~= 0.06 — short of significant on its own, but pointing
   * the wrong way, and turning it on cannot be justified by "it looks tidier".
   * The likely mechanism is that the penalty prices the RISK of floating mana,
   * not just the waste: a line that taps toward a spell is charged whenever the
   * search later declines to cast, so the pilot buys mana discipline by simply
   * doing less. Fixing that properly means making the tap and the cast atomic in
   * the search's action space (fund a chosen spell through `planManaPayment`, the
   * way the heuristic does) rather than pricing the symptom.
   *
   * Kept, tunable and tested, because the diagnosis is worth keeping: anyone
   * demonstrating the pilot's mana behaviour, or trying that atomic-cast redesign,
   * wants this knob and the measurement above.
   */
  readonly evalWastedManaPenalty: number;
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
  // Reproducibility beats real-time bounding for the lab's default: the count
  // budget already bounds a decision, so no clock enters the decision path.
  maxDecisionMillis: Infinity,

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
  // OFF by default — see the field's doc. The mechanism works (0.71 -> 0.22
  // wasted mana per turn at 0.1, where the sweep flattens) but measured 11.6
  // points WORSE head-to-head over 120 seeded games, so it does not ship on.
  evalWastedManaPenalty: 0,
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
