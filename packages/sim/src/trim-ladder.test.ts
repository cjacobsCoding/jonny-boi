/**
 * DESIGN §3.179, item 3 — "keep looking" actually keeps looking.
 *
 * The bug, measured: `trimDeck` widened through `TRIM_ROUND_KINDS`
 * (`['singles','pairs']`) and treated the end of that two-row table as the end
 * of the search, so `keep-looking` got exactly TWO rounds. Compounded by item 2
 * — with almost every row inconclusive there is never a winner — every round
 * ended `exhausted`, the ladder widened once, and the session stopped having cut
 * ZERO cards while printing a word that reads as "nothing helps".
 *
 * The acceptance list, verbatim from `docs/plans/lab-tuning-plan.md`:
 *
 *   1. A rigged session whose rows are all inconclusive and whose deck is above
 *      target does NOT stop after two rounds: it deepens, and the test asserts
 *      `gamesPerCandidate` actually grew.
 *   2. A rigged session whose rows are conclusively not-better stops immediately
 *      with the CONCLUSIVE stop reason — deepening a settled question is waste,
 *      and this is the check that keeps the fix from becoming an infinite loop.
 *   3. The budget boundary stops the session with its own reason, and the deck is
 *      returned as it stands.
 *   4. Each stop reason renders its own words; a test enumerates the reasons and
 *      fails if one has no wording.
 */
import { describe, expect, it } from 'vitest';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { loadDeck } from './deck.js';
import type { Deck } from './deck.js';
import type { MatchupPilots } from './matchup.js';
import { applySwap, type CardSwap } from './swap.js';
import type { ArmHandle, SwapArm } from './paired-arms.js';
import {
  DEFAULT_TRIM_BUDGET,
  TRIM_DEEPEN,
  TRIM_ROUND_KINDS,
  TRIM_STOP_REASONS,
  TRIM_STOP_REASON_WORDING,
  deckSizeOf,
  deeperGamesPerCandidate,
  trimDeck,
  type TrimArmRunner,
  type TrimRoundPlan,
} from './trim.js';
import { MONO_GREEN_STOMPY, UW_CONTROL } from '../data/decks/index.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function pilot(id: string): Pilot {
  const p = createDefaultAiRegistry().getPilot(id);
  if (!p) throw new Error(`no pilot ${id}`);
  return p;
}
const pilots: MatchupPilots = { pilotA: pilot(HEURISTIC_PILOT_ID), pilotB: pilot(HEURISTIC_PILOT_ID) };

/** Mono-Green Ramp (60) carrying three off-colour Swamps — 63 cards, target 60. */
const RIGGED: Deck = {
  name: 'Rigged Green',
  archetype: 'test',
  cards: [...MONO_GREEN_STOMPY.cards, { cardId: 'Swamp', count: 3 }],
};
const TWO_OPPONENTS = [loadDeck(UW_CONTROL, pool), loadDeck(MONO_GREEN_STOMPY, pool)];

type Rig = (swap: CardSwap, slot: number, baseWon: boolean) => boolean;

function riggedRunner(base: Deck, rig: Rig): TrimArmRunner {
  const arms = new Map<ArmHandle, { swap: CardSwap; state: SwapArm }>();
  let played = 0;
  return {
    openArm(swap, outName, inName) {
      const handle = {} as ArmHandle;
      const variantDeck = applySwap(base, swap, pool, 'one');
      arms.set(handle, {
        swap,
        state: {
          swap,
          outName,
          inName,
          variantDeck,
          gamesPlayed: 0,
          variantGamesSkipped: 0,
          paired: { bothWon: 0, baseOnly: 0, variantOnly: 0, neither: 0 },
          variantWonBySlot: [],
        },
      });
      return handle;
    },
    advance(handle, target) {
      const arm = arms.get(handle);
      if (!arm) throw new Error('unknown handle');
      const paired = { ...arm.state.paired };
      const slots = [...arm.state.variantWonBySlot];
      for (let slot = arm.state.gamesPlayed; slot < target; slot++) {
        const baseWon = slot % 2 === 0;
        const variantWon = rig(arm.swap, slot, baseWon);
        slots[slot] = variantWon;
        if (baseWon && variantWon) paired.bothWon++;
        else if (baseWon) paired.baseOnly++;
        else if (variantWon) paired.variantOnly++;
        else paired.neither++;
        played += 2;
      }
      arm.state = { ...arm.state, gamesPlayed: target, paired, variantWonBySlot: slots };
      return arm.state;
    },
    usage: () => ({
      baseGamesPlayed: played / 2,
      variantGamesPlayed: played / 2,
      variantGamesSkipped: 0,
      totalGamesPlayed: played,
      identicalGameSkipEnabled: false,
    }),
  };
}

/**
 * THE UNREADABLE RIG — every row `notSignificant` at EVERY depth.
 *
 * ⚠️ THIS RIG'S FIRST VERSION WAS WRONG, and the test caught it. It made the
 * discordant counts PROPORTIONAL to n (roughly n/10 against n/22, because half
 * the intended base-only slots landed where the base had also lost). |b − c|
 * then grew linearly with n, so McNemar's statistic grew with n too: by depth
 * 640 the rig was CONCLUSIVE and handed the ladder a winner, and the test read
 * `applied: [2 cuts]` where it expected none. A rig that changes what it is
 * proving as the thing under test scales is not a rig.
 *
 * So the discordant split is now a CONSTANT, not a proportion: the variant
 * mirrors the base on every slot except three fixed low ones. Whatever depth the
 * ladder reaches, b = 2 and c = 1 — `|b − c| − 1 = 0`, so the statistic is
 * exactly 0 and p is exactly 1 — while the delta stays nonzero, so it is
 * `notSignificant` and never `deadHeat`. That is Caleb's wall of INCONCLUSIVE,
 * held at every depth by construction rather than by arithmetic luck.
 *
 * Base wins the EVEN slots, so slots 1 and 3 are variant-only wins and slot 0 is
 * a base-only win.
 */
const alwaysUnsure: Rig = (_swap, slot, baseWon) => {
  if (slot === 1 || slot === 3) return true; // base lost, variant won
  if (slot === 0) return false; // base won, variant lost
  return baseWon; // concordant: carries no signal at all
};

/** Every cut is conclusively WORSE: the variant loses every slot the base won. */
const conclusivelyWorse: Rig = () => false;

const sessionOptions = {
  gauntletDecks: TWO_OPPONENTS,
  pilots,
  pool,
  registry,
  baseSeed: 7,
  gamesPerCandidate: 20,
};

/** Record the per-candidate depth each round was actually planned at. */
function depthRecorder(): { depths: number[]; armRunner: (base: Deck, round: TrimRoundPlan) => TrimArmRunner } {
  const depths: number[] = [];
  return {
    depths,
    armRunner: (base: Deck, round: TrimRoundPlan) => {
      // `maxPairedGames` IS gamesPerCandidate × opponentCount, so this reads the
      // depth off the PLAN rather than trusting the loop's own bookkeeping.
      depths.push(round.plan.maxPairedGames / TWO_OPPONENTS.length);
      return riggedRunner(base, alwaysUnsure);
    },
  };
}

describe('§3.179 acceptance 1 — an unsure session deepens instead of stopping after two rounds', () => {
  it('runs more than the two rounds the old ladder allowed', () => {
    const { armRunner } = depthRecorder();
    const result = trimDeck(RIGGED, {
      ...sessionOptions,
      settings: { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking' },
      armRunner,
    });
    // The DISCRIMINATOR: before §3.179 this was exactly 2 — singles, pairs, stop.
    expect(result.rounds.length, 'the two-round ceiling is the bug being fixed').toBeGreaterThan(
      TRIM_ROUND_KINDS.length,
    );
  });

  it('grows gamesPerCandidate — the lever, asserted on the PLAN the rounds were run at', () => {
    const { depths, armRunner } = depthRecorder();
    const result = trimDeck(RIGGED, {
      ...sessionOptions,
      settings: { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking' },
      armRunner,
    });
    expect(depths.length).toBeGreaterThan(TRIM_ROUND_KINDS.length);
    const first = depths[0] as number;
    const deepest = Math.max(...depths);
    expect(first).toBe(sessionOptions.gamesPerCandidate);
    expect(deepest, 'the ladder never deepened').toBeGreaterThan(first);
    expect(result.gamesPerCandidate).toBe(deepest);
    // ...and it deepened by the NAMED factor, not by some accident of arithmetic:
    // the DISTINCT depths, in order, are each `factor` times the one before.
    const levels = [...new Set(depths)];
    expect(levels.length, 'only one depth means it never deepened').toBeGreaterThan(1);
    for (let i = 1; i < levels.length; i++) {
      const previous = levels[i - 1] as number;
      const current = levels[i] as number;
      expect(current, `depth level ${i} did not grow by the named factor`).toBe(
        Math.min(previous * TRIM_DEEPEN.factor, TRIM_DEEPEN.maxGamesPerCandidate),
      );
    }
    expect(deepest).toBe(TRIM_DEEPEN.maxGamesPerCandidate);
  });

  it('every row really was unsure — otherwise this whole rig proves nothing', () => {
    const { armRunner } = depthRecorder();
    const result = trimDeck(RIGGED, {
      ...sessionOptions,
      settings: { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking' },
      armRunner,
    });
    const firstRound = result.rounds[0];
    expect(firstRound?.verdict).toBe('unsure');
    expect(firstRound?.rows.length).toBeGreaterThan(0);
    expect(firstRound?.rows.every((row) => row.evaluation.verdict === 'inconclusive')).toBe(true);
  });

  it('terminates: the depth ceiling and the budget are both real boundaries', () => {
    const { armRunner } = depthRecorder();
    const result = trimDeck(RIGGED, {
      ...sessionOptions,
      settings: { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking' },
      armRunner,
    });
    expect(['budget-exhausted']).toContain(result.stopped);
    expect(result.gamesPerCandidate).toBeLessThanOrEqual(TRIM_DEEPEN.maxGamesPerCandidate);
    // Nothing was cut, and the deck comes back as it stands — an unsure session
    // must never apply a removal it could not prove.
    expect(result.applied).toEqual([]);
    expect(deckSizeOf(result.deck)).toBe(63);
  });
});

describe('§3.179 acceptance 2 — a CONCLUSIVE round stops at once (the infinite-loop bound)', () => {
  it('stops with no-improvement-conclusive after the kinds, and never deepens', () => {
    const depths: number[] = [];
    const result = trimDeck(RIGGED, {
      ...sessionOptions,
      settings: { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking' },
      armRunner: (base: Deck, round: TrimRoundPlan) => {
        depths.push(round.plan.maxPairedGames / TWO_OPPONENTS.length);
        return riggedRunner(base, conclusivelyWorse);
      },
    });
    expect(result.stopped).toBe('no-improvement-conclusive');
    // Singles, then pairs, then stop. Deepening a settled question is waste, and
    // without this branch the loop would deepen until the budget ran out on a
    // question it had already answered.
    expect(result.rounds.length).toBe(TRIM_ROUND_KINDS.length);
    expect(new Set(depths).size, 'a settled question must not be re-measured deeper').toBe(1);
    expect(result.gamesPerCandidate).toBe(sessionOptions.gamesPerCandidate);
  });

  it('and it really was conclusive — every row proved worse, none merely unread', () => {
    const result = trimDeck(RIGGED, {
      ...sessionOptions,
      settings: { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking' },
      armRunner: (base: Deck) => riggedRunner(base, conclusivelyWorse),
    });
    const first = result.rounds[0];
    expect(first?.verdict).toBe('exhausted');
    expect(first?.rows.every((row) => row.evaluation.verdictReason === 'significantLoss')).toBe(true);
  });

  it('the conclusive stop reason is the one that says the search is over', () => {
    expect(TRIM_STOP_REASON_WORDING['no-improvement-conclusive'].conclusive).toBe(true);
    expect(TRIM_STOP_REASON_WORDING['budget-exhausted'].conclusive).toBe(false);
  });
});

describe('§3.179 acceptance 3 — the budget stops the session with its own reason', () => {
  it('stops on the game budget and hands the deck back as it stands', () => {
    const result = trimDeck(RIGGED, {
      ...sessionOptions,
      settings: {
        targetSize: 60,
        onImprovement: 'auto',
        onNoImprovement: 'keep-looking',
        budget: { maxGames: 1, maxSeconds: DEFAULT_TRIM_BUDGET.maxSeconds },
      },
      armRunner: (base: Deck) => riggedRunner(base, alwaysUnsure),
    });
    expect(result.stopped).toBe('budget-exhausted');
    expect(deckSizeOf(result.deck)).toBe(63);
    expect(result.applied).toEqual([]);
    // One round runs, THEN the budget bites — the boundary is checked before a
    // round rather than after, so the session cannot overspend and then report
    // having stopped at the line.
    expect(result.rounds.length).toBe(1);
    expect(result.spend.games).toBeGreaterThan(0);
    expect(result.spend.rounds).toBe(1);
  });

  it('a budget of zero games stops before playing anything at all', () => {
    const result = trimDeck(RIGGED, {
      ...sessionOptions,
      settings: {
        targetSize: 60,
        onImprovement: 'auto',
        onNoImprovement: 'keep-looking',
        budget: { maxGames: 0, maxSeconds: 0 },
      },
      armRunner: (base: Deck) => riggedRunner(base, alwaysUnsure),
    });
    expect(result.stopped).toBe('budget-exhausted');
    expect(result.rounds).toEqual([]);
    expect(result.spend).toEqual({ games: 0, seconds: 0, rounds: 0 });
  });

  it('"pause" is its own reason, never the budget or the conclusive one', () => {
    const result = trimDeck(RIGGED, {
      ...sessionOptions,
      settings: { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'pause' },
      armRunner: (base: Deck) => riggedRunner(base, alwaysUnsure),
    });
    expect(result.stopped).toBe('paused');
    expect(result.rounds.length).toBe(1);
  });
});

describe('§3.179 acceptance 4 — every stop reason has its own words', () => {
  it('enumerates the reasons and fails if one ships mute', () => {
    expect(TRIM_STOP_REASONS.length).toBeGreaterThan(3);
    for (const reason of TRIM_STOP_REASONS) {
      const row = TRIM_STOP_REASON_WORDING[reason];
      expect(row, `no wording row for ${reason}`).toBeDefined();
      expect(row.reason, `${reason}'s row names a different reason`).toBe(reason);
      expect(row.label.length, `${reason} has no label`).toBeGreaterThan(3);
      expect(row.detail.length, `${reason} has no detail`).toBeGreaterThan(20);
    }
  });

  it('the wording table has no rows the vocabulary does not contain', () => {
    expect(Object.keys(TRIM_STOP_REASON_WORDING).sort()).toEqual([...TRIM_STOP_REASONS].sort());
  });

  it('the two opposite situations do not share wording — the whole point of the split', () => {
    const conclusive = TRIM_STOP_REASON_WORDING['no-improvement-conclusive'];
    const budget = TRIM_STOP_REASON_WORDING['budget-exhausted'];
    expect(conclusive.label).not.toBe(budget.label);
    expect(conclusive.detail).not.toBe(budget.detail);
    // And the budget one must not be readable as "nothing helps", which is the
    // false message the old single `'exhausted'` sent.
    expect(budget.detail).toMatch(/NOT "nothing helps"/u);
  });
});

describe('§3.179 — deeperGamesPerCandidate, the growth rule both drivers read', () => {
  it('grows by the named factor and stops at the named ceiling', () => {
    expect(deeperGamesPerCandidate(20)).toBe(20 * TRIM_DEEPEN.factor);
    expect(deeperGamesPerCandidate(TRIM_DEEPEN.maxGamesPerCandidate)).toBeUndefined();
    // The last step is clamped to the ceiling rather than overshooting it.
    const justUnder = TRIM_DEEPEN.maxGamesPerCandidate - 1;
    expect(deeperGamesPerCandidate(justUnder)).toBe(TRIM_DEEPEN.maxGamesPerCandidate);
  });

  it('always makes progress, so the loop that calls it cannot spin', () => {
    let depth = 1;
    let steps = 0;
    for (;;) {
      const next = deeperGamesPerCandidate(depth);
      if (next === undefined) break;
      expect(next, 'a deepening step that does not deepen would spin forever').toBeGreaterThan(depth);
      depth = next;
      steps += 1;
      expect(steps, 'the ladder must terminate').toBeLessThan(1000);
    }
    expect(steps).toBeGreaterThan(0);
  });
});
