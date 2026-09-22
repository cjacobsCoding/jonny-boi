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
  DEFAULT_MAX_CARDS_PER_CUT,
  DEFAULT_TRIM_CONFIG,
  LAND_RATIO_TOLERANCE_LANDS,
  TRIM_CUT_SIZE_ROWS,
  TRIM_CUT_SIZE_ROW_BY_KIND,
  TRIM_FIRST_ROUND_KIND,
  TRIM_MAX_CUT_SIZE,
  TRIM_ROUND_KINDS,
  TRIM_SKIP_NOT_APPLICABLE,
  applyTrimCut,
  binomial,
  deckSizeOf,
  generateTrimCandidates,
  landCutDue,
  landRatioOf,
  nextWideningStep,
  nthCombination,
  prepareTrimRound,
  runTrimRound,
  trimCoverage,
  trimCutSizeLadder,
  trimDeck,
  trimKindForCutSize,
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

  it('pairs are any TWO distinct cards now, not just nonland × land (§3.180)', () => {
    const { candidates } = generateTrimCandidates(RIGGED, pool, { kind: 'pairs', reading: due });
    expect(candidates.length).toBe(DEFAULT_TRIM_CONFIG.maxMultiCutCandidates);
    for (const c of candidates) {
      expect(c.cuts.length).toBe(2);
      expect(c.copiesSwapped).toBe(2);
      expect(c.sizeAfter).toBe(61);
    }
    // THE DISCRIMINATOR for §3.180. Before it, a pair was built as the nonland ×
    // land cross product, so EVERY candidate held exactly one land and a pair of
    // two nonlands was unreachable whatever the deck. Both shapes must appear.
    const nonlandPairs = candidates.filter((c) => c.cuts.every((cut) => !cut.isLand));
    const mixedPairs = candidates.filter((c) => c.cuts.filter((cut) => cut.isLand).length === 1);
    expect(nonlandPairs.length, 'two nonlands together is the shape §3.174 could not reach').toBeGreaterThan(0);
    expect(mixedPairs.length, 'and the nonland+land pair §3.174 DID reach must still be there').toBeGreaterThan(0);

    const capped = generateTrimCandidates(RIGGED, pool, {
      kind: 'pairs',
      reading: due,
      config: { ...DEFAULT_TRIM_CONFIG, maxMultiCutCandidates: 5 },
    });
    expect(capped.candidates.length).toBe(5);
  });

  it('a space small enough to enumerate is enumerated, not sampled — and says so', () => {
    // Four distinct cards is C(4,2) = 6 pairs, under any sane cap: the round is
    // EXACT, and the coverage line must not imply a sample where none happened.
    const small: Deck = {
      name: 'Four Distinct',
      archetype: 'test',
      cards: [
        { cardId: 'Llanowar Elves', count: 4 },
        { cardId: 'Craw Wurm', count: 4 },
        { cardId: 'Forest', count: 52 },
        { cardId: 'Swamp', count: 3 },
      ],
    };
    const { candidates, coverage } = generateTrimCandidates(small, pool, { kind: 'pairs', reading: notDue });
    expect(coverage.possible).toBe(6);
    expect(candidates.length).toBe(6);
    expect(coverage.tried).toBe(6);
    expect(coverage.source).toContain('6 of 6 two-card cuts tried');
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

  it('stops at the ceiling the user set, and the ladder is the denominator (§3.180)', () => {
    // The default ceiling is TWO — the ladder §3.179 shipped — so the default
    // ladder must be exactly [singles, pairs] however many rows the table holds.
    expect(trimCutSizeLadder(DEFAULT_MAX_CARDS_PER_CUT, 63, 60)).toEqual(['singles', 'pairs']);
    expect(TRIM_CUT_SIZE_ROWS.length, 'the TABLE is longer than the default LADDER — that is the point').toBeGreaterThan(
      trimCutSizeLadder(DEFAULT_MAX_CARDS_PER_CUT, 63, 60).length,
    );
    // Raise the ceiling and the ladder actually lengthens.
    expect(nextWideningStep('pairs', 70, 60, 3)).toBe('triples');
    expect(nextWideningStep('triples', 70, 60, 4)).toBe('quads');
    expect(nextWideningStep('pairs', 70, 60, 2)).toBeUndefined();
    // A ceiling outside the table is CLAMPED in one place, never approximated
    // into a row that does not exist.
    expect(trimCutSizeLadder(99, 70, 60).length).toBe(TRIM_CUT_SIZE_ROWS.length);
    expect(trimCutSizeLadder(0, 70, 60)).toEqual(['singles']);
    // And the target still rules rows out, ceiling or no ceiling.
    expect(nextWideningStep('singles', 61, 60, 4)).toBeUndefined();
  });

  it('the derived tables cannot drift from the rows they are derived from', () => {
    // The guard for §3.180's whole shape: one table, everything else derived.
    expect(TRIM_ROUND_KINDS.length).toBe(TRIM_CUT_SIZE_ROWS.length);
    for (const row of TRIM_CUT_SIZE_ROWS) {
      expect(CARDS_PER_CUT[row.kind], `CARDS_PER_CUT drifted from the row for ${row.kind}`).toBe(row.cardsPerCut);
      expect(TRIM_CUT_SIZE_ROW_BY_KIND[row.kind]).toBe(row);
      expect(trimKindForCutSize(row.cardsPerCut)).toBe(row.kind);
    }
    expect(TRIM_FIRST_ROUND_KIND).toBe(TRIM_CUT_SIZE_ROWS[0]?.kind);
    expect(TRIM_MAX_CUT_SIZE).toBe(TRIM_CUT_SIZE_ROWS[TRIM_CUT_SIZE_ROWS.length - 1]?.cardsPerCut);
    // A size with no row REPORTS rather than being widened to its neighbour.
    expect(trimKindForCutSize(TRIM_MAX_CUT_SIZE + 1)).toBeUndefined();
    expect(trimKindForCutSize(0)).toBeUndefined();
  });
});

// --- §3.180 — cutting more than one card at a time --------------------------------------

const CRAW_WURM_ID = pool.getByName('Craw Wurm')?.id ?? 'missing-craw-wurm';
const PELAKKA_ID = pool.getByName('Pelakka Wurm')?.id ?? 'missing-pelakka-wurm';

/** The two readings, at module scope so this whole section can share them. */
const RIGGED_NOT_DUE = landCutDue(27, 63, 27, 63);
const RIGGED_DUE = landCutDue(24, 60, 24, 57);

/**
 * A WHISPER on one card: it wins two extra slots and no more, ever.
 *
 * ⚠️ FIXED SLOTS, NOT A PERIODIC RULE, and the difference is the test. A rig
 * like `slot % 5 === 1` scales its effect with the depth, so the deeper the
 * ladder goes the MORE significant it becomes — and a single card duly proved
 * better at 80 paired games, which made the k = 1 arm of acceptance 2 pass for
 * the wrong reason. Two discordant games out of however many is a whisper at
 * every depth: enough to rank top on observed delta, never enough to call.
 */
const whisperSlots = (slot: number): boolean => slot === 1 || slot === 3;

/**
 * TWO CARDS THAT ARE ONLY BAD TOGETHER — the rig acceptance check 2 turns on.
 *
 * Each ALONE wins a couple of extra slots: enough to rank at the top of a singles
 * round by observed delta, nowhere near enough for Holm to call it. Cut as a
 * PAIR they win 90% of slots outright. Any search that can only evaluate one
 * card at a time is structurally unable to find this, which is the whole reason
 * the feature exists — and both cards are NONLANDS, so §3.174's nonland × land
 * cross product could not have reached the pair either.
 */
const onlyBadTogether =
  (a: string, b: string): Rig =>
  (swap, slot, baseWon) => {
    const outs = swap.out.split(CUT_OUT_SEPARATOR);
    if (outs.length === 2 && outs.includes(a) && outs.includes(b)) return slot % 10 < 9;
    if (outs.length === 1 && (outs[0] === a || outs[0] === b)) return baseWon || whisperSlots(slot);
    return baseWon;
  };

describe('§3.180 acceptance 1 — k = 1 reproduces today’s behaviour exactly', () => {
  it('is every distinct card once, in the old prior order, at the old scores', () => {
    const { candidates, coverage } = generateTrimCandidates(RIGGED, pool, { kind: 'singles', reading: RIGGED_NOT_DUE });
    expect(candidates.length).toBe(11);
    expect(new Set(candidates.map((c) => c.outId)).size).toBe(11);
    for (const c of candidates) {
      expect(c.cuts.length).toBe(1);
      expect(c.sizeAfter).toBe(62);
    }
    // The score is the PRE-§3.180 per-card formula, re-derived here from the
    // weights rather than copied from the implementation.
    const { favouredType, perCopy } = DEFAULT_TRIM_CONFIG.prior;
    for (const c of candidates) {
      const cut = c.cuts[0];
      const count = countIn(RIGGED, cut?.cardId ?? '');
      const expected =
        (cut?.isLand === false ? favouredType : 0) + Math.min(count, DEFAULT_DECK_RULES.maxCopiesNonBasic) * perCopy;
      expect(c.heuristicScore, `${c.outName} scored differently than §3.174 scored it`).toBe(expected);
    }
    // Sorted best-first, ties by name — the old comparator, unchanged.
    for (let i = 1; i < candidates.length; i += 1) {
      const prev = candidates[i - 1];
      const here = candidates[i];
      if (!prev || !here) continue;
      expect(prev.heuristicScore).toBeGreaterThanOrEqual(here.heuristicScore);
      if (prev.heuristicScore === here.heuristicScore) expect(prev.outName < here.outName).toBe(true);
    }
    // A k = 1 round sees the whole space, and says so.
    expect(coverage.possible).toBe(11);
    expect(coverage.tried).toBe(11);
  });

  it('the subset prior equals the old per-card prior on every shape §3.174 could build', () => {
    // §3.180 awards the favoured-type bonus ONCE for the subset instead of once
    // per card. That is only safe because §3.174's pairs were always exactly one
    // nonland and one land — so exactly one part could ever match. This is the
    // check that the claim is true rather than merely plausible.
    const { favouredType, perCopy } = DEFAULT_TRIM_CONFIG.prior;
    for (const reading of [RIGGED_DUE, RIGGED_NOT_DUE]) {
      const pairs = generateTrimCandidates(RIGGED, pool, { kind: 'pairs', reading }).candidates;
      const mixed = pairs.filter((c) => c.cuts.filter((cut) => cut.isLand).length === 1);
      expect(mixed.length).toBeGreaterThan(0);
      for (const c of mixed) {
        const perCard = c.cuts.reduce((sum, cut) => {
          const matches = cut.isLand === (reading.favoured === 'land');
          const count = countIn(RIGGED, cut.cardId);
          return sum + (matches ? favouredType : 0) + Math.min(count, DEFAULT_DECK_RULES.maxCopiesNonBasic) * perCopy;
        }, 0);
        expect(c.heuristicScore, `${c.outName} would have scored ${perCard} under §3.174`).toBe(perCard);
      }
    }
  });
});

describe('§3.180 acceptance 2 — a pair that is only bad TOGETHER', () => {
  it('is in the k = 2 roster, seeded from what the previous round measured', () => {
    const seeded = generateTrimCandidates(RIGGED, pool, {
      kind: 'pairs',
      reading: RIGGED_NOT_DUE,
      seeds: [CRAW_WURM_ID, PELAKKA_ID],
    });
    const pair = seeded.candidates.find(
      (c) => c.cuts.length === 2 && c.cuts.some((x) => x.cardId === CRAW_WURM_ID) && c.cuts.some((x) => x.cardId === PELAKKA_ID),
    );
    expect(pair, 'the seeded pair was not scouted at all').toBeDefined();
    expect(pair?.cuts.every((cut) => !cut.isLand), 'both cards are nonlands — unreachable before §3.180').toBe(true);
  });

  it('k = 2 FINDS it and k = 1 finds neither card — the whole point of the feature', () => {
    const rig = onlyBadTogether(CRAW_WURM_ID, PELAKKA_ID);
    const deep = { ...sessionOptions, gamesPerCandidate: 40 };

    // k = 1: the ceiling is one card, so the ladder cannot widen. Neither card
    // is provably worth cutting on its own, and the session ends having applied
    // nothing at all.
    const singlesOnly = trimDeck(RIGGED, {
      ...deep,
      gauntletDecks: TWO_OPPONENTS,
      settings: { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking', maxCardsPerCut: 1 },
      armRunner: (base) => riggedRunner(base, rig),
    });
    expect(singlesOnly.applied, 'a one-card-at-a-time search must not find this').toEqual([]);
    for (const round of singlesOnly.rounds) expect(round.winner).toBeUndefined();

    // k = 2: the same rig, the same games, the ceiling raised by one.
    const withPairs = trimDeck(RIGGED, {
      ...deep,
      gauntletDecks: TWO_OPPONENTS,
      settings: { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking', maxCardsPerCut: 2 },
      armRunner: (base) => riggedRunner(base, rig),
    });
    const applied = withPairs.applied[0];
    expect(applied, 'k = 2 found nothing — the feature is decoration').toBeDefined();
    expect(applied?.cuts.length).toBe(2);
    expect(applied?.cuts.map((c) => c.cardId).sort()).toEqual([CRAW_WURM_ID, PELAKKA_ID].sort());
    // And the deck really did lose both cards, not one twice.
    expect(deckSizeOf(withPairs.deck)).toBe(61);
    expect(countIn(withPairs.deck, CRAW_WURM_ID)).toBe(countIn(RIGGED, CRAW_WURM_ID) - 1);
    expect(countIn(withPairs.deck, PELAKKA_ID)).toBe(countIn(RIGGED, PELAKKA_ID) - 1);
  });
});

describe('§3.180 acceptance 3 — the coverage line prints a denominator with its source', () => {
  it('counts C(distinct, k) for a known deck, computed independently here', () => {
    // RIGGED holds 11 distinct cards: 9 nonlands + Forest + Swamp.
    // C(11,2) = 55, and 55 is written here as a literal so a broken `binomial`
    // cannot make this test agree with it.
    const { coverage, candidates } = generateTrimCandidates(RIGGED, pool, { kind: 'pairs', reading: RIGGED_DUE });
    expect(coverage.distinctCards).toBe(11);
    expect(coverage.possible).toBe(55);
    expect(binomial(11, 2)).toBe(55);
    expect(coverage.tried).toBe(candidates.length);
    expect(coverage.cardsPerCut).toBe(2);
    expect(coverage.noun).toBe('two-card cuts');
    expect(coverage.source).toContain(`${candidates.length} of 55 two-card cuts tried`);
    expect(coverage.source, 'the denominator must name where it came from').toContain('C(11, 2)');
    // The old cross product could only ever have reached 9 × 2 = 18 of those 55.
    expect(coverage.possible).toBeGreaterThan(9 * 2);
  });

  it('binomial and nthCombination agree, and neither invents a value it cannot give', () => {
    expect(binomial(35, 2)).toBe(595);
    expect(binomial(35, 3)).toBe(6545);
    expect(binomial(5, 0)).toBe(1);
    expect(binomial(3, 5)).toBe(0);
    // Every index in range yields a distinct, ascending, in-range subset...
    const seen = new Set<string>();
    for (let i = 0; i < binomial(7, 3); i += 1) {
      const combo = nthCombination(7, 3, i);
      expect(combo).toBeDefined();
      expect(combo?.length).toBe(3);
      expect(combo).toEqual([...(combo ?? [])].sort((x, y) => x - y));
      expect(combo?.every((v) => v >= 0 && v < 7)).toBe(true);
      seen.add((combo ?? []).join(','));
    }
    expect(seen.size, 'the unranking repeated a subset').toBe(binomial(7, 3));
    // ...and one out of range REPORTS rather than wrapping round.
    expect(nthCombination(7, 3, binomial(7, 3))).toBeUndefined();
    expect(nthCombination(7, 3, -1)).toBeUndefined();
  });

  it('a space too big to count REPORTS that, and does not hang trying to sweep it', () => {
    // ⚠️ THIS TEST EXISTS BECAUSE OF A REAL HAZARD IN THIS FILE, not a
    // hypothetical one. `binomial` returns Infinity past the safe-integer range
    // rather than a silently wrong number — and the sweep picks a stride coprime
    // with the space, which asks for gcd(Infinity, Infinity). `Infinity %
    // Infinity` is NaN and `while (y !== 0)` never ends, so the generator would
    // have spun forever on a deck large enough. The guard is that the sweep is
    // skipped when the space cannot be indexed.
    expect(binomial(100_000, 4)).toBe(Number.POSITIVE_INFINITY);
    const coverage = trimCoverage('quads', 3, 100_000);
    expect(coverage.possible).toBe(Number.POSITIVE_INFINITY);
    expect(coverage.source, 'an uncountable space must not print a number').toContain(
      'more than can be counted',
    );
  });
});

describe('§3.180 acceptance 4 — deck size and the post-cut land ratio', () => {
  it('a k-card cut moves the size by k, and the ratio the prior reads is the POST-cut one', () => {
    // RIGGED is 63 cards, 27 of them lands (24 Forest + 3 Swamp).
    expect(deckSizeOf(RIGGED)).toBe(63);
    expect(landRatioOf(RIGGED, pool)).toEqual({ lands: 27, size: 63 });

    const pairs = generateTrimCandidates(RIGGED, pool, { kind: 'pairs', reading: RIGGED_DUE }).candidates;
    for (const c of pairs) {
      expect(c.sizeAfter).toBe(63 - 2);
      expect(c.ratioAfter.size).toBe(61);
      // The lands it leaves behind depend on what the PAIR was, not on k.
      const landsCut = c.cuts.filter((cut) => cut.isLand).length;
      expect(c.ratioAfter.lands, `${c.outName} mis-reported its post-cut manabase`).toBe(27 - landsCut);
    }
    // The two shapes really do differ, so the assertion above is discriminating.
    expect(new Set(pairs.map((c) => c.ratioAfter.lands)).size).toBeGreaterThan(1);

    const singles = generateTrimCandidates(RIGGED, pool, { kind: 'singles', reading: RIGGED_DUE }).candidates;
    for (const c of singles) {
      expect(c.sizeAfter).toBe(62);
      expect(c.ratioAfter.size).toBe(62);
      expect(c.ratioAfter.lands).toBe(27 - (c.cuts[0]?.isLand ? 1 : 0));
    }
  });
});

describe('§3.180 acceptance 5 — a wider cut is not a bigger bill', () => {
  it('a k = 2 round of the same roster size spends no more games than a k = 1 round', () => {
    const rosterSize = 11; // what a singles round on RIGGED produces
    const common = {
      ...sessionOptions,
      gauntletDecks: TWO_OPPONENTS,
      round: 0,
      targetSize: 60,
      armRunner: (base: Deck) => riggedRunner(base, flatWithEdge(SWAMP_ID)),
    };
    const singles = runTrimRound(RIGGED, { ...common, roundKind: 'singles' });
    const pairs = runTrimRound(RIGGED, {
      ...common,
      roundKind: 'pairs',
      trimConfig: { ...DEFAULT_TRIM_CONFIG, maxMultiCutCandidates: rosterSize },
    });
    // Same roster, so the comparison is about k and nothing else.
    expect(singles.candidatesEvaluated).toBe(rosterSize);
    expect(pairs.candidatesEvaluated).toBe(rosterSize);
    // ASSERTED, not assumed: the games actually run.
    expect(pairs.notes.totalGamesRun).toBeLessThanOrEqual(singles.notes.totalGamesRun);
    expect(singles.notes.totalGamesRun).toBeGreaterThan(0);
  });
});

describe('§3.180 acceptance 6 — a wide round still composes with §3.179', () => {
  it('a k = 2 round whose rows are all unread reports UNSURE and deepens, never “nothing helps”', () => {
    const depths: number[] = [];
    const result = trimDeck(RIGGED, {
      ...sessionOptions,
      gauntletDecks: TWO_OPPONENTS,
      settings: { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking', maxCardsPerCut: 2 },
      armRunner: (base, round) => {
        depths.push(round.plan.maxPairedGames / TWO_OPPONENTS.length);
        // ⚠️ A WHISPER, NOT A DEAD FLAT. A rig where nothing ever differs from
        // the base produces `deadHeat` rows — and a dead heat is CONCLUSIVE:
        // §3.179 is right that more games cannot settle a zero. Rigging it flat
        // therefore tested the opposite of what this check is about. Every row
        // here moves by two games and no more, so every row is genuinely
        // UNREAD rather than genuinely settled.
        return riggedRunner(base, (_swap, slot, baseWon) => baseWon || whisperSlots(slot));
      },
    });
    const pairRounds = result.rounds.filter((r) => r.cardsPerCut === 2);
    expect(pairRounds.length, 'the ladder never reached a k = 2 round').toBeGreaterThan(0);
    for (const round of pairRounds) {
      expect(round.verdict, 'an unread k = 2 round must not claim the question is settled').not.toBe('exhausted');
    }
    expect(result.stopped).not.toBe('no-improvement-conclusive');
    expect(new Set(depths).size, 'the ladder never deepened').toBeGreaterThan(1);
    // And the coverage line rides along on every round, k = 1 and k = 2 alike.
    for (const round of result.rounds) {
      expect(round.coverage.possible).toBeGreaterThan(0);
      expect(round.coverage.source).toContain('tried');
    }
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
    // §3.179 — every row here is inconclusive and the best of them SURVIVED the
    // ladder, so the round has learned nothing rather than learned that nothing
    // helps. That is `'unsure'`.
    expect(round.verdict).toBe('unsure');
    expect(round.winner).toBeUndefined();
    expect(round.edgeCandidate?.label).toBe('Craw Wurm');
    expect(round.edgeCandidate?.evaluation.verdict).toBe('inconclusive');
    expect(round.edgeCandidate?.evaluation.delta).toBeGreaterThan(0);
    expect(round.rows.length).toBe(11);
    expect(round.rows.every((row) => row.evaluation.verdict === 'inconclusive')).toBe(true);
  });

  it('"keep looking" widens singles → pairs, and stops there because the PAIRS are a dead heat', () => {
    const edgeId = pool.getByName('Craw Wurm')?.id ?? '';
    const result = trimDeck(RIGGED, {
      ...sessionOptions,
      gauntletDecks: TWO_OPPONENTS,
      settings: { targetSize: 60, onImprovement: 'auto', onNoImprovement: 'keep-looking' },
      armRunner: (base) => riggedRunner(base, flatWithEdge(edgeId)),
    });
    // ⚠️ THIS IS THE BUG CALEB REPORTED, inverted into a test. This rig leaves
    // every row inconclusive, so before §3.179 the session ran EXACTLY TWO rounds
    // — singles, pairs — and stopped saying `'exhausted'`, having cut nothing.
    // It now widens through the kinds and then DEEPENS, and stops only when it
    // runs out of road, with a reason that says so.
    // ⚠️ TWO ROUNDS IS CORRECT HERE, and it is worth saying why, because "it
    // stopped after two rounds" is the bug §3.179 fixes and this is NOT an
    // instance of it. `flatWithEdge` keys on `swap.out === edgeId`, and a PAIR's
    // `out` is two ids joined — so no pair candidate is the edge, every pair
    // plays byte-identically to the base, and every one is a genuine DEAD HEAT.
    // A dead heat is conclusive: more games cannot create a difference that is
    // not there, so deepening would burn the budget on a settled question. The
    // session that SHOULD deepen is the all-inconclusive one, and that is
    // `trim-ladder.test.ts`'s job.
    expect(result.stopped).toBe('no-improvement-conclusive');
    expect(result.rounds.length).toBe(2);
    expect(result.gamesPerCandidate).toBe(sessionOptions.gamesPerCandidate);
    expect(result.rounds.map((r) => r.roundKind)).toEqual(['singles', 'pairs']);
    // ...and the pairs round really was a dead heat, not merely unread.
    expect(result.rounds[1]?.verdict).toBe('exhausted');
    expect(
      result.rounds[1]?.rows.every(
        (row) => row.elimination !== undefined || row.evaluation.verdictReason === 'deadHeat',
      ),
    ).toBe(true);
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
