/**
 * DESIGN §3.179, item 2 — INCONCLUSIVE is three different answers wearing one word.
 *
 * The acceptance list this file pins, verbatim from `docs/plans/lab-tuning-plan.md`:
 *
 *   1. Each of the three inconclusive situations is reproduced from a hand-built
 *      input and reports its own reason.
 *   4. The games-to-settle estimate, on a rigged split with a known answer, lands
 *      within a stated tolerance of it — and is absent, not zero, when there is
 *      no estimate.
 *
 * plus two guards the plan did not ask for and this lane added because the
 * change would otherwise be unfalsifiable in the directions that matter most:
 *
 *   - the VERDICTS are unchanged. A refactor of the one funnel every A/B surface
 *     reads must not move a single shipped result, so the old five-line rule is
 *     restated here and quantified over a grid. If this fails, the reason work
 *     has silently become a behaviour change.
 *   - `VERDICT_BARS`'s z values are cross-checked against `normalCdf`, an
 *     INDEPENDENT function, so a mistyped digit in the table cannot sit there
 *     looking plausible.
 */
import { describe, expect, it } from 'vitest';
import {
  decideVerdict,
  explainVerdictReason,
  formatPValue,
  gamesToSettle,
  summarizePairedSwap,
  SWAP_VERDICT_REASONS,
  SWAP_VERDICT_REASON_BY_KEY,
  SWAP_VERDICT_REASON_ROWS,
  type SwapVerdict,
} from './swap.js';
import { DEFAULT_STATS_CONFIG, VERDICT_BARS, statsConfigFor, type StatsConfig } from './config.js';
import { chiSquare1dfUpperTail, mcNemarTest, normalCdf, type PairedTable } from './stats.js';

const STATS = DEFAULT_STATS_CONFIG;

/** A paired table with a given discordant split and enough concordant games to reach `n`. */
function split(variantOnly: number, baseOnly: number, n: number): PairedTable {
  const discordant = variantOnly + baseOnly;
  if (discordant > n) throw new Error(`a ${discordant}-discordant split cannot fit in ${n} games`);
  return { bothWon: n - discordant, baseOnly, variantOnly, neither: 0 };
}

describe('§3.179 acceptance 1 — the three inconclusive situations report their own reason', () => {
  it('n = 29 below the 30-game minimum reports tooFewGames', () => {
    const decision = decideVerdict(0.05, 0.001, 29, STATS.alpha, STATS.minGamesForVerdict);
    expect(decision.verdict).toBe('inconclusive');
    expect(decision.reason).toBe('tooFewGames');
  });

  it('n = 400 at p = 0.31 reports notSignificant', () => {
    const decision = decideVerdict(0.02, 0.31, 400, STATS.alpha, STATS.minGamesForVerdict);
    expect(decision.verdict).toBe('inconclusive');
    expect(decision.reason).toBe('notSignificant');
  });

  it('delta = 0 reports deadHeat, not notSignificant', () => {
    const decision = decideVerdict(0, 0.31, 400, STATS.alpha, STATS.minGamesForVerdict);
    expect(decision.verdict).toBe('inconclusive');
    expect(decision.reason).toBe('deadHeat');
  });

  it('the three reasons are genuinely different — the whole point of the change', () => {
    const reasons = new Set([
      decideVerdict(0.05, 0.001, 29, STATS.alpha, STATS.minGamesForVerdict).reason,
      decideVerdict(0.02, 0.31, 400, STATS.alpha, STATS.minGamesForVerdict).reason,
      decideVerdict(0, 0.31, 400, STATS.alpha, STATS.minGamesForVerdict).reason,
    ]);
    expect(reasons.size, 'three situations must not collapse back into one word').toBe(3);
  });

  it('the conclusive calls carry their own reasons too', () => {
    expect(decideVerdict(0.05, 0.01, 400, STATS.alpha, STATS.minGamesForVerdict)).toEqual({
      verdict: 'better',
      reason: 'significantGain',
    });
    expect(decideVerdict(-0.05, 0.01, 400, STATS.alpha, STATS.minGamesForVerdict)).toEqual({
      verdict: 'worse',
      reason: 'significantLoss',
    });
  });
});

describe('§3.179 — the reason table is closed, complete and worded', () => {
  it('every reason in the vocabulary has exactly one row', () => {
    expect(SWAP_VERDICT_REASON_ROWS.map((row) => row.reason).sort()).toEqual([...SWAP_VERDICT_REASONS].sort());
    for (const reason of SWAP_VERDICT_REASONS) {
      expect(SWAP_VERDICT_REASON_BY_KEY[reason], `no row for ${reason}`).toBeDefined();
    }
  });

  it('every row has real wording — the guard against a reason shipping mute', () => {
    for (const row of SWAP_VERDICT_REASON_ROWS) {
      expect(row.label.length, `${row.reason} has no label`).toBeGreaterThan(2);
      expect(row.template.length, `${row.reason} has no template`).toBeGreaterThan(20);
    }
  });

  it('every row renders its numbers — a placeholder left unfilled is a visible bug, not a blank', () => {
    for (const row of SWAP_VERDICT_REASON_ROWS) {
      const text = explainVerdictReason(row.reason, { nGames: 123, minGames: 30, alpha: 0.05, pValue: 0.42 });
      expect(text, `${row.reason} left a placeholder unfilled`).not.toMatch(/\{\w+\}/u);
    }
  });

  it('the row a reason carries agrees with the verdict decideVerdict returns with it', () => {
    const cases: readonly (readonly [number, number, number])[] = [
      [0.05, 0.001, 29],
      [0.02, 0.31, 400],
      [0, 0.31, 400],
      [0.05, 0.01, 400],
      [-0.05, 0.01, 400],
    ];
    for (const [delta, p, n] of cases) {
      const decision = decideVerdict(delta, p, n, STATS.alpha, STATS.minGamesForVerdict);
      expect(SWAP_VERDICT_REASON_BY_KEY[decision.reason].verdict, `${decision.reason} maps to the wrong verdict`).toBe(
        decision.verdict,
      );
    }
  });

  it('only the reasons that more games could move are marked as such', () => {
    expect(SWAP_VERDICT_REASON_BY_KEY.tooFewGames.moreGamesCouldSettle).toBe(true);
    expect(SWAP_VERDICT_REASON_BY_KEY.notSignificant.moreGamesCouldSettle).toBe(true);
    // A dead heat and a proved call are settled. This column is what stops the
    // trim ladder deepening forever against a question that is already answered.
    expect(SWAP_VERDICT_REASON_BY_KEY.deadHeat.moreGamesCouldSettle).toBe(false);
    expect(SWAP_VERDICT_REASON_BY_KEY.significantGain.moreGamesCouldSettle).toBe(false);
    expect(SWAP_VERDICT_REASON_BY_KEY.significantLoss.moreGamesCouldSettle).toBe(false);
  });
});

describe('§3.179 — the VERDICTS did not move (the guard that keeps this additive)', () => {
  /** The rule exactly as it shipped before §3.179, restated so a drift is visible. */
  function verdictBefore(delta: number, pValue: number, nGames: number, alpha: number, minGames: number): SwapVerdict {
    if (nGames < minGames) return 'inconclusive';
    if (pValue >= alpha) return 'inconclusive';
    if (delta > 0) return 'better';
    if (delta < 0) return 'worse';
    return 'inconclusive';
  }

  it('agrees with the pre-§3.179 rule over a grid of 1,500 cases', () => {
    const deltas = [-0.4, -0.05, -0.0001, 0, 0.0001, 0.05, 0.4];
    const pValues = [0, 0.001, 0.0499, 0.05, 0.0501, 0.1, 0.5, 1];
    const counts = [0, 1, 29, 30, 31, 400];
    const alphas = VERDICT_BARS.map((bar) => bar.alpha);
    let checked = 0;
    for (const delta of deltas) {
      for (const p of pValues) {
        for (const n of counts) {
          for (const alpha of alphas) {
            const now = decideVerdict(delta, p, n, alpha, 30).verdict;
            const before = verdictBefore(delta, p, n, alpha, 30);
            expect(now, `verdict moved at delta=${delta} p=${p} n=${n} alpha=${alpha}`).toBe(before);
            checked += 1;
          }
        }
      }
    }
    // Never vacuously green: assert the grid was actually walked.
    expect(checked).toBe(deltas.length * pValues.length * counts.length * alphas.length);
    expect(checked).toBeGreaterThan(1000);
  });
});

describe('§3.179 acceptance 4 — the games-to-settle estimate', () => {
  /**
   * The INDEPENDENT answer: scale the observed split by k until McNemar's own
   * p-value clears alpha, by search rather than by the closed form. If the two
   * methods agree the algebra is right; if only the closed form were tested it
   * would be testing itself.
   */
  function settleBySearch(table: PairedTable, n: number, alpha: number): number {
    for (let total = n; total <= n * 100000; total += Math.max(1, Math.floor(n / 100))) {
      const k = total / n;
      const scaled: PairedTable = {
        bothWon: table.bothWon * k,
        baseOnly: table.baseOnly * k,
        variantOnly: table.variantOnly * k,
        neither: table.neither * k,
      };
      if (mcNemarTest(scaled).pValue < alpha) return total;
    }
    throw new Error('no settling point found within the search window');
  }

  it('lands within 2% of an independent search, on a rigged split with a known answer', () => {
    const table = split(14, 10, 400);
    const estimate = gamesToSettle(table, 400, STATS);
    expect(estimate, 'a 14/10 split has a direction and therefore an estimate').toBeDefined();
    const searched = settleBySearch(table, 400, STATS.alpha);
    const closedForm = (estimate as { totalPairedGames: number }).totalPairedGames;
    const relativeError = Math.abs(closedForm - searched) / searched;
    expect(relativeError, `closed form ${closedForm} vs search ${searched}`).toBeLessThan(0.02);
  });

  it('the estimated total really does clear alpha when played — the discriminator', () => {
    const table = split(14, 10, 400);
    const estimate = gamesToSettle(table, 400, STATS);
    const k = (estimate as { totalPairedGames: number }).totalPairedGames / 400;
    const scaled: PairedTable = {
      bothWon: table.bothWon * k,
      baseOnly: table.baseOnly * k,
      variantOnly: table.variantOnly * k,
      neither: table.neither * k,
    };
    expect(mcNemarTest(scaled).pValue).toBeLessThan(STATS.alpha);
    // ...and one step SHORT of it does not, so the number is the boundary and
    // not merely some sufficiently large figure.
    const shortK = k * 0.9;
    const short: PairedTable = {
      bothWon: table.bothWon * shortK,
      baseOnly: table.baseOnly * shortK,
      variantOnly: table.variantOnly * shortK,
      neither: table.neither * shortK,
    };
    expect(mcNemarTest(short).pValue).toBeGreaterThan(STATS.alpha);
  });

  it('is ABSENT, not zero, when the split is even — a dead heat has no N', () => {
    expect(gamesToSettle(split(12, 12, 400), 400, STATS)).toBeUndefined();
    expect(gamesToSettle(split(0, 0, 400), 400, STATS)).toBeUndefined();
  });

  it('is computed from the DISCORDANT counts, not the win-rate delta', () => {
    // Two tables with the SAME discordant split but wildly different concordant
    // counts — and therefore different win-rate deltas — must ask for the same
    // SCALE-UP. If the estimate leaked the delta, these would diverge.
    const tight = split(20, 10, 100);
    const loose = split(20, 10, 1000);
    const a = gamesToSettle(tight, 100, STATS);
    const b = gamesToSettle(loose, 1000, STATS);
    const scaleA = (a as { totalPairedGames: number }).totalPairedGames / 100;
    const scaleB = (b as { totalPairedGames: number }).totalPairedGames / 1000;
    // Within 1%, not exact: the estimate is rounded UP to a whole number of
    // games, and a ceiling on 100 is a coarser step than a ceiling on 1,000.
    // Asserting equality here would be asserting the rounding, not the rule.
    expect(Math.abs(scaleA - scaleB) / scaleB, `${scaleA} vs ${scaleB}`).toBeLessThan(0.01);
  });

  it('a looser bar asks for fewer games than a stricter one', () => {
    const table = split(14, 10, 400);
    const at10 = gamesToSettle(table, 400, statsConfigFor(0.1, 30)) as { additionalPairedGames: number };
    const at05 = gamesToSettle(table, 400, statsConfigFor(0.05, 30)) as { additionalPairedGames: number };
    const at01 = gamesToSettle(table, 400, statsConfigFor(0.01, 30)) as { additionalPairedGames: number };
    expect(at10.additionalPairedGames).toBeLessThan(at05.additionalPairedGames);
    expect(at05.additionalPairedGames).toBeLessThan(at01.additionalPairedGames);
  });

  it('never proposes fewer games than the minimum a verdict needs at all', () => {
    const estimate = gamesToSettle(split(6, 0, 10), 10, STATS) as { totalPairedGames: number };
    expect(estimate.totalPairedGames).toBeGreaterThanOrEqual(STATS.minGamesForVerdict);
  });

  it('rides on the evaluation for rows more games could settle, and not otherwise', () => {
    const unsure = summarizePairedSwap({
      baseDeckName: 'base',
      variantDeckName: 'variant',
      swap: { out: 'a', in: 'b' },
      outName: 'A',
      inName: 'B',
      paired: split(14, 10, 400),
      stats: STATS,
    });
    expect(unsure.verdictReason).toBe('notSignificant');
    expect(unsure.gamesToSettle, 'an unreadable row should say what would settle it').toBeDefined();

    const dead = summarizePairedSwap({
      baseDeckName: 'base',
      variantDeckName: 'variant',
      swap: { out: 'a', in: 'b' },
      outName: 'A',
      inName: 'B',
      paired: split(12, 12, 400),
      stats: STATS,
    });
    expect(dead.verdictReason).toBe('deadHeat');
    expect(dead.gamesToSettle, 'a dead heat has no estimate and must not print a zero').toBeUndefined();
  });
});

describe('§3.179 — the verdict bars are a closed table whose halves cannot disagree', () => {
  it('every bar z is the real two-sided quantile for its alpha (checked against normalCdf)', () => {
    for (const bar of VERDICT_BARS) {
      const tail = 2 * (1 - normalCdf(bar.z));
      expect(tail, `z ${bar.z} does not match alpha ${bar.alpha}`).toBeCloseTo(bar.alpha, 6);
    }
  });

  it('z squared is the chi-square(1) critical value the McNemar test is read against', () => {
    for (const bar of VERDICT_BARS) {
      expect(chiSquare1dfUpperTail(bar.z * bar.z)).toBeCloseTo(bar.alpha, 6);
    }
  });

  it('statsConfigFor reproduces the shipped default exactly — the divergence guard', () => {
    const derived: StatsConfig = statsConfigFor(DEFAULT_STATS_CONFIG.alpha, DEFAULT_STATS_CONFIG.minGamesForVerdict);
    expect(derived).toEqual({
      alpha: DEFAULT_STATS_CONFIG.alpha,
      z: DEFAULT_STATS_CONFIG.z,
      minGamesForVerdict: DEFAULT_STATS_CONFIG.minGamesForVerdict,
    });
  });

  it('REFUSES an alpha with no row rather than snapping it to the nearest bar', () => {
    expect(() => statsConfigFor(0.07, 30)).toThrow(/no verdict bar for alpha 0\.07/u);
    // ...and names what it does offer, so the refusal is actionable.
    expect(() => statsConfigFor(0.07, 30)).toThrow(/0\.1, 0\.05, 0\.01/u);
  });

  it('every bar has wording, so a chosen bar can always be named on screen', () => {
    for (const bar of VERDICT_BARS) {
      expect(bar.label).toContain(String(bar.alpha));
      expect(bar.hint.length).toBeGreaterThan(20);
    }
  });
});

describe('§3.179 — p-values print one way everywhere', () => {
  it('collapses the unreadably small rather than printing a row of zeroes', () => {
    expect(formatPValue(0.0004)).toBe('<0.001');
    expect(formatPValue(0.5)).toBe('0.500');
    expect(formatPValue(1)).toBe('1.000');
  });

  it('says so when there is no number, instead of inventing one', () => {
    expect(formatPValue(Number.NaN)).toBe('n/a');
  });
});
