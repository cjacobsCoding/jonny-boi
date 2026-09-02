/**
 * GROUP-SEQUENTIAL STOPPING — finish a paired A/B as soon as the answer is in,
 * without inflating the false-positive rate (DESIGN §3.92).
 *
 * ⚠️ WHY THIS IS NOT "STOP AT THE FIRST p < 0.05". Peeking after every game and
 * stopping the moment the test clears is the single most common way to
 * manufacture a significant result out of noise: with enough looks, a fair coin
 * crosses 0.05 eventually. §3.87 measured the prize (an upper bound of 1.99x) and
 * deliberately did not build the naive version; §3.82 and §3.85 are two separate
 * occasions where this repo nearly shipped a finding that was only ever noise.
 *
 * The fix is a POCOCK boundary: fix the number of looks IN ADVANCE, and require
 * every look to clear the same, tighter threshold. The overall false-positive
 * rate over the whole run is then the alpha you asked for — not the alpha times
 * the number of chances you gave yourself.
 *
 * The boundaries below are the standard Pocock constants for a two-sided 0.05
 * test. They are a CLOSED TABLE on purpose: a look count that is not in it is
 * refused rather than approximated, because an interpolated boundary is an
 * unknown error rate wearing a number's clothes.
 */

/** Pocock's constant per-look significance level for a two-sided overall alpha of 0.05. */
const POCOCK_ALPHA_AT_005: Readonly<Record<number, number>> = Object.freeze({
  1: 0.05,
  2: 0.0294,
  3: 0.0221,
  4: 0.0182,
  5: 0.0158,
  6: 0.0142,
  8: 0.0120,
  10: 0.0106,
});

/** The look counts this module will honour. See the table's note on approximation. */
export const SUPPORTED_LOOK_COUNTS: readonly number[] = Object.freeze(
  Object.keys(POCOCK_ALPHA_AT_005)
    .map(Number)
    .sort((a, b) => a - b),
);

/** How many equally-sized looks a run of `games` should take, given a requested count. */
export interface SequentialPlan {
  /** Cumulative game counts at which the test is applied. Last entry is the full run. */
  readonly checkpoints: readonly number[];
  /** The per-look threshold every checkpoint is judged against. */
  readonly perLookAlpha: number;
  /** The overall two-sided error rate this plan controls. */
  readonly overallAlpha: number;
}

/**
 * Plan the looks for a run of `totalGames`.
 *
 * ⚠️ The overall alpha MUST match the one the report will quote. Passing 0.05 here
 * and printing a verdict judged at some other level would be two answers to one
 * question — which is the failure mode this whole module exists to prevent.
 */
export function planSequentialLooks(totalGames: number, looks: number, overallAlpha = 0.05): SequentialPlan {
  if (overallAlpha !== 0.05) {
    throw new Error(
      `group-sequential boundaries are tabulated for a two-sided alpha of 0.05 only; got ${overallAlpha}. ` +
        'Add the constants for the level you want rather than scaling these.',
    );
  }
  const perLookAlpha = POCOCK_ALPHA_AT_005[looks];
  if (perLookAlpha === undefined) {
    throw new Error(
      `no Pocock boundary tabulated for ${looks} looks (have ${SUPPORTED_LOOK_COUNTS.join(', ')}). ` +
        'An interpolated boundary is an unknown error rate — pick a tabulated count.',
    );
  }
  if (totalGames <= 0) throw new Error('a sequential plan needs at least one game');

  // Equally spaced looks, the last exactly at the full budget. Integer boundaries
  // so a checkpoint is always a whole number of games actually played.
  const checkpoints: number[] = [];
  for (let i = 1; i <= looks; i++) {
    const at = Math.round((totalGames * i) / looks);
    // Never repeat or regress a checkpoint on a small run — a duplicated look
    // would spend a look of the error budget on no new information.
    if (at > (checkpoints[checkpoints.length - 1] ?? 0)) checkpoints.push(at);
  }
  return { checkpoints, perLookAlpha, overallAlpha };
}

/** What a completed sequential run did. */
export interface SequentialOutcome {
  /** Games actually played (≤ the requested budget). */
  readonly gamesPlayed: number;
  /** Looks actually taken. */
  readonly looksTaken: number;
  /** True when the run stopped before its full budget because the boundary was crossed. */
  readonly stoppedEarly: boolean;
  /** The threshold each look was judged against — quoted so the verdict is readable. */
  readonly perLookAlpha: number;
}
