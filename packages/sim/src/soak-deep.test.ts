/**
 * THE DEEP SOAK TIER — thousands of games, off by default.
 *
 * Gated on an env var rather than a `describe.skip` so it is a REAL suite when
 * asked for and costs nothing when not:
 *
 * ```bash
 * JB_SOAK_GAMES=2000 npx vitest run packages/sim/src/soak-deep.test.ts
 * npm run sim -- soak --games 2000 --seed 20548      # the same run from the CLI
 * ```
 *
 * Everything the fast tier asserts, this asserts at scale — plus the two checks
 * that are too expensive to run on every game (a full cloning-vs-in-place replay,
 * and the observation-leak scan), which sample here.
 *
 * ⚠️ **It is sized in GAMES and reports CPU, never wall clock.** Ten agents share
 * this box and the same build has measured 39–87 games/sec inside an hour; a
 * duration threshold here would be a coin flip wearing a lab coat.
 */

import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from '@jonny-boi/ai';
import {
  SOAK_BASE_SEED,
  SOAK_DEEP_DEFAULT_GAMES,
  SOAK_DEEP_ENV_VAR,
  SOAK_MAX_TIMEOUT_RATE,
  SOAK_MECHANIC_SEED_ATTEMPTS,
} from './soak-config.js';
import { formatSoakReport, formatViolations, runSoak, type SoakReport } from './soak.js';

const requested = process.env[SOAK_DEEP_ENV_VAR];
const games = requested === undefined ? 0 : Number(requested) || SOAK_DEEP_DEFAULT_GAMES;

/**
 * No timeout on the deep tier's `it`s: the run is sized in games and the box is
 * shared, so a millisecond budget would fail for reasons that have nothing to do
 * with the engine. Vitest's default would otherwise kill a 2,000-game run.
 */
const NO_TIME_LIMIT = 0;

describe.skipIf(games <= 0)(`deep soak (${games} mixed games — set ${SOAK_DEEP_ENV_VAR} to change)`, () => {
  let report: SoakReport;

  it(
    'plays the run',
    () => {
      report = runSoak({
        pool: loadCardPool({ onWarn: () => {} }),
        registry: buildRegistry(),
        pilot: createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID)!,
        mixedGames: games,
        anchorAttempts: SOAK_MECHANIC_SEED_ATTEMPTS,
        baseSeed: SOAK_BASE_SEED,
      });
      // Printed unconditionally: the run's shape (what fired, how often, how much
      // CPU) is the deliverable even when nothing broke, and a green soak that
      // reported nothing would be indistinguishable from a soak that ran nothing.
      console.log(`\n${formatSoakReport(report)}\n`);
      expect(report.games).toBeGreaterThanOrEqual(games);
    },
    NO_TIME_LIMIT,
  );

  it('breaks no invariant', () => {
    expect(report.violations.length, `\n${formatViolations(report.violations)}\n`).toBe(0);
  });

  it('never plays a game that cannot END', () => {
    expect(report.actionCapHits).toBe(0);
  });

  it('finishes most games on the board rather than on the turn cap', () => {
    const rate = report.timeouts / Math.max(report.games, 1);
    expect(rate, `${report.timeouts}/${report.games} games stalled to the turn cap`).toBeLessThan(
      SOAK_MAX_TIMEOUT_RATE,
    );
  });

  it('fires every mechanic the pool prints', () => {
    expect(report.inertMechanics).toEqual([]);
  });
});
