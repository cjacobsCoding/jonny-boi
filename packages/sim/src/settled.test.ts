/**
 * WHEN MAY THE LADDER STOP? (DESIGN §3.98, corrected in §3.100)
 *
 * `suggest` answers two questions at once — "which of these is best?" and "is it
 * actually better than doing nothing?" — and an early stop has to preserve BOTH.
 * The first version of this rule preserved only the first, and shipped: a measured
 * run stopped at 400 games with its top pick at adjusted p 0.11 (INCONCLUSIVE)
 * where the full ladder reached 800 games and p 6.2e-3 (BETTER). Same
 * recommendation, no longer proven — and every test then in place compared only
 * the pick's IDENTITY and passed.
 *
 * These tests drive the predicate directly with synthetic arms, so both halves are
 * pinned in milliseconds rather than in the ~50s an end-to-end run of the size
 * that triggers the rule would cost.
 */

import { describe, expect, it } from 'vitest';
import { leaderIsSettled, type SettledArm } from './suggest-run.js';

/** An arm that wins `wins` of its first `n` slots, losing the rest. */
function arm(wins: number, n: number): SettledArm {
  const variantWonBySlot = Array.from({ length: n }, (_, i) => i < wins);
  return {
    // Paired against the base: treat every win as a variant-only win and every
    // loss as a base-only win, which is the most discordant (most decisive) shape.
    paired: { bothWon: 0, baseOnly: n - wins, variantOnly: wins, neither: 0 },
    gamesPlayed: n,
    variantWonBySlot,
  };
}

/** The leader wins slots the runner-up loses — maximally separated, both ways. */
function separated(n: number): { leader: SettledArm; runnerUp: SettledArm } {
  return {
    leader: { ...arm(n, n), variantWonBySlot: Array.from({ length: n }, () => true) },
    runnerUp: { ...arm(0, n), variantWonBySlot: Array.from({ length: n }, () => false) },
  };
}

const CTX = { familySize: 8, perLookAlpha: 0.0182, alpha: 0.05 };

describe('the ladder stops only when BOTH halves of the answer are settled', () => {
  it('stops when the leader is proven AND separated from the runner-up', () => {
    const { leader, runnerUp } = separated(40);
    expect(leaderIsSettled(leader, runnerUp, CTX)).toBe(true);
  });

  it('⚠️ does NOT stop when the leader beats the runner-up but is not proven vs the base', () => {
    // The defect this rule shipped with. The two arms are perfectly separated —
    // the RANKING is settled — but the leader's own table is a coin flip, so the
    // report would print INCONCLUSIVE. More games are exactly what is needed.
    const n = 40;
    const leader: SettledArm = {
      paired: { bothWon: 10, baseOnly: 10, variantOnly: 10, neither: 10 },
      gamesPlayed: n,
      variantWonBySlot: Array.from({ length: n }, () => true),
    };
    const runnerUp: SettledArm = {
      paired: { bothWon: 10, baseOnly: 10, variantOnly: 10, neither: 10 },
      gamesPlayed: n,
      variantWonBySlot: Array.from({ length: n }, () => false),
    };
    expect(leaderIsSettled(leader, runnerUp, CTX)).toBe(false);
  });

  it('does NOT stop when the leader is proven but the runner-up is level with it', () => {
    // Both arms win the same slots: nothing separates them, so which one to
    // recommend is still open however decisive each is against the base.
    const n = 40;
    const both = Array.from({ length: n }, () => true);
    const proven: SettledArm = { ...arm(n, n), variantWonBySlot: both };
    expect(leaderIsSettled(proven, { ...proven }, CTX)).toBe(false);
  });

  it('applies the FAMILY-corrected bar, not the raw alpha', () => {
    // ⚠️ The printed verdict faces a Holm correction across the roster, and Holm
    // judges the smallest p against alpha/m. A leader that clears 0.05 but not
    // 0.05/8 would be stopped on a verdict the report then declines to print.
    const n = 14;
    const leader: SettledArm = {
      // Measured p = 1.6e-2: comfortably under 0.05, comfortably over the
      // family-corrected 0.05/8 = 6.25e-3. Numbers chosen against the real
      // `mcNemarTest` rather than a remembered chi-square approximation.
      paired: { bothWon: 0, baseOnly: 2, variantOnly: 12, neither: 1 },
      gamesPlayed: n,
      variantWonBySlot: Array.from({ length: n }, () => true),
    };
    const runnerUp: SettledArm = {
      paired: { bothWon: 0, baseOnly: 12, variantOnly: 2, neither: 1 },
      gamesPlayed: n,
      variantWonBySlot: Array.from({ length: n }, () => false),
    };
    expect(leaderIsSettled(leader, runnerUp, { ...CTX, familySize: 8 })).toBe(false);
    // The same evidence in a family of one clears the bar it actually faces.
    expect(leaderIsSettled(leader, runnerUp, { ...CTX, familySize: 1 })).toBe(true);
  });

  it('never stops without the per-slot records — the comparison cannot be made', () => {
    // A pooled transport that failed to carry them must run the FULL ladder, not
    // stop on a comparison it cannot compute. Safe direction, silently.
    const { leader, runnerUp } = separated(40);
    const { variantWonBySlot: _drop, ...blind } = leader;
    expect(leaderIsSettled(blind, runnerUp, CTX)).toBe(false);
    expect(leaderIsSettled(leader, { ...runnerUp, variantWonBySlot: undefined }, CTX)).toBe(false);
  });
});
