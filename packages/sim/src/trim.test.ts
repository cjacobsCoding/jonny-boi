/**
 * THE LAB TRIM (§3.174) — the pure module, pinned.
 *
 * Two kinds of test, on purpose:
 *
 *  1. The LOOP under a RIGGED arm runner. The statistics are the shared ones
 *     (`finishSuggestionRun`, Holm, `decideVerdict`), already pinned by their own
 *     suites; what this module adds is the decision flow — the verdict of a
 *     round, the apply, the shrink, the widening, the stop — and a rig that says
 *     "cutting the Swamp wins 40% of slots outright, nothing else moves" proves
 *     that flow exactly, without the answer being hostage to what forty real
 *     games happen to say about a one-card-in-sixty-three effect.
 *  2. The PLUMBING under REAL games, small: a round on the rigged deck through
 *     `createPairedArmRunner`, asserting the shape a cut arm must have — one card
 *     shorter, never answered for free, every row measured.
 */
import { describe, expect, it } from 'vitest';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { loadDeck } from './deck.js';
import type { Deck } from './deck.js';
import type { MatchupPilots } from './matchup.js';
import { applySwap, copiesSwappedBy, CUT_OUT_SEPARATOR, SWAP_IN_NOTHING, type CardSwap } from './swap.js';
import { swappedInstanceIdsFor, type ArmHandle, type SwapArm } from './paired-arms.js';
import { DEFAULT_DECK_RULES } from './config.js';
import {
  CARDS_PER_CUT,
  DEFAULT_TRIM_CONFIG,
  LAND_RATIO_TOLERANCE_LANDS,
  TRIM_SKIP_NOT_APPLICABLE,
  applyTrimCut,
  deckSizeOf,
  generateTrimCandidates,
  landCutDue,
  landRatioOf,
  nextWideningStep,
  prepareTrimRound,
  runTrimRound,
  trimDeck,
  type TrimArmRunner,
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

/** The rigged deck: Mono-Green Ramp (60) carrying three off-colour Swamps (63). */
const RIGGED: Deck = {
  name: 'Rigged Green',
  archetype: 'test',
  cards: [...MONO_GREEN_STOMPY.cards, { cardId: 'Swamp', count: 3 }],
};
const SWAMP_ID = pool.getByName('Swamp')?.id ?? 'missing-swamp';
const FOREST_ID = pool.getByName('Forest')?.id ?? 'missing-forest';
const countIn = (deck: Deck, cardId: string): number =>
  deck.cards.filter((e) => (pool.get(e.cardId) ?? pool.getByName(e.cardId))?.id === cardId).reduce((s, e) => s + e.count, 0);

// --- the rig -----------------------------------------------------------------------

/** How a rigged arm's variant game goes at one slot, given the base's result. */
type Rig = (swap: CardSwap, slot: number, baseWon: boolean) => boolean;

/** Base wins the even slots; the rig decides the variant. Deterministic, slot-keyed. */
function riggedRunner(base: Deck, rig: Rig): TrimArmRunner {
  const arms = new Map<ArmHandle, { swap: CardSwap; outName: string; inName: string; variantDeck: Deck; state: SwapArm }>();
  let played = 0;
  return {
    openArm(swap, outName, inName) {
      const handle = {} as ArmHandle;
      // The REAL funnel builds the variant, so an unbuildable candidate still throws here.
      const variantDeck = applySwap(base, swap, pool, 'one');
      arms.set(handle, {
        swap,
        outName,
        inName,
        variantDeck,
        state: { swap, outName, inName, variantDeck, gamesPlayed: 0, variantGamesSkipped: 0, paired: { bothWon: 0, baseOnly: 0, variantOnly: 0, neither: 0 }, variantWonBySlot: [] },
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

/** Cutting `favouredId` wins 90% of slots (40% of them outright); everything else plays as the base did. */
const favouring =
  (favouredId: string): Rig =>
  (swap, slot, baseWon) =>
    swap.out === favouredId ? slot % 10 < 9 : baseWon;

/** Nothing differs from the base, except `edgeId` wins one extra slot — a whisper, not a verdict. */
const flatWithEdge =
  (edgeId: string): Rig =>
  (swap, slot, baseWon) =>
    baseWon || (swap.out === edgeId && slot === 1);

const sessionOptions = {
  gauntletDecks: [] as never[],
  pilots,
  pool,
  registry,
  baseSeed: 7,
  gamesPerCandidate: 20,
};
/** Two "opponents" worth of slots without loading any: the rig never looks at them. */
const TWO_OPPONENTS = [loadDeck(UW_CONTROL, pool), loadDeck(MONO_GREEN_STOMPY, pool)];

// --- the cut, through the one funnel ---------------------------------------------------

describe('a CUT through applySwap (§3.174)', () => {
  it('removes one copy in place and adds nothing; the name records what left', () => {
    const cut = applySwap(RIGGED, { out: 'Swamp', in: SWAP_IN_NOTHING }, pool, 'one');
    expect(deckSizeOf(cut)).toBe(62);
    expect(countIn(cut, SWAMP_ID)).toBe(2);
    expect(countIn(cut, FOREST_ID)).toBe(24);
    expect(cut.cards.length).toBe(RIGGED.cards.length);
    expect(cut.name).toBe('Rigged Green (−1× Swamp)');
    // The base is untouched.
    expect(countIn(RIGGED, SWAMP_ID)).toBe(3);
  });

  it('drops the line when the last copy goes', () => {
    const oneOf: Deck = { ...RIGGED, cards: [...MONO_GREEN_STOMPY.cards, { cardId: 'Swamp', count: 1 }] };
    const cut = applySwap(oneOf, { out: 'Swamp', in: SWAP_IN_NOTHING }, pool, 'one');
    expect(cut.cards.some((e) => e.cardId === 'Swamp')).toBe(false);
    expect(deckSizeOf(cut)).toBe(60);
  });

  it('a PAIR cuts one copy of each card and reports two copies moved', () => {
    const swap: CardSwap = { out: `Craw Wurm${CUT_OUT_SEPARATOR}Forest`, in: SWAP_IN_NOTHING };
    const cut = applySwap(RIGGED, swap, pool, 'one');
    expect(deckSizeOf(cut)).toBe(61);
    expect(countIn(cut, FOREST_ID)).toBe(23);
    expect(cut.name).toBe('Rigged Green (−1× Craw Wurm −1× Forest)');
    expect(copiesSwappedBy(RIGGED, swap, pool, 'one')).toBe(2);
    expect(copiesSwappedBy(RIGGED, { out: 'Swamp', in: SWAP_IN_NOTHING }, pool, 'one')).toBe(1);
  });

  it('refuses a card the deck does not hold, never a silent no-op', () => {
    expect(() => applySwap(RIGGED, { out: 'Lightning Bolt', in: SWAP_IN_NOTHING }, pool, 'one')).toThrow(/not in deck/);
    expect(() => applySwap(RIGGED, { out: 'No Such Card', in: SWAP_IN_NOTHING }, pool, 'one')).toThrow(/not found/);
  });

  it('turns the identical-game skip off by construction: the libraries differ in length', () => {
    const cut = applySwap(RIGGED, { out: 'Swamp', in: SWAP_IN_NOTHING }, pool, 'one');
    expect(swappedInstanceIdsFor(loadDeck(RIGGED, pool).library, loadDeck(cut, pool).library)).toBeUndefined();
  });

  it('applyTrimCut applies through the same funnel and keeps the deck’s own name', () => {
    const applied = applyTrimCut(RIGGED, [{ cardId: SWAMP_ID, name: 'Swamp', isLand: true }], pool);
    expect(applied.name).toBe('Rigged Green');
    expect(countIn(applied, SWAMP_ID)).toBe(2);
    expect(deckSizeOf(applied)).toBe(62);
  });
});

// --- the mana prior -------------------------------------------------------------------

describe('landCutDue — the mana prior, as arithmetic', () => {
  it('nominates a land only after enough nonland cuts (24/60, tolerance 1: the third)', () => {
    expect(landCutDue(24, 60, 24, 60).due).toBe(false);
    expect(landCutDue(24, 60, 24, 59).due).toBe(false); // 0.4 over
    expect(landCutDue(24, 60, 24, 58).due).toBe(false); // 0.8 over
    const third = landCutDue(24, 60, 24, 57); // 1.2 over
    expect(third.due).toBe(true);
    expect(third.favoured).toBe('land');
    expect(third.ratioLands).toBeCloseTo(22.8, 5);
    expect(third.excessLands).toBeCloseTo(1.2, 5);
    expect(third.tolerance).toBe(LAND_RATIO_TOLERANCE_LANDS);
  });

  it('prints the arithmetic it used', () => {
    const reading = landCutDue(24, 63, 24, 60);
    expect(reading.due).toBe(true);
    expect(reading.explanation).toBe(
      'lands 24/63 at the start (38.1%) → 24/60 now (40.0%) → 22.9 lands would keep that ratio → 1.1 over (a land cut is due at 1 over) → a land cut is due',
    );
    expect(landCutDue(24, 60, 24, 60).explanation).toContain('unchanged so far');
    expect(landCutDue(24, 60, 24, 60).explanation).toContain('no land cut due yet');
  });

  it('after a land cut the drift resets, and fewer lands than the ratio favours a nonland', () => {
    expect(landCutDue(24, 60, 23, 57).due).toBe(false); // 22.8 wanted, 0.2 over
    const under = landCutDue(24, 60, 22, 57);
    expect(under.due).toBe(false);
    expect(under.favoured).toBe('nonland');
    expect(under.explanation).toContain('0.8 under');
  });

  it('the tolerance is a parameter, and a base of no cards never asks for a land', () => {
    expect(landCutDue(24, 60, 24, 58, 0.5).due).toBe(true);
    expect(landCutDue(0, 0, 24, 58).due).toBe(false);
    expect(landCutDue(0, 0, 24, 58).explanation).toContain('no ratio');
  });

  it('reads a deck’s ratio against the pool', () => {
    expect(landRatioOf(RIGGED, pool)).toEqual({ lands: 27, size: 63 });
    expect(landRatioOf(MONO_GREEN_STOMPY, pool)).toEqual({ lands: 24, size: 60 });
  });
});

// --- candidates and the plan ------------------------------------------------------------

describe('generateTrimCandidates', () => {
  const notDue = landCutDue(27, 63, 27, 63);
  const due = landCutDue(24, 60, 24, 57);

  it('offers every distinct card as a one-copy cut — including the off-colour basic, no basic floor', () => {
    const { candidates, skipped } = generateTrimCandidates(RIGGED, pool, { kind: 'singles', reading: notDue });
    expect(candidates.length).toBe(11);
    expect(skipped).toEqual([]);
    for (const c of candidates) {
      expect(c.inId).toBe(SWAP_IN_NOTHING);
      expect(c.copiesSwapped).toBe(1);
      expect(c.sizeAfter).toBe(62);
      expect(c.cuts.length).toBe(1);
    }
    expect(candidates.some((c) => c.outId === SWAMP_ID)).toBe(true);
  });

  it('scouts the class the ratio favours first — nonlands when no land cut is due, lands when one is', () => {
    const quiet = generateTrimCandidates(RIGGED, pool, { kind: 'singles', reading: notDue }).candidates;
    const firstLand = quiet.findIndex((c) => c.cuts[0]?.isLand);
    const lastNonland = quiet.map((c) => !c.cuts[0]?.isLand).lastIndexOf(true);
    expect(firstLand).toBeGreaterThan(lastNonland);
    expect(quiet[0]?.priorReasons).toContain('a nonland, and no land cut is due');

    const landsFirst = generateTrimCandidates(RIGGED, pool, { kind: 'singles', reading: due }).candidates;
    expect(landsFirst[0]?.cuts[0]?.isLand).toBe(true);
    expect(landsFirst[1]?.cuts[0]?.isLand).toBe(true);
    expect(landsFirst[0]?.priorReasons).toContain('a land, and a land cut is due');
    // A 24-of basic scores as a 4-of: copies never outrank the favoured class.
    expect(quiet.findIndex((c) => c.outId === FOREST_ID)).toBeGreaterThan(lastNonland);
  });

  it('pairs are every nonland × land, capped with the rest reported', () => {
    const { candidates, skipped } = generateTrimCandidates(RIGGED, pool, { kind: 'pairs', reading: due });
    expect(candidates.length).toBe(9 * 2);
    expect(skipped).toEqual([]);
    for (const c of candidates) {
      expect(c.cuts.length).toBe(2);
      expect(c.cuts.filter((cut) => cut.isLand).length).toBe(1);
      expect(c.copiesSwapped).toBe(2);
      expect(c.sizeAfter).toBe(61);
    }
    const capped = generateTrimCandidates(RIGGED, pool, {
      kind: 'pairs',
      reading: due,
      config: { ...DEFAULT_TRIM_CONFIG, maxPairCandidates: 5 },
    });
    expect(capped.candidates.length).toBe(5);
    expect(capped.skipped.filter((s) => s.reason === 'capped').length).toBe(13);
  });

  it('a cut that would take the deck under the minimum is reported illegal, not built', () => {
    const { candidates, skipped } = generateTrimCandidates(MONO_GREEN_STOMPY, pool, { kind: 'singles', reading: notDue });
    expect(candidates).toEqual([]);
    expect(skipped.length).toBe(10);
    expect(skipped.every((s) => s.reason === 'illegal' && s.details.some((d) => /below the minimum/.test(d)))).toBe(true);
  });
});

describe('prepareTrimRound', () => {
  it('lays the wave ladder over the candidates and carries the reading', () => {
    const round = prepareTrimRound(RIGGED, { pool, opponentCount: 2, baseSeed: 7, round: 0, gamesPerCandidate: 20, roundKind: 'singles', targetSize: 60 });
    expect(round.plan.roster.length).toBe(11);
    expect(round.plan.reserves).toEqual([]);
    expect(round.plan.maxPairedGames).toBe(40);
    expect(round.plan.waves.length).toBeGreaterThan(0);
    expect(round.plan.waves[round.plan.waves.length - 1]?.cumulativeGames).toBe(40);
    expect(round.reading.base).toEqual({ lands: 27, size: 63 });
    expect(round.deckSize).toBe(63);
    expect(round.cardsPerCut).toBe(CARDS_PER_CUT.singles);
  });

  it('later rounds play different games, and measure drift from the SESSION base', () => {
    const first = prepareTrimRound(RIGGED, { pool, opponentCount: 2, baseSeed: 7, round: 0, gamesPerCandidate: 20, roundKind: 'singles', targetSize: 60 });
    const later = prepareTrimRound(RIGGED, { pool, opponentCount: 2, baseSeed: 7, round: 2, gamesPerCandidate: 20, roundKind: 'singles', targetSize: 60, baseLandRatio: { lands: 24, size: 60 } });
    expect(later.plan.runSeed).not.toBe(first.plan.runSeed);
    expect(later.reading.base).toEqual({ lands: 24, size: 60 });
  });

  it('refuses a target under the minimum, a deck already at the target, and an overshooting pair round', () => {
    const base = { pool, opponentCount: 2, baseSeed: 7, round: 0, gamesPerCandidate: 20, roundKind: 'singles' as const };
    expect(() => prepareTrimRound(RIGGED, { ...base, targetSize: DEFAULT_DECK_RULES.minDeckSize - 1 })).toThrow(/below the format minimum/);
    expect(() => prepareTrimRound(MONO_GREEN_STOMPY, { ...base, targetSize: 60 })).toThrow(/already at or below/);
    const sixtyOne: Deck = { ...RIGGED, cards: [...MONO_GREEN_STOMPY.cards, { cardId: 'Swamp', count: 1 }] };
    expect(() => prepareTrimRound(sixtyOne, { ...base, roundKind: 'pairs', targetSize: 60 })).toThrow(/under the target/);
  });
});

describe('nextWideningStep', () => {
  it('widens singles → pairs only while a pair still fits above the target, and pairs → nothing', () => {
    expect(nextWideningStep('singles', 63, 60)).toBe('pairs');
    expect(nextWideningStep('singles', 62, 60)).toBe('pairs');
    expect(nextWideningStep('singles', 61, 60)).toBeUndefined();
    expect(nextWideningStep('pairs', 63, 60)).toBeUndefined();
  });
});

// --- the loop, rigged --------------------------------------------------------------------

describe('trimDeck — the auto loop (rigged arms)', () => {
  it('(1) trims the 63-card deck to 60 by cutting exactly the three Swamps, in three rounds', () => {
    const result = trimDeck(RIGGED, {
      ...sessionOptions,
      gauntletDecks: TWO_OPPONENTS,
      settings: { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'pause' },
      armRunner: (base) => riggedRunner(base, favouring(SWAMP_ID)),
    });
    expect(result.stopped).toBe('target-reached');
    expect(result.rounds.length).toBe(3);
    expect(result.applied.map((row) => row.label)).toEqual(['Swamp', 'Swamp', 'Swamp']);
    expect(deckSizeOf(result.deck)).toBe(60);
    expect(countIn(result.deck, SWAMP_ID)).toBe(0);
    // Everything else is exactly as it was.
    for (const entry of MONO_GREEN_STOMPY.cards) {
      const id = (pool.get(entry.cardId) ?? pool.getByName(entry.cardId))?.id ?? '';
      expect(countIn(result.deck, id)).toBe(entry.count);
    }
    for (const [i, round] of result.rounds.entries()) {
      expect(round.verdict).toBe('improved');
      expect(round.winner?.label).toBe('Swamp');
      expect(round.winner?.evaluation.verdict).toBe('better');
      expect(round.deckSize).toBe(63 - i);
      expect(round.round).toBe(i);
      // The prior measured drift from the SESSION base every round.
      expect(round.reading.base).toEqual({ lands: 27, size: 63 });
    }
  });

  it('(2) a round in which nothing improves is exhausted, names the edge candidate, and applies nothing', () => {
    const edgeId = pool.getByName('Craw Wurm')?.id ?? '';
    const result = trimDeck(RIGGED, {
      ...sessionOptions,
      gauntletDecks: TWO_OPPONENTS,
      settings: { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'pause' },
      armRunner: (base) => riggedRunner(base, flatWithEdge(edgeId)),
    });
    // §3.179 — this session sets `onNoImprovement: 'pause'`, and `'paused'` is
    // now its own stop reason. It used to report `'exhausted'`, which reads as
    // "nothing helps" when what happened is "you told me to stop and ask".
    expect(result.stopped).toBe('paused');
    expect(result.applied).toEqual([]);
    expect(result.deck).toBe(RIGGED);
    expect(result.rounds.length).toBe(1);
    const round = result.rounds[0]!;
    expect(round.verdict).toBe('exhausted');
    expect(round.winner).toBeUndefined();
    expect(round.edgeCandidate?.label).toBe('Craw Wurm');
    expect(round.edgeCandidate?.evaluation.verdict).toBe('inconclusive');
    expect(round.edgeCandidate?.evaluation.delta).toBeGreaterThan(0);
    expect(round.rows.length).toBe(11);
    expect(round.rows.every((row) => row.evaluation.verdict === 'inconclusive')).toBe(true);
  });

  it('"keep looking" widens an exhausted singles round to pairs, then stops — still applying nothing', () => {
    const edgeId = pool.getByName('Craw Wurm')?.id ?? '';
    const result = trimDeck(RIGGED, {
      ...sessionOptions,
      gauntletDecks: TWO_OPPONENTS,
      settings: { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking' },
      armRunner: (base) => riggedRunner(base, flatWithEdge(edgeId)),
    });
    // §3.179 — these rows are CONCLUSIVE (the rig proves every one), so the
    // search really is over — a different answer from running out of budget
    // while still unable to read them.
    expect(result.stopped).toBe('no-improvement-conclusive');
    expect(result.rounds.map((r) => r.roundKind)).toEqual(['singles', 'pairs']);
    expect(result.rounds[1]?.rows.every((row) => row.cuts.length === 2)).toBe(true);
    expect(result.applied).toEqual([]);
    expect(deckSizeOf(result.deck)).toBe(63);
  });

  it('"ask" stops after the first improving round with the winner unapplied', () => {
    const result = trimDeck(RIGGED, {
      ...sessionOptions,
      gauntletDecks: TWO_OPPONENTS,
      settings: { targetSize: 60, onImprovement: 'ask', onNoImprovement: 'pause' },
      armRunner: (base) => riggedRunner(base, favouring(SWAMP_ID)),
    });
    expect(result.stopped).toBe('awaiting-apply');
    expect(result.rounds.length).toBe(1);
    expect(result.rounds[0]?.winner?.label).toBe('Swamp');
    expect(deckSizeOf(result.deck)).toBe(63);
    expect(result.applied).toEqual([]);
  });

  it('the rig is honest about what it was: the Swamp arm won 40% of slots outright and nothing else moved', () => {
    const result = trimDeck(RIGGED, {
      ...sessionOptions,
      gauntletDecks: TWO_OPPONENTS,
      settings: { targetSize: 62, onImprovement: 'auto', onNoImprovement: 'pause' },
      armRunner: (base) => riggedRunner(base, favouring(SWAMP_ID)),
    });
    const winner = result.rounds[0]?.winner;
    expect(winner?.evaluation.paired.variantOnly).toBe(16);
    expect(winner?.evaluation.paired.baseOnly).toBe(0);
    expect(winner?.gamesPlayed).toBe(40);
    const others = result.rounds[0]?.rows.filter((row) => row !== winner) ?? [];
    expect(others.every((row) => row.evaluation.paired.variantOnly + row.evaluation.paired.baseOnly === 0)).toBe(true);
  });
});

// --- the plumbing, real games -------------------------------------------------------------

describe('runTrimRound — real games, one opponent, four slots', () => {
  it('measures every removal on a deck one card shorter, never answers a cut for free', () => {
    const report = runTrimRound(RIGGED, {
      gauntletDecks: [loadDeck(UW_CONTROL, pool)],
      pilots,
      pool,
      registry,
      baseSeed: 11,
      round: 0,
      gamesPerCandidate: 4,
      roundKind: 'singles',
      targetSize: 60,
    });
    expect(report.rows.length).toBe(11);
    expect(report.candidatesEvaluated).toBe(11);
    for (const row of report.rows) {
      expect(row.evaluation.nGames).toBe(4);
      expect(row.sizeAfter).toBe(62);
      expect(row.evaluation.copiesSwapped).toBe(1);
      expect(row.evaluation.swap.in).toBe(SWAP_IN_NOTHING);
      // Four games cannot reach a verdict; the report must say so, not guess.
      expect(row.evaluation.verdict).toBe('inconclusive');
    }
    // §3.179 — every row came back inconclusive, so this round has not learned
    // that nothing helps; it has learned NOTHING. That is `'unsure'`, and it is
    // the round that now earns a deeper re-run instead of ending the session.
    expect(report.verdict).toBe('unsure');
    expect(report.edgeCandidate).toBeDefined();
    expect(report.notes.variantGamesSkipped).toBe(0);
    expect(report.notes.identicalGameSkipEnabled).toBe(false);
    expect(report.notes.identicalGameSkipDisabledReason).toBe(TRIM_SKIP_NOT_APPLICABLE);
    // One shared base arm: four base games for the whole round, not four per candidate.
    expect(report.notes.baseGamesPlayed).toBe(4);
    expect(report.notes.variantGamesPlayed).toBe(44);
    expect(report.baseWinRate.n).toBe(4);
    expect(report.reading.explanation).toContain('lands 27/63 at the start');
    expect(report.pairingNote.length).toBeGreaterThan(0);
  });

  it('is deterministic: the same seed reproduces the same tables', () => {
    const run = (): string =>
      JSON.stringify(
        runTrimRound(RIGGED, {
          gauntletDecks: [loadDeck(UW_CONTROL, pool)],
          pilots,
          pool,
          registry,
          baseSeed: 11,
          round: 1,
          gamesPerCandidate: 2,
          roundKind: 'singles',
          targetSize: 60,
        }).rows.map((row) => [row.key, row.evaluation.paired]),
      );
    expect(run()).toBe(run());
  });
});
