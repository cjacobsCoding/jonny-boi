/**
 * The statistics behind the lab's promise — pure, dependency-free functions
 * tested against textbook values. Two things matter most:
 *
 *   1. A **Wilson score confidence interval** for a win proportion. Unlike the
 *      naive normal ("Wald") interval, Wilson behaves well near 0 and 1 and at
 *      small n — exactly the regime a gauntlet lives in — and never escapes
 *      [0, 1]. This is what turns "55 of 100" into "55% (47–63%)".
 *
 *   2. **McNemar's test** on the *paired* per-game outcomes of base vs variant
 *      (DESIGN §3.5). Because the A/B swap test reuses identical seeds per game
 *      (common random numbers), each game yields a paired (baseWon, variantWon)
 *      outcome. McNemar looks only at the games where they DIFFER — the
 *      discordant pairs — which is precisely the variance-reduction that makes a
 *      single-card swap detectable in far fewer games than two independent runs.
 *
 * No magic numbers: confidence (z) and significance (alpha) come from config.
 */

/** A proportion with a two-sided confidence interval, all in [0, 1]. */
export interface ProportionCI {
  /** Point estimate: successes / n (0 when n = 0). */
  readonly p: number;
  /** Lower bound of the interval. */
  readonly low: number;
  /** Upper bound of the interval. */
  readonly high: number;
  /** Successes observed. */
  readonly successes: number;
  /** Trials observed. */
  readonly n: number;
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * For `successes` out of `n` with critical value `z`, the interval is
 *   (p̂ + z²/2n ± z·√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n),  p̂ = successes/n.
 *
 * With n = 0 we return a degenerate [0, 1] (maximal uncertainty) rather than
 * dividing by zero — robust by default.
 */
export function wilsonInterval(successes: number, n: number, z: number): ProportionCI {
  if (n <= 0) {
    return { p: 0, low: 0, high: 1, successes, n: 0 };
  }
  const pHat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = pHat + z2 / (2 * n);
  const margin = z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n));
  const low = (center - margin) / denom;
  const high = (center + margin) / denom;
  return {
    p: pHat,
    low: clamp01(low),
    high: clamp01(high),
    successes,
    n,
  };
}

/** The 2x2 paired outcome table for base vs variant over the same seeds. */
export interface PairedTable {
  /** Games where BOTH base and variant won (concordant — McNemar ignores). */
  readonly bothWon: number;
  /** Games base won but variant lost (discordant, favours base). */
  readonly baseOnly: number;
  /** Games variant won but base lost (discordant, favours variant). */
  readonly variantOnly: number;
  /** Games where BOTH lost (concordant — McNemar ignores). */
  readonly neither: number;
}

/** The result of McNemar's paired test on the discordant pairs. */
export interface McNemarResult {
  /** The McNemar chi-square statistic (continuity-corrected). */
  readonly statistic: number;
  /** Two-sided p-value (chi-square, 1 df). */
  readonly pValue: number;
  /** Discordant pairs favouring the variant (b in the usual notation). */
  readonly variantOnly: number;
  /** Discordant pairs favouring the base (c). */
  readonly baseOnly: number;
  /** Total discordant pairs (b + c) — the only games the test "sees". */
  readonly discordant: number;
}

/**
 * McNemar's test with Edwards' continuity correction:
 *   χ² = (|b − c| − 1)² / (b + c),   b, c = the two discordant counts.
 * The p-value is the upper tail of a chi-square with 1 degree of freedom, which
 * for 1 df equals 2·(1 − Φ(√χ²)) — the two-sided normal tail. With no discordant
 * pairs the swap changed no outcomes, so p = 1 (perfectly inconclusive).
 */
export function mcNemarTest(table: PairedTable): McNemarResult {
  const b = table.variantOnly;
  const c = table.baseOnly;
  const discordant = b + c;
  if (discordant === 0) {
    return { statistic: 0, pValue: 1, variantOnly: b, baseOnly: c, discordant: 0 };
  }
  const corrected = Math.max(0, Math.abs(b - c) - 1);
  const statistic = (corrected * corrected) / discordant;
  const pValue = chiSquare1dfUpperTail(statistic);
  return { statistic, pValue, variantOnly: b, baseOnly: c, discordant };
}

/**
 * Upper-tail probability of a chi-square(1) variate: P(X ≥ x). For 1 df this is
 * 2·(1 − Φ(√x)) where Φ is the standard normal CDF — exact and cheap, no special
 * functions needed.
 */
export function chiSquare1dfUpperTail(x: number): number {
  if (x <= 0) return 1;
  return 2 * (1 - normalCdf(Math.sqrt(x)));
}

/**
 * Standard normal CDF Φ(x) via the Abramowitz & Stegun 7.1.26 erf approximation
 * (max abs error ≈ 1.5e-7) — accurate to the precision the verdict needs without
 * pulling in a stats dependency.
 */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  // A&S 7.1.26 coefficients.
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
