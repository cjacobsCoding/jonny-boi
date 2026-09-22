/**
 * WHAT FOLLOWS A ROUND (§3.174) — the closed table the panel acts on, walked
 * branch by branch against fabricated round reports.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRIM_BUDGET,
  TRIM_DEEPEN,
  deeperGamesPerCandidate,
  type TrimRoundReport,
  type TrimRow,
  type TrimSpend,
  trimCoverage,
} from '@jonny-boi/sim';

/**
 * A plausible distinct-card count for a 63-card deck, so a fake round's
 * coverage line reads like a real one. It is a FIXTURE, not a claim about any
 * particular deck -- and the line itself is built by the sim's own
 * `trimCoverage`, so a test can never assert a sentence the panel does not
 * actually print.
 */
const DISTINCT_CARDS = 35;
import { FIRST_ROUND_KIND, stepAfterApply, stepAfterRound, targetProblem } from './trimSession.js';

/** Nothing spent yet — the budget is nowhere near biting. */
const FRESH: TrimSpend = { games: 0, seconds: 0, rounds: 1 };
/** The depth the session started at. */
const DEPTH = 20;

function row(label: string, verdict: 'better' | 'inconclusive' | 'worse', delta: number): TrimRow {
  return {
    rank: 1,
    key: `${label}>(nothing)`,
    cuts: [{ cardId: label, name: label, isLand: false }],
    label,
    sizeAfter: 62,
    evaluation: {
      verdict,
      delta,
      // §3.179 — a row carries WHY; 'unsure' rounds are the ones that deepen.
      verdictReason: verdict === 'better' ? 'significantGain' : verdict === 'worse' ? 'significantLoss' : 'notSignificant',
    } as TrimRow['evaluation'],
    gamesPlayed: 40,
    rawPValue: 0.01,
    adjustedPValue: 0.02,
    priorReasons: [],
  };
}

function report(overrides: Partial<TrimRoundReport>): TrimRoundReport {
  return {
    deckName: 'X',
    deckFingerprint: 'fp',
    deckSize: 63,
    targetSize: 60,
    round: 0,
    roundKind: 'singles',
    cardsPerCut: 1,
    coverage: trimCoverage('singles', 1, DISTINCT_CARDS),
    reading: {} as TrimRoundReport['reading'],
    verdict: 'exhausted',
    rows: [],
    baseWinRate: { p: 0.5, low: 0.4, high: 0.6, successes: 20, n: 40 },
    candidatesEvaluated: 0,
    skipped: [],
    waves: [],
    multipleComparisons: { method: 'holm', familySize: 0, testedThisRun: 0, demotedByCorrection: 0 },
    notes: {} as TrimRoundReport['notes'],
    pairingNote: '',
    ...overrides,
  };
}

const winner = row('Swamp', 'better', 0.08);
const edge = row('Craw Wurm', 'inconclusive', 0.02);

describe('stepAfterRound', () => {
  it('an improving round is applied under auto and offered under ask', () => {
    const improved = report({ verdict: 'improved', winner, rows: [winner] });
    expect(stepAfterRound(improved, { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'pause' }, FRESH, DEPTH)).toEqual({ kind: 'apply', row: winner });
    expect(stepAfterRound(improved, { targetSize: 60, onImprovement: 'ask', onNoImprovement: 'pause' }, FRESH, DEPTH)).toEqual({ kind: 'ask', row: winner });
  });

  it('a fruitless round pauses with the edge candidate, or widens to pairs when told to keep looking', () => {
    const fruitless = report({ verdict: 'exhausted', edgeCandidate: edge, rows: [edge] });
    expect(stepAfterRound(fruitless, { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'pause' }, FRESH, DEPTH)).toEqual({
      kind: 'stopped',
      reason: 'paused',
      edge,
    });
    expect(stepAfterRound(fruitless, { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking' }, FRESH, DEPTH)).toEqual({
      kind: 'widen',
      round: 1,
      roundKind: 'pairs',
    });
  });

  it('§3.179 — a CONCLUSIVE pairs round is the end of the search', () => {
    const keep = { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking' } as const;
    expect(
      stepAfterRound(report({ verdict: 'exhausted', roundKind: 'pairs', round: 1, edgeCandidate: edge }), keep, FRESH, DEPTH),
    ).toEqual({ kind: 'stopped', reason: 'no-improvement-conclusive', edge });
  });

  it('§3.179 — an UNSURE pairs round DEEPENS instead of stopping (the two-round ceiling, gone)', () => {
    const keep = { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking' } as const;
    const step = stepAfterRound(report({ verdict: 'unsure', roundKind: 'pairs', round: 1, rows: [edge] }), keep, FRESH, DEPTH);
    expect(step).toEqual({
      kind: 'deepen',
      round: 2,
      roundKind: FIRST_ROUND_KIND,
      gamesPerCandidate: deeperGamesPerCandidate(DEPTH),
    });
  });

  it('§3.179 — the web loop and the engine loop read the SAME growth rule', () => {
    const keep = { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking' } as const;
    const step = stepAfterRound(report({ verdict: 'unsure', roundKind: 'pairs', round: 1, rows: [edge] }), keep, FRESH, DEPTH);
    // Not a number restated here: the value the sim's own function returns.
    expect(step).toMatchObject({ gamesPerCandidate: DEPTH * TRIM_DEEPEN.factor });
  });

  it('§3.179 — the budget stops it, with the budget reason', () => {
    const keep = {
      targetSize: 60,
      onImprovement: 'auto',
      onNoImprovement: 'keep-looking',
      budget: { maxGames: 10, maxSeconds: DEFAULT_TRIM_BUDGET.maxSeconds },
    } as const;
    const spent: TrimSpend = { games: 10, seconds: 0, rounds: 4 };
    expect(stepAfterRound(report({ verdict: 'unsure', roundKind: 'pairs', round: 1, rows: [edge] }), keep, spent, DEPTH)).toEqual({
      kind: 'stopped',
      reason: 'budget-exhausted',
    });
  });

  it('§3.179 — the depth ceiling stops it too, and says the same thing', () => {
    const keep = { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking' } as const;
    expect(
      stepAfterRound(
        report({ verdict: 'unsure', roundKind: 'pairs', round: 1, rows: [edge] }),
        keep,
        FRESH,
        TRIM_DEEPEN.maxGamesPerCandidate,
      ),
    ).toEqual({ kind: 'stopped', reason: 'budget-exhausted' });
  });

  it('keep looking still has nowhere to WIDEN when a pair would overshoot the target', () => {
    const keep = { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking' } as const;
    // 61 cards: a pair cut would land at 59, under the target. Conclusive, so it stops.
    expect(stepAfterRound(report({ verdict: 'exhausted', deckSize: 61 }), keep, FRESH, DEPTH)).toEqual({
      kind: 'stopped',
      reason: 'no-improvement-conclusive',
    });
  });
});

describe('stepAfterApply', () => {
  it('rounds again from singles while above the target, and stops at it', () => {
    expect(stepAfterApply(62, 60, 0)).toEqual({ kind: 'round', round: 1, roundKind: FIRST_ROUND_KIND });
    expect(stepAfterApply(60, 60, 2)).toEqual({ kind: 'target-reached' });
  });
});

describe('targetProblem', () => {
  it('names the one thing wrong with a target, or nothing', () => {
    expect(targetProblem(60, 63, 60)).toBeNull();
    expect(targetProblem(59, 63, 60)).toMatch(/below the format minimum/);
    expect(targetProblem(60, 60, 60)).toMatch(/nothing to trim/);
    expect(targetProblem(63, 63, 60)).toMatch(/must be smaller/);
    expect(targetProblem(60.5, 63, 60)).toMatch(/whole number/);
  });
});
