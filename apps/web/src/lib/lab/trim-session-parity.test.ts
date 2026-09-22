/**
 * THE LAB AND THE ENGINE MUST ANSWER "WHAT NOW?" THE SAME WAY (DESIGN §3.179).
 *
 * `trimDeck` owns a synchronous `while` loop; the panel drives one round per
 * worker request so Cancel stays the ordinary cancel. Two loops, one set of
 * rules — which is exactly the shape rule 12 warns about, because the second
 * copy drifts and the bug gets blamed on neither.
 *
 * ⚠️ IT HAD ALREADY DRIFTED, and a real Lab run is what found it. `trimDeck`
 * tests the budget at the TOP of every iteration, so it can never start a round
 * it cannot afford. `stepAfterRound` tested it only on the DEEPEN branch, so a
 * session with budget left over could still widen singles → pairs after the
 * budget was gone. Driving Caleb's own case in the browser overran a
 * 40,000-game budget to **72,162** before stopping. This file is the guard.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRIM_BUDGET,
  TRIM_ROUND_KINDS,
  type TrimRoundReport,
  type TrimSettings,
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
import { stepAfterRound } from './trimSession.js';

const KEEP_LOOKING: TrimSettings = {
  targetSize: 60,
  onImprovement: 'auto',
  onNoImprovement: 'keep-looking',
};

/** A round that found no winner, at the given kind, with rows still unreadable. */
function unsureRound(roundKind: (typeof TRIM_ROUND_KINDS)[number], round = 0): TrimRoundReport {
  return {
    deckName: 'X',
    deckFingerprint: 'fp',
    deckSize: 63,
    targetSize: 60,
    round,
    roundKind,
    cardsPerCut: roundKind === 'pairs' ? 2 : 1,
    coverage: trimCoverage(roundKind, 1, DISTINCT_CARDS),
    reading: {} as TrimRoundReport['reading'],
    verdict: 'unsure',
    rows: [],
    baseWinRate: { p: 0.5, low: 0.4, high: 0.6, successes: 20, n: 40 },
    candidatesEvaluated: 0,
    skipped: [],
    waves: [],
    multipleComparisons: { method: 'holm', familySize: 0, testedThisRun: 0, demotedByCorrection: 0 },
    notes: {} as TrimRoundReport['notes'],
    pairingNote: '',
  };
}

const OVERSPENT: TrimSpend = {
  games: DEFAULT_TRIM_BUDGET.maxGames + 1,
  seconds: 0,
  rounds: 3,
};

describe('§3.179 — the budget stops the Lab loop wherever it is in the kind ladder', () => {
  it('refuses to WIDEN singles → pairs once the budget is gone', () => {
    // THE REGRESSION. Before the fix this returned { kind: 'widen' } and the
    // session played a whole extra round it could not afford.
    expect(stepAfterRound(unsureRound('singles'), KEEP_LOOKING, OVERSPENT, 60)).toEqual({
      kind: 'stopped',
      reason: 'budget-exhausted',
    });
  });

  it('refuses to DEEPEN once the budget is gone', () => {
    expect(stepAfterRound(unsureRound('pairs', 1), KEEP_LOOKING, OVERSPENT, 60)).toEqual({
      kind: 'stopped',
      reason: 'budget-exhausted',
    });
  });

  it('stops on the TIME budget as readily as the game budget', () => {
    const outOfTime: TrimSpend = { games: 0, seconds: DEFAULT_TRIM_BUDGET.maxSeconds + 1, rounds: 3 };
    expect(stepAfterRound(unsureRound('singles'), KEEP_LOOKING, outOfTime, 60)).toEqual({
      kind: 'stopped',
      reason: 'budget-exhausted',
    });
  });

  it('still widens and deepens normally while the budget holds', () => {
    const fresh: TrimSpend = { games: 0, seconds: 0, rounds: 1 };
    expect(stepAfterRound(unsureRound('singles'), KEEP_LOOKING, fresh, 60)).toMatchObject({ kind: 'widen' });
    expect(stepAfterRound(unsureRound('pairs', 1), KEEP_LOOKING, fresh, 60)).toMatchObject({ kind: 'deepen' });
  });

  it('the budget outranks the kind ladder at EVERY kind — no row is exempt', () => {
    // Enumerated from the closed table rather than hand-listed, so a third kind
    // cannot be added with a quiet exemption from the budget.
    for (const kind of TRIM_ROUND_KINDS) {
      expect(
        stepAfterRound(unsureRound(kind), KEEP_LOOKING, OVERSPENT, 60),
        `a ${kind} round ignored the spent budget`,
      ).toEqual({ kind: 'stopped', reason: 'budget-exhausted' });
    }
    expect(TRIM_ROUND_KINDS.length).toBeGreaterThan(1);
  });
});
