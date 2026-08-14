import { describe, expect, it } from 'vitest';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { loadDeck } from './deck.js';
import type { Deck } from './deck.js';
import type { MatchupPilots } from './matchup.js';
import { applySwap } from './swap.js';
import type { CardSwap, SwapEvaluation, SwapVerdict } from './swap.js';
import type { ProportionCI } from './stats.js';
import {
  generateCandidates,
  rankEvaluations,
  suggestSwaps,
} from './suggest.js';
import { DEFAULT_SUGGEST_CONFIG } from './suggest-config.js';
import { DEFAULT_DECK_RULES } from './config.js';
import { MONO_RED_AGGRO, MONO_GREEN_STOMPY, UW_CONTROL } from '../data/decks/index.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function pilot(id: string): Pilot {
  const p = createDefaultAiRegistry().getPilot(id);
  if (!p) throw new Error(`no pilot ${id}`);
  return p;
}
function pilots(id = HEURISTIC_PILOT_ID): MatchupPilots {
  return { pilotA: pilot(id), pilotB: pilot(id) };
}

const green = loadDeck(MONO_GREEN_STOMPY, pool);
const control = loadDeck(UW_CONTROL, pool);

// A tiny synthetic SwapEvaluation builder — lets us test RANKING as a pure
// function over fabricated results, independent of any real game outcome (engine
// v2 will shift real numbers; the ordering contract must not depend on them).
function fakeEval(
  out: string,
  inCard: string,
  delta: number,
  pValue: number,
  verdict: SwapVerdict,
): SwapEvaluation {
  const ci: ProportionCI = { p: 0.5 + delta, low: 0, high: 1, successes: 50, n: 100 };
  const swap: CardSwap = { out, in: inCard };
  return {
    baseDeck: 'Base',
    variantDeck: 'Variant',
    swap,
    outName: out,
    inName: inCard,
    baseWinRate: { p: 0.5, low: 0, high: 1, successes: 50, n: 100 },
    variantWinRate: ci,
    delta,
    ci,
    pValue,
    paired: { bothWon: 0, baseOnly: 0, variantOnly: 0, neither: 0 },
    mcNemar: { statistic: 0, pValue, variantOnly: 0, baseOnly: 0, discordant: 0 },
    verdict,
    nGames: 100,
  };
}

describe('generateCandidates (pure)', () => {
  it('never proposes adding a card already at the 4-of limit', () => {
    // Lightning Bolt is a 4-of in Mono-Red; it must not appear as an `in` candidate.
    const { candidates } = generateCandidates(MONO_RED_AGGRO, pool);
    expect(candidates.some((c) => c.inName === 'Lightning Bolt')).toBe(false);
  });

  it('every generated candidate yields a still-legal 60-card deck', () => {
    const { candidates } = generateCandidates(MONO_RED_AGGRO, pool);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      const variant: Deck = applySwap(MONO_RED_AGGRO, { out: c.outId, in: c.inId }, pool);
      const loaded = loadDeck(variant, pool);
      expect(loaded.size).toBe(60);
    }
  });

  it('never proposes a self-swap (out === in)', () => {
    const { candidates } = generateCandidates(MONO_RED_AGGRO, pool);
    expect(candidates.every((c) => c.outId !== c.inId)).toBe(true);
  });

  it('respects the basic-land floor: will not cut Mountains below the kept minimum', () => {
    // Mono-Red runs 44 Mountains; cutting one stays well above the floor, so it IS
    // a candidate. But a deck already at the floor must never offer that cut.
    const atFloor: Deck = {
      name: 'Floor test',
      archetype: 'test',
      cards: [
        { cardId: 'Goblin Guide', count: 4 },
        { cardId: 'Monastery Swiftspear', count: 4 },
        { cardId: 'Young Pyromancer', count: 4 },
        { cardId: 'Lightning Bolt', count: 4 },
        { cardId: 'Mountain', count: DEFAULT_SUGGEST_CONFIG.minBasicLandsKept },
        { cardId: 'Forest', count: 60 - 16 - DEFAULT_SUGGEST_CONFIG.minBasicLandsKept },
      ],
    };
    const { candidates } = generateCandidates(atFloor, pool);
    expect(candidates.some((c) => c.outName === 'Mountain')).toBe(false);
  });

  it('focused mode restricts the cut set to the named cards', () => {
    const { candidates } = generateCandidates(MONO_RED_AGGRO, pool, undefined, undefined, undefined, {
      cutOnly: ['Goblin Guide'],
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.outName === 'Goblin Guide')).toBe(true);
  });

  it('focused mode restricts the in set to the shortlist', () => {
    const { candidates } = generateCandidates(MONO_RED_AGGRO, pool, undefined, undefined, undefined, {
      inOnly: ['Sol Ring'],
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.inName === 'Sol Ring')).toBe(true);
  });

  it('orders candidates by descending heuristic score (cap-relevant ordering)', () => {
    const { candidates } = generateCandidates(MONO_RED_AGGRO, pool);
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i - 1]!.heuristicScore).toBeGreaterThanOrEqual(candidates[i]!.heuristicScore);
    }
  });
});

describe('rankEvaluations (pure ordering contract)', () => {
  it('sorts proven-better above inconclusive above proven-worse', () => {
    const evals = [
      fakeEval('a', 'b', -0.1, 0.01, 'worse'),
      fakeEval('c', 'd', 0.0, 0.9, 'inconclusive'),
      fakeEval('e', 'f', 0.2, 0.001, 'better'),
    ];
    const ranked = rankEvaluations(evals);
    expect(ranked.map((e) => e.verdict)).toEqual(['better', 'inconclusive', 'worse']);
  });

  it('within the better bucket, larger delta ranks first', () => {
    const evals = [
      fakeEval('a', 'b', 0.05, 0.04, 'better'),
      fakeEval('c', 'd', 0.20, 0.04, 'better'),
      fakeEval('e', 'f', 0.12, 0.04, 'better'),
    ];
    const ranked = rankEvaluations(evals);
    expect(ranked.map((e) => e.delta)).toEqual([0.2, 0.12, 0.05]);
  });

  it('breaks delta ties by the smaller p-value (stronger signal first)', () => {
    const evals = [
      fakeEval('a', 'b', 0.1, 0.04, 'better'),
      fakeEval('c', 'd', 0.1, 0.001, 'better'),
    ];
    const ranked = rankEvaluations(evals);
    expect(ranked[0]!.pValue).toBe(0.001);
  });

  it('is deterministic and stable for fully-tied entries (swap-key tiebreak)', () => {
    const evals = [
      fakeEval('z', 'y', 0.1, 0.04, 'better'),
      fakeEval('a', 'b', 0.1, 0.04, 'better'),
    ];
    const ranked = rankEvaluations(evals);
    expect(ranked.map((e) => e.swap.out)).toEqual(['a', 'z']);
  });

  it('does not mutate its input', () => {
    const evals = [fakeEval('a', 'b', -0.1, 0.5, 'worse'), fakeEval('c', 'd', 0.1, 0.01, 'better')];
    const before = evals.map((e) => e.swap.out);
    rankEvaluations(evals);
    expect(evals.map((e) => e.swap.out)).toEqual(before);
  });

  it('breaks full ties by CODE UNIT, not locale collation (host-independent order)', () => {
    // The final tiebreak used `localeCompare`, whose ordering depends on the host's
    // locale and ICU build: it sorts "a" before "B" (case-insensitive-ish collation)
    // while code-unit order puts "B" (0x42) before "a" (0x61). Two machines could
    // therefore rank the same run differently — a silent break of "same inputs +
    // seed ⇒ same ranking". These two entries are identical apart from their key.
    const evals = [fakeEval('a', 'x', 0.1, 0.04, 'better'), fakeEval('B', 'x', 0.1, 0.04, 'better')];
    expect(rankEvaluations(evals).map((e) => e.swap.out)).toEqual(['B', 'a']);
  });
});

// --- regression: candidate counting is PER CARD, not per decklist line ----------

/**
 * A card can legitimately occupy two decklist lines — `applySwap` itself splits the
 * line it cuts from, so a suggested swap fed back into the deck produces exactly
 * that shape. Counting cuttables per LINE then broke two ways: the same card was
 * emitted as a cut candidate once per line (duplicate evaluations, wasted sim
 * budget, duplicate rows in the report), and the basic-land floor was compared
 * against a single line instead of the deck's real total, so a deck with plenty of
 * Mountains split across lines was refused any Mountain cut at all.
 */
describe('generateCandidates — counts copies per card, not per line (regression)', () => {
  /** 60 cards; Goblin Guide and Mountain are each split across two lines. */
  const splitLines: Deck = {
    name: 'Split lines',
    archetype: 'test',
    cards: [
      { cardId: 'Goblin Guide', count: 2 },
      { cardId: 'Goblin Guide', count: 2 },
      { cardId: 'Lightning Bolt', count: 4 },
      { cardId: 'Mountain', count: 10 },
      { cardId: 'Mountain', count: 15 },
      { cardId: 'Forest', count: 27 },
    ],
  };

  it('emits each (out, in) pair exactly once even when a card spans two lines', () => {
    const { candidates } = generateCandidates(splitLines, pool);
    const keys = candidates.map((c) => `${c.outId}>${c.inId}`);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('measures the basic-land floor against the deck total, not one line', () => {
    // 10 + 15 = 25 Mountains, comfortably above the floor → cutting one is legal.
    // Per-line counting saw 10 and 15, both under the floor, and offered no cut.
    expect(DEFAULT_SUGGEST_CONFIG.minBasicLandsKept).toBeLessThan(25);
    const { candidates } = generateCandidates(splitLines, pool);
    expect(candidates.some((c) => c.outName === 'Mountain')).toBe(true);
  });

  it('still refuses the cut when the split lines TOTAL to the floor', () => {
    const atFloor: Deck = {
      name: 'At floor, split',
      archetype: 'test',
      cards: [
        { cardId: 'Goblin Guide', count: 4 },
        { cardId: 'Lightning Bolt', count: 4 },
        { cardId: 'Mountain', count: 9 },
        { cardId: 'Mountain', count: DEFAULT_SUGGEST_CONFIG.minBasicLandsKept - 9 },
        { cardId: 'Forest', count: 60 - 8 - DEFAULT_SUGGEST_CONFIG.minBasicLandsKept },
      ],
    };
    const { candidates } = generateCandidates(atFloor, pool);
    expect(candidates.some((c) => c.outName === 'Mountain')).toBe(false);
  });

  it('totals split lines when deciding a card is already a 4-of (never an add)', () => {
    const { candidates } = generateCandidates(splitLines, pool);
    expect(candidates.some((c) => c.inName === 'Goblin Guide')).toBe(false);
  });
});

describe('suggestSwaps (end-to-end, tiny + fast)', () => {
  const baseOpts = {
    gauntletDecks: [green, control],
    pilots: pilots(),
    pool,
    registry,
    baseSeed: 7,
  };

  it('returns a well-formed report on a tiny focused candidate set', () => {
    // Focus on one cut + one in candidate → exactly one cheap evaluation.
    const report = suggestSwaps(MONO_RED_AGGRO, {
      ...baseOpts,
      gamesPerCandidate: 4,
      cutOnly: ['Young Pyromancer'],
      inOnly: ['Sol Ring'],
    });
    expect(report.baseDeck).toBe('Mono-Red Aggro');
    expect(report.candidatesEvaluated).toBe(1);
    expect(report.suggestions).toHaveLength(1);
    expect(report.suggestions[0]!.rank).toBe(1);
    expect(report.suggestions[0]!.outName).toBe('Young Pyromancer');
    expect(report.suggestions[0]!.inName).toBe('Sol Ring');
    expect(report.notes.totalGamesRun).toBeGreaterThan(0);
    expect(report.notes.fidelityCaveat).toMatch(/simplified subset/);
  });

  it('is deterministic: same inputs + seed reproduce the identical ranking', () => {
    const opts = {
      ...baseOpts,
      gamesPerCandidate: 4,
      cutOnly: ['Goblin Guide', 'Young Pyromancer'],
      inOnly: ['Sol Ring', 'Birds of Paradise'],
    };
    const a = suggestSwaps(MONO_RED_AGGRO, opts);
    const b = suggestSwaps(MONO_RED_AGGRO, opts);
    expect(a.suggestions.map((s) => `${s.outName}>${s.inName}:${s.evaluation.delta}`)).toEqual(
      b.suggestions.map((s) => `${s.outName}>${s.inName}:${s.evaluation.delta}`),
    );
    expect(a.candidatesEvaluated).toBe(b.candidatesEvaluated);
  });

  it('honours the candidate cap and records the overflow as skipped (no silent truncation)', () => {
    const report = suggestSwaps(MONO_RED_AGGRO, {
      ...baseOpts,
      gamesPerCandidate: 2,
      suggestConfig: { ...DEFAULT_SUGGEST_CONFIG, maxCandidates: 2 },
    });
    expect(report.candidatesEvaluated).toBe(2);
    expect(report.notes.cappedByBudget).toBe(true);
    expect(report.skipped.some((s) => s.reason === 'capped')).toBe(true);
    // Coverage must add up EXACTLY: every candidate we generated is either
    // evaluated or listed in `skipped`. `candidatesGenerated` was derived after the
    // evaluation loop had already appended its own failures to the skip list, so a
    // candidate that generated cleanly and then threw was counted twice and the
    // total no longer reconciled — in a figure whose whole job is honest coverage.
    expect(report.notes.candidatesGenerated).toBe(report.candidatesEvaluated + report.skipped.length);
  });

  it('evaluates candidates under the CALLER\'s deck rules, not the defaults', () => {
    // `suggestSwaps` vetted candidates with `deckRules` but `evaluateSwap` re-loaded
    // the variant under DEFAULT_DECK_RULES, so a caller running a smaller format got
    // every candidate rejected as "illegal" and an empty report with no real reason.
    const fortyCardRules = { ...DEFAULT_DECK_RULES, minDeckSize: 40 };
    const smallDeck: Deck = {
      name: 'Forty-card brew',
      archetype: 'test',
      cards: [
        { cardId: 'Goblin Guide', count: 4 },
        { cardId: 'Monastery Swiftspear', count: 4 },
        { cardId: 'Young Pyromancer', count: 4 },
        { cardId: 'Lightning Bolt', count: 4 },
        { cardId: 'Mountain', count: 24 },
      ],
    };
    const report = suggestSwaps(smallDeck, {
      ...baseOpts,
      gamesPerCandidate: 2,
      deckRules: fortyCardRules,
      cutOnly: ['Young Pyromancer'],
      inOnly: ['Sol Ring'],
    });
    expect(report.candidatesEvaluated).toBe(1);
    expect(report.skipped).toHaveLength(0);
    expect(report.suggestions[0]!.evaluation.nGames).toBeGreaterThan(0);
  });

  it('zero valid candidates yields a clear, well-formed empty report', () => {
    // Ask to cut a card that isn't in the deck → nothing to evaluate.
    const report = suggestSwaps(MONO_RED_AGGRO, {
      ...baseOpts,
      gamesPerCandidate: 2,
      cutOnly: ['Counterspell'],
    });
    expect(report.candidatesEvaluated).toBe(0);
    expect(report.suggestions).toHaveLength(0);
    expect(report.notes.totalGamesRun).toBe(0);
  });

  it('ranked suggestions are globally ordered better → inconclusive → worse', () => {
    const report = suggestSwaps(MONO_RED_AGGRO, {
      ...baseOpts,
      gamesPerCandidate: 6,
      suggestConfig: { ...DEFAULT_SUGGEST_CONFIG, maxCandidates: 5 },
    });
    const order = { better: 0, inconclusive: 1, worse: 2 } as const;
    const ords = report.suggestions.map((s) => order[s.evaluation.verdict]);
    for (let i = 1; i < ords.length; i++) {
      expect(ords[i - 1]!).toBeLessThanOrEqual(ords[i]!);
    }
  });
});
