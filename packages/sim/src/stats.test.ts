import { describe, expect, it } from 'vitest';
import {
  wilsonInterval,
  wilsonUpperBound,
  mcNemarTest,
  chiSquare1dfUpperTail,
  normalCdf,
  adjustPValues,
  type PairedTable,
} from './stats.js';

// The 95% two-sided z multiplier (0.975 normal quantile) — same value the config
// pins. Tests assert against textbook numbers computed at this z.
const Z_95 = 1.959963984540054;

describe('normalCdf', () => {
  it('matches known standard-normal CDF values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.959963984540054)).toBeCloseTo(0.025, 4);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 4);
  });
});

describe('wilsonInterval', () => {
  it('matches the textbook 95% interval for 60/100', () => {
    // Wilson 95% CI for 0.6 over n=100 is ≈ [0.5020, 0.6906] (standard reference).
    const ci = wilsonInterval(60, 100, Z_95);
    expect(ci.p).toBeCloseTo(0.6, 10);
    expect(ci.low).toBeCloseTo(0.5018, 3);
    expect(ci.high).toBeCloseTo(0.6906, 3);
  });

  it('matches the textbook 95% interval for 50/100', () => {
    // Symmetric-ish around 0.5: Wilson 95% CI ≈ [0.4038, 0.5962].
    const ci = wilsonInterval(50, 100, Z_95);
    expect(ci.low).toBeCloseTo(0.4038, 3);
    expect(ci.high).toBeCloseTo(0.5962, 3);
  });

  it('stays inside [0,1] at the boundary (10/10)', () => {
    const ci = wilsonInterval(10, 10, Z_95);
    expect(ci.p).toBe(1);
    expect(ci.high).toBeLessThanOrEqual(1);
    // Wilson lower bound for 10/10 ≈ 0.7225 — does not collapse to 1.
    expect(ci.low).toBeCloseTo(0.7225, 3);
  });

  it('returns maximal uncertainty for n=0 (no divide-by-zero)', () => {
    const ci = wilsonInterval(0, 0, Z_95);
    expect(ci.low).toBe(0);
    expect(ci.high).toBe(1);
  });
});

describe('chiSquare1dfUpperTail', () => {
  it('matches known chi-square(1) tail probabilities', () => {
    // χ² = 3.841 is the 95th percentile for 1 df → upper tail ≈ 0.05.
    expect(chiSquare1dfUpperTail(3.841459)).toBeCloseTo(0.05, 3);
    // χ² = 6.635 is the 99th percentile → upper tail ≈ 0.01.
    expect(chiSquare1dfUpperTail(6.634897)).toBeCloseTo(0.01, 3);
    expect(chiSquare1dfUpperTail(0)).toBe(1);
  });
});

describe('mcNemarTest', () => {
  it('computes the continuity-corrected statistic on a constructed table', () => {
    // Discordant b=variantOnly=20, c=baseOnly=10.
    // χ² = (|20-10|-1)² / 30 = 81/30 = 2.7.
    const table: PairedTable = { bothWon: 40, variantOnly: 20, baseOnly: 10, neither: 30 };
    const r = mcNemarTest(table);
    expect(r.discordant).toBe(30);
    expect(r.statistic).toBeCloseTo(2.7, 10);
    // p = upper tail of χ²(1) at 2.7 ≈ 0.1003.
    expect(r.pValue).toBeCloseTo(0.1003, 3);
  });

  it('flags a strongly lopsided table as significant', () => {
    // b=30, c=2 → χ² = (|30-2|-1)²/32 = 729/32 ≈ 22.78 → p ≪ 0.01.
    const table: PairedTable = { bothWon: 10, variantOnly: 30, baseOnly: 2, neither: 10 };
    const r = mcNemarTest(table);
    expect(r.statistic).toBeCloseTo(22.78, 1);
    expect(r.pValue).toBeLessThan(0.01);
  });

  it('returns p=1 when there are no discordant pairs (swap changed nothing)', () => {
    const table: PairedTable = { bothWon: 50, variantOnly: 0, baseOnly: 0, neither: 50 };
    const r = mcNemarTest(table);
    expect(r.discordant).toBe(0);
    expect(r.pValue).toBe(1);
    expect(r.statistic).toBe(0);
  });

  it('is symmetric in the discordant counts', () => {
    const a = mcNemarTest({ bothWon: 0, variantOnly: 18, baseOnly: 7, neither: 0 });
    const b = mcNemarTest({ bothWon: 0, variantOnly: 7, baseOnly: 18, neither: 0 });
    expect(a.statistic).toBeCloseTo(b.statistic, 10);
    expect(a.pValue).toBeCloseTo(b.pValue, 10);
  });
});

/**
 * The suggestion engine tests ~139 candidates at once. At alpha 0.05 that yields
 * about seven "significant" results by chance even when every candidate is
 * worthless, so a suggestion list built on raw p-values is a list of the luckiest
 * coin flips. These are the corrections that stop that.
 */
describe('adjustPValues (multiple comparisons)', () => {
  it('Holm matches the textbook step-down computation', () => {
    // Sorted p = [0.01, 0.02, 0.03, 0.04, 0.05], m = 5.
    // Multipliers 5,4,3,2,1 → 0.05, 0.08, 0.09, 0.08→0.09 (monotone), 0.05→0.09.
    const adjusted = adjustPValues([0.01, 0.02, 0.03, 0.04, 0.05], 'holm');
    expect(adjusted[0]).toBeCloseTo(0.05, 10);
    expect(adjusted[1]).toBeCloseTo(0.08, 10);
    expect(adjusted[2]).toBeCloseTo(0.09, 10);
    expect(adjusted[3]).toBeCloseTo(0.09, 10);
    expect(adjusted[4]).toBeCloseTo(0.09, 10);
  });

  it('Holm is never smaller than the raw p and never exceeds 1', () => {
    const raw = [0.0001, 0.2, 0.4, 0.9, 1];
    const adjusted = adjustPValues(raw, 'holm');
    adjusted.forEach((p, i) => {
      expect(p).toBeGreaterThanOrEqual(raw[i] as number);
      expect(p).toBeLessThanOrEqual(1);
    });
  });

  it('Benjamini-Hochberg matches the textbook step-up computation', () => {
    // m = 4, sorted [0.01, 0.02, 0.03, 0.04] → m/k × p = 0.04, 0.04, 0.04, 0.04.
    const adjusted = adjustPValues([0.01, 0.02, 0.03, 0.04], 'benjaminiHochberg');
    for (const p of adjusted) expect(p).toBeCloseTo(0.04, 10);
  });

  it('BH is less conservative than Holm (FDR vs family-wise control)', () => {
    const raw = [0.001, 0.008, 0.02, 0.04, 0.3, 0.7];
    const holm = adjustPValues(raw, 'holm');
    const bh = adjustPValues(raw, 'benjaminiHochberg');
    raw.forEach((_, i) => expect(bh[i] as number).toBeLessThanOrEqual(holm[i] as number));
  });

  it('returns results in the CALLER\'s order, not sorted order', () => {
    const adjusted = adjustPValues([0.5, 0.001, 0.2], 'holm');
    // The smallest raw p (index 1) must still carry the smallest adjusted p.
    expect(adjusted[1] as number).toBeLessThan(adjusted[2] as number);
    expect(adjusted[2] as number).toBeLessThanOrEqual(adjusted[0] as number);
  });

  it('a larger family makes the same evidence less significant', () => {
    // The point of the correction, and why the family must include candidates
    // previous runs tested: otherwise re-running until something looks good works.
    const alone = adjustPValues([0.01], 'holm')[0] as number;
    const inACrowd = adjustPValues([0.01, ...new Array(139).fill(1)], 'holm')[0] as number;
    expect(alone).toBeCloseTo(0.01, 10);
    expect(inACrowd).toBeGreaterThan(alone);
    expect(inACrowd).toBeCloseTo(1, 10);
  });

  it("'none' passes p-values through unchanged", () => {
    expect(adjustPValues([0.01, 0.5], 'none')).toEqual([0.01, 0.5]);
  });

  it('handles the empty family', () => {
    expect(adjustPValues([], 'holm')).toEqual([]);
  });
});

describe('wilsonUpperBound (the futility rule\'s optimistic reading)', () => {
  it('is the Wilson interval\'s upper end', () => {
    expect(wilsonUpperBound(3, 20, Z_95)).toBe(wilsonInterval(3, 20, Z_95).high);
  });

  it('falls below even for an arm losing badly, and stays above it for a close one', () => {
    // 3 of 20 discordant games is hopeless; 9 of 20 is merely behind.
    expect(wilsonUpperBound(3, 20, Z_95)).toBeLessThan(0.5);
    expect(wilsonUpperBound(9, 20, Z_95)).toBeGreaterThan(0.5);
  });
});
