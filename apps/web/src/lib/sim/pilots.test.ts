/**
 * The Lab's pilot metadata and its run-cost model.
 *
 * Two things are worth pinning here, and neither is cosmetic:
 *
 *  1. **The list of pilots is not maintained in the web app.** It is derived from
 *     `SELECTABLE_PILOT_IDS`. A second, hand-kept list would drift, and the drift
 *     would show up as a pilot the CLI can run and the Lab cannot (or worse, a
 *     picker option that fails at dispatch).
 *  2. **An unmeasured pilot must read as unmeasured, never as cheap.** The whole
 *     point of the cost estimate is to stop somebody starting an eight-hour run by
 *     accident; a missing number that quietly defaults to "fast" would cause the
 *     exact failure the estimate exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PILOT_ID, HYBRID_PILOT_ID, SELECTABLE_PILOT_IDS } from '@jonny-boi/ai';
import {
  COSTLY_PILOT_THRESHOLD,
  REFERENCE_GAMES_PER_SECOND_PER_WORKER,
  estimateRunSeconds,
  isCostlyPilot,
  isSelectablePilot,
  labPilots,
  pilotLabel,
  pilotProfile,
  relativeCostText,
} from './pilots.js';

const UNKNOWN_PILOT = 'a-pilot-that-does-not-exist';

describe('the pilot list comes from @jonny-boi/ai, not from here', () => {
  it('offers exactly the selectable pilots, in the same order', () => {
    expect(labPilots().map((p) => p.id)).toEqual([...SELECTABLE_PILOT_IDS]);
  });

  it('marks the default pilot, and marks only it', () => {
    const defaults = labPilots().filter((p) => p.isDefault);
    expect(defaults.map((p) => p.id)).toEqual([DEFAULT_PILOT_ID]);
  });

  it('recognises a selectable id and refuses anything else', () => {
    expect(isSelectablePilot(DEFAULT_PILOT_ID)).toBe(true);
    expect(isSelectablePilot(UNKNOWN_PILOT)).toBe(false);
  });

  /**
   * If this fails, a pilot was added to `SELECTABLE_PILOT_IDS` upstream. The fix is
   * one row in `PILOT_COPY` and one in `RELATIVE_GAME_COST` in `pilots.ts` — the
   * app already runs without them, but the picker would show a bare id and the run
   * cost would read "not measured". This assertion is the reminder, not a blocker.
   */
  it('has display copy and a measured cost for every selectable pilot', () => {
    for (const profile of labPilots()) {
      expect(profile.label, `${profile.id} needs a label in pilots.ts`).not.toBe(profile.id);
      expect(profile.blurb.length).toBeGreaterThan(0);
      expect(
        profile.relativeGameCost,
        `${profile.id} needs a measured relativeGameCost in pilots.ts`,
      ).not.toBeNull();
    }
  });
});

describe('an unknown pilot degrades gracefully — shown, never guessed at', () => {
  it('falls back to the raw id and an unmeasured cost', () => {
    const profile = pilotProfile(UNKNOWN_PILOT);
    expect(profile.label).toBe(UNKNOWN_PILOT);
    expect(profile.relativeGameCost).toBeNull();
    expect(profile.isDefault).toBe(false);
    expect(pilotLabel(UNKNOWN_PILOT)).toBe(UNKNOWN_PILOT);
  });

  it('reports no run-time estimate rather than a fast one', () => {
    expect(estimateRunSeconds(1000, UNKNOWN_PILOT, 4)).toBeNull();
  });

  it('is treated as COSTLY, because unknown is not the same as cheap', () => {
    expect(isCostlyPilot(UNKNOWN_PILOT)).toBe(true);
  });
});

describe('the run-cost estimate', () => {
  const GAMES = 600;

  it('gives the baseline pilot the plain throughput figure', () => {
    expect(estimateRunSeconds(GAMES, DEFAULT_PILOT_ID, 1)).toBeCloseTo(
      GAMES / REFERENCE_GAMES_PER_SECOND_PER_WORKER,
    );
  });

  it('scales down with workers and up with the pilot’s game cost', () => {
    const oneWorker = estimateRunSeconds(GAMES, DEFAULT_PILOT_ID, 1) as number;
    expect(estimateRunSeconds(GAMES, DEFAULT_PILOT_ID, 4)).toBeCloseTo(oneWorker / 4);

    const cost = pilotProfile(HYBRID_PILOT_ID).relativeGameCost as number;
    expect(estimateRunSeconds(GAMES, HYBRID_PILOT_ID, 1)).toBeCloseTo(oneWorker * cost);
  });

  it('turns the signature gauntlet from seconds into a long wait on the search pilot', () => {
    // The headline this whole feature exists for: the SAME run, two pilots. On one
    // core the search pilot passes an hour — which is the claim `feat/hybrid-search`
    // made when it declined to re-default ("seconds to hours") — and even spread
    // over eight it is a coffee break rather than a moment.
    const A_MINUTE = 60;
    const AN_HOUR = 60 * A_MINUTE;
    expect(estimateRunSeconds(GAMES, DEFAULT_PILOT_ID, 8) as number).toBeLessThan(A_MINUTE);
    expect(estimateRunSeconds(GAMES, HYBRID_PILOT_ID, 1) as number).toBeGreaterThan(AN_HOUR);
    expect(estimateRunSeconds(GAMES, HYBRID_PILOT_ID, 8) as number).toBeGreaterThan(
      20 * A_MINUTE,
    );
  });

  it('never divides by zero workers, and answers zero games with zero', () => {
    expect(estimateRunSeconds(GAMES, DEFAULT_PILOT_ID, 0)).toBe(
      estimateRunSeconds(GAMES, DEFAULT_PILOT_ID, 1),
    );
    expect(estimateRunSeconds(0, DEFAULT_PILOT_ID, 4)).toBe(0);
  });
});

describe('what the picker says about a choice', () => {
  it('says nothing extra for the baseline pilot, and quotes the ratio otherwise', () => {
    expect(relativeCostText(DEFAULT_PILOT_ID)).toBeNull();
    expect(relativeCostText(HYBRID_PILOT_ID)).toMatch(/×1,400/);
    expect(relativeCostText(UNKNOWN_PILOT)).toMatch(/not measured/);
  });

  it('flags a pilot as costly exactly at the named threshold', () => {
    expect(isCostlyPilot(DEFAULT_PILOT_ID)).toBe(false);
    expect(isCostlyPilot(HYBRID_PILOT_ID)).toBe(true);
    expect(pilotProfile(HYBRID_PILOT_ID).relativeGameCost).toBeGreaterThanOrEqual(
      COSTLY_PILOT_THRESHOLD,
    );
  });
});
