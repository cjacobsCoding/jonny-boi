/**
 * TWO-STAGE FIXED-WIDTH ESTIMATION — play until the interval is tight enough,
 * and not one game longer (DESIGN §3.94).
 *
 * ⚠️ THIS IS A DIFFERENT PROBLEM FROM `sequential.ts`, AND THE DIFFERENCE MATTERS.
 * A group-sequential boundary answers "is A better than B?" — a hypothesis TEST,
 * where peeking inflates the false-positive rate and the fix is a stricter bar per
 * look. A gauntlet asks "what IS this deck's win rate?" — an ESTIMATE, where there
 * is no null to reject and the thing being controlled is the width of the interval.
 * Applying the Pocock boundary here would be answering the wrong question with the
 * right-looking machinery.
 *
 * The design is Stein's two-stage rule, which is the simple, honest version:
 *
 *   1. Play a PILOT stage and estimate the win rate from it.
 *   2. Compute how many games that estimate implies for the requested half-width.
 *   3. Play up to that many — capped by the budget the caller actually asked for.
 *
 * ⚠️ WHY TWO STAGES AND NOT "CHECK AFTER EVERY GAME". A rule that stops the instant
 * the interval looks narrow enough stops preferentially on runs where the sample
 * happened to be lucky, which biases the estimate toward whatever the early games
 * said. One pilot stage, one decision, no peeking — the estimate is then computed
 * from ALL the games, and the only thing the pilot chose was how many to play.
 *
 * ⚠️ AND THE INTERVAL IS STILL REPORTED. This decides how many games to play; it
 * never decides what to claim. A run that hits its budget before reaching the
 * target width reports the WIDER interval it actually earned — never the target.
 */

/** The normal quantile for the two-sided level a proportion CI is built at. */
const Z_FOR_95 = 1.959963984540054;

/**
 * The variance of a proportion is `p(1-p)`, maximised at p = 0.5. A pilot estimate
 * near the extremes therefore implies far fewer games — which is exactly where the
 * saving comes from, and also where a small pilot is least trustworthy. The floor
 * keeps a freak 0% or 100% pilot from concluding that two games were enough.
 */
const MIN_VARIANCE_ESTIMATE = 0.05 * (1 - 0.05);

export interface PrecisionPlan {
  /** Games per matchup the pilot stage plays before deciding. */
  readonly pilotGames: number;
  /** The half-width the caller asked the interval to reach. */
  readonly targetHalfWidth: number;
  /** The budget: never exceeded, whatever the pilot implies. */
  readonly maxGames: number;
}

export interface PrecisionDecision {
  /** Games per matchup to play in total, pilot included. */
  readonly totalGames: number;
  /** True when the budget, not the target, is what limited the run. */
  readonly budgetLimited: boolean;
  /** The pilot's win-rate estimate, for the report. */
  readonly pilotWinRate: number;
}

/**
 * The pilot is a MODEST ABSOLUTE size, not a fraction of the budget.
 *
 * ⚠️ It was a quarter of the budget until a test caught what that means: with a
 * generous budget the pilot alone is enormous (2,500 games of a 10,000 budget),
 * so it dominates the decision and the run can never spend less than a quarter
 * whatever the pilot learns — capping the entire saving at 4x and usually at 1x.
 * The pilot only has to estimate p(1-p) well enough to size the second stage, and
 * the variance floor below covers it being wrong at the extremes.
 */
const MAX_PILOT_GAMES = 40;
const MIN_PILOT_GAMES = 8;

/** Plan the pilot stage: small, bounded, and never larger than the budget. */
export function planPrecision(maxGames: number, targetHalfWidth: number): PrecisionPlan {
  if (!(targetHalfWidth > 0) || targetHalfWidth >= 0.5) {
    throw new Error(`target half-width must be in (0, 0.5); got ${targetHalfWidth}`);
  }
  if (maxGames <= 0) throw new Error('a precision plan needs a positive game budget');
  return {
    pilotGames: Math.max(1, Math.min(maxGames, MAX_PILOT_GAMES, Math.max(MIN_PILOT_GAMES, Math.round(maxGames / 4)))),
    targetHalfWidth,
    maxGames,
  };
}

/**
 * How many games per matchup the pilot implies, capped at the budget.
 *
 * `observedWins / observedGames` is the pilot estimate; `opponentCount` matters
 * because the gauntlet's interval is built over the WHOLE run, so each matchup
 * contributes `n` of the `opponentCount × n` games behind it.
 */
export function decidePrecision(
  plan: PrecisionPlan,
  observedWins: number,
  observedGames: number,
  opponentCount: number,
): PrecisionDecision {
  const pilotWinRate = observedGames > 0 ? observedWins / observedGames : 0.5;
  const variance = Math.max(MIN_VARIANCE_ESTIMATE, pilotWinRate * (1 - pilotWinRate));
  // n for a half-width h at 95%: n = z² · p(1-p) / h², over the whole run.
  const neededTotal = (Z_FOR_95 ** 2 * variance) / plan.targetHalfWidth ** 2;
  const perMatchup = Math.ceil(neededTotal / Math.max(1, opponentCount));
  const totalGames = Math.max(plan.pilotGames, Math.min(plan.maxGames, perMatchup));
  return {
    totalGames,
    budgetLimited: perMatchup > plan.maxGames,
    pilotWinRate,
  };
}
