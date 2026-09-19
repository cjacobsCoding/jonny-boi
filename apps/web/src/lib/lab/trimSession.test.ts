/**
 * WHAT FOLLOWS A ROUND (§3.174) — the closed table the panel acts on, walked
 * branch by branch against fabricated round reports.
 */
import { describe, expect, it } from 'vitest';
import type { TrimRoundReport, TrimRow } from '@jonny-boi/sim';
import { FIRST_ROUND_KIND, stepAfterApply, stepAfterRound, targetProblem } from './trimSession.js';

function row(label: string, verdict: 'better' | 'inconclusive' | 'worse', delta: number): TrimRow {
  return {
    rank: 1,
    key: `${label}>(nothing)`,
    cuts: [{ cardId: label, name: label, isLand: false }],
    label,
    sizeAfter: 62,
    evaluation: { verdict, delta } as TrimRow['evaluation'],
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
    expect(stepAfterRound(improved, { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'pause' })).toEqual({ kind: 'apply', row: winner });
    expect(stepAfterRound(improved, { targetSize: 60, onImprovement: 'ask', onNoImprovement: 'pause' })).toEqual({ kind: 'ask', row: winner });
  });

  it('an exhausted round pauses with the edge candidate, or widens to pairs when told to keep looking', () => {
    const exhausted = report({ verdict: 'exhausted', edgeCandidate: edge, rows: [edge] });
    expect(stepAfterRound(exhausted, { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'pause' })).toEqual({ kind: 'exhausted', edge });
    expect(stepAfterRound(exhausted, { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking' })).toEqual({
      kind: 'widen',
      round: 1,
      roundKind: 'pairs',
    });
  });

  it('keep looking has nowhere to go from a pairs round, or when a pair would overshoot the target', () => {
    const keep = { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking' } as const;
    expect(stepAfterRound(report({ roundKind: 'pairs', round: 1, edgeCandidate: edge }), keep)).toEqual({ kind: 'exhausted', edge });
    expect(stepAfterRound(report({ deckSize: 61 }), keep)).toEqual({ kind: 'exhausted' });
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
