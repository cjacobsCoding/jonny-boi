/**
 * The adaptive search: the wave plan, the elimination rules, the cross-run record,
 * and the end-to-end behaviour the bug report asked for —
 *
 *   "I ran it on a test deck and it chose Eternal Witness and then tried to find a
 *    better card than that, but all were worse or inconclusive. So I ran it again,
 *    hoping it would find a better card — and it just started comparing to Eternal
 *    Witness AGAIN."
 *
 * The scheduling and exploration rules are PURE, so most of this suite runs against
 * fabricated numbers with no sim at all (fast, and independent of how the engine's
 * real win-rates move). The end-to-end cases at the bottom use tiny game counts and
 * assert behaviour — a second run explores different candidates; the adaptive
 * search costs far fewer games than the fixed sweep — rather than pinning exact
 * win-rates that legitimately shift when the engine improves.
 */

import { describe, expect, it } from 'vitest';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { loadDeck } from './deck.js';
import type { Deck } from './deck.js';
import type { MatchupPilots } from './matchup.js';
import type { PairedTable } from './stats.js';
import {
  planWaves,
  prioritiseCandidates,
  relatedness,
  selectOffspring,
  selectSurvivors,
  type ArmStanding,
  type PriorEvidence,
  type SchedulableCandidate,
} from './suggest-schedule.js';
import {
  acceptHistory,
  candidateKey,
  deckFingerprint,
  emptyHistory,
  isSettled,
  mergeHistory,
  SUGGESTION_HISTORY_VERSION,
  type CandidateHistory,
  type SuggestionHistory,
} from './suggest-history.js';
import {
  DEFAULT_ADAPTIVE_CONFIG,
  DEFAULT_EXPLORATION_WEIGHTS,
  DEFAULT_SUGGEST_CONFIG,
} from './suggest-config.js';
import { DEFAULT_STATS_CONFIG } from './config.js';
import { suggestSwaps } from './suggest.js';
import { MONO_RED_AGGRO, MONO_GREEN_STOMPY, UW_CONTROL } from '../data/decks/index.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function pilot(id: string): Pilot {
  const p = createDefaultAiRegistry().getPilot(id);
  if (!p) throw new Error(`no pilot ${id}`);
  return p;
}
function pilots(): MatchupPilots {
  return { pilotA: pilot(HEURISTIC_PILOT_ID), pilotB: pilot(HEURISTIC_PILOT_ID) };
}

// --- the wave plan (pure) --------------------------------------------------------

describe('planWaves', () => {
  it('lands the FINAL wave exactly on the full budget', () => {
    // Non-negotiable: the candidate that wins must be measured as deeply as the
    // fixed scheme would have measured it. All the savings come from the losers.
    const plan = planWaves(24, 420, DEFAULT_ADAPTIVE_CONFIG);
    expect(plan[plan.length - 1]!.cumulativeGames).toBe(420);
  });

  it('halves the field while doubling the games', () => {
    const plan = planWaves(24, 420, DEFAULT_ADAPTIVE_CONFIG);
    expect(plan.length).toBeGreaterThan(1);
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i]!.cumulativeGames).toBeGreaterThan(plan[i - 1]!.cumulativeGames);
      expect(plan[i]!.survivorTarget).toBeLessThanOrEqual(plan[i - 1]!.survivorTarget);
    }
    // Scouting is cheap: the first wave costs a small fraction of full depth.
    expect(plan[0]!.cumulativeGames).toBeLessThan(420 / 4);
  });

  it('never plans a wave below the minimum useful batch', () => {
    const plan = planWaves(64, 100, DEFAULT_ADAPTIVE_CONFIG);
    for (const wave of plan) {
      expect(wave.cumulativeGames).toBeGreaterThanOrEqual(
        Math.min(DEFAULT_ADAPTIVE_CONFIG.minGamesPerWave, 100),
      );
    }
  });

  it('collapses to a single full-depth wave when the budget is tiny', () => {
    const plan = planWaves(20, 8, DEFAULT_ADAPTIVE_CONFIG);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.cumulativeGames).toBe(8);
  });

  it('never plans more than maxWaves, however large the roster', () => {
    const plan = planWaves(5000, 100000, DEFAULT_ADAPTIVE_CONFIG);
    expect(plan.length).toBeLessThanOrEqual(DEFAULT_ADAPTIVE_CONFIG.maxWaves);
  });

  it('is total: a single candidate still gets a plan', () => {
    const plan = planWaves(1, 420, DEFAULT_ADAPTIVE_CONFIG);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.cumulativeGames).toBe(420);
  });
});

// --- elimination (pure) ----------------------------------------------------------

function standing(key: string, variantOnly: number, baseOnly: number, games = 60): ArmStanding {
  const paired: PairedTable = {
    variantOnly,
    baseOnly,
    bothWon: Math.max(0, Math.floor((games - variantOnly - baseOnly) / 2)),
    neither: Math.max(0, games - variantOnly - baseOnly - Math.floor((games - variantOnly - baseOnly) / 2)),
  };
  return { key, gamesPlayed: games, paired };
}

describe('selectSurvivors', () => {
  it('retires an arm whose OPTIMISTIC bound is still below break-even', () => {
    // 2 of 22 discordant games: even the generous end of its interval is nowhere
    // near even, so more games cannot rescue it. That is "proven not better",
    // which is a stronger and more honest claim than "ranked low".
    const hopeless = standing('hopeless', 2, 20);
    const fine = standing('fine', 12, 10);
    const cut = selectSurvivors([hopeless, fine], 1, 2, DEFAULT_ADAPTIVE_CONFIG, DEFAULT_STATS_CONFIG);

    expect(cut.survivors.map((s) => s.key)).toEqual(['fine']);
    const dropped = cut.eliminated.find((e) => e.key === 'hopeless');
    expect(dropped?.reason).toBe('futile');
    expect(dropped?.detail).toMatch(/below break-even/);
    expect(dropped?.gamesPlayed).toBe(60);
  });

  it('will not retire an arm that has too few discordant pairs to judge', () => {
    // One discordant loss is not evidence of anything; the futility rule must wait.
    const barelyPlayed = standing('barely', 0, 1, 4);
    const cut = selectSurvivors([barelyPlayed], 1, 5, DEFAULT_ADAPTIVE_CONFIG, DEFAULT_STATS_CONFIG);
    expect(cut.eliminated).toHaveLength(0);
    expect(cut.survivors).toHaveLength(1);
  });

  it('cuts the field to the survivor target, best paired advantage first', () => {
    const arms = [standing('a', 10, 9), standing('b', 20, 5), standing('c', 14, 8)];
    const cut = selectSurvivors(arms, 2, 2, DEFAULT_ADAPTIVE_CONFIG, DEFAULT_STATS_CONFIG);
    expect(cut.survivors.map((s) => s.key)).toEqual(['b', 'c']);
    expect(cut.eliminated.map((e) => e.reason)).toEqual(['outranked']);
    // 'Outranked' claims only that the budget buys more elsewhere — not that the
    // arm is bad. The wording in the report has to reflect that.
    expect(cut.eliminated[0]!.detail).toMatch(/ranked below/);
  });

  it('breaks ties deterministically by key, so the search is reproducible', () => {
    const arms = [standing('zzz', 12, 10), standing('aaa', 12, 10)];
    const first = selectSurvivors(arms, 1, 1, DEFAULT_ADAPTIVE_CONFIG, DEFAULT_STATS_CONFIG);
    const second = selectSurvivors([...arms].reverse(), 1, 1, DEFAULT_ADAPTIVE_CONFIG, DEFAULT_STATS_CONFIG);
    expect(first.survivors.map((s) => s.key)).toEqual(['aaa']);
    expect(second.survivors.map((s) => s.key)).toEqual(first.survivors.map((s) => s.key));
  });
});

// --- exploitation (pure) ---------------------------------------------------------

function candidate(outId: string, inId: string, traits?: Partial<SchedulableCandidate['traits']>): SchedulableCandidate {
  return {
    key: candidateKey(outId, inId),
    outId,
    inId,
    heuristicScore: 1,
    traits: { colorKey: 'R', manaValue: 3, role: 'creature', ...traits },
  };
}

describe('relatedness + selectOffspring (leaning into what worked)', () => {
  it('ranks the same add above the same cut above merely similar cards', () => {
    const leader = candidate('cutA', 'addA');
    const sameAdd = candidate('cutB', 'addA');
    const sameCut = candidate('cutA', 'addB');
    const similar = candidate('cutC', 'addC');
    const unrelated = candidate('cutD', 'addD', { colorKey: 'U', manaValue: 1, role: 'instant' });

    const w = DEFAULT_EXPLORATION_WEIGHTS;
    expect(relatedness(sameAdd, leader, w)).toBeGreaterThan(relatedness(sameCut, leader, w));
    expect(relatedness(sameCut, leader, w)).toBeGreaterThan(relatedness(similar, leader, w));
    expect(relatedness(unrelated, leader, w)).toBe(0);
  });

  it('never counts a candidate as related to itself', () => {
    const c = candidate('cutA', 'addA');
    expect(relatedness(c, c, DEFAULT_EXPLORATION_WEIGHTS)).toBe(0);
  });

  it('pulls in the most related untried candidates, and nothing unrelated', () => {
    const leaders = [candidate('cutA', 'addA')];
    const untried = [
      candidate('cutZ', 'addA'), // same add as the leader
      candidate('cutA', 'addZ'), // same cut as the leader
      candidate('cutQ', 'addQ', { colorKey: 'W', manaValue: 6, role: 'enchantment' }), // unrelated
    ];
    const picked = selectOffspring(leaders, untried, 2, DEFAULT_EXPLORATION_WEIGHTS);
    expect(picked.map((c) => c.key)).toEqual([candidateKey('cutZ', 'addA'), candidateKey('cutA', 'addZ')]);
  });

  it('returns nothing when there are no leaders or no budget for offspring', () => {
    const untried = [candidate('cutZ', 'addA')];
    expect(selectOffspring([], untried, 2, DEFAULT_EXPLORATION_WEIGHTS)).toEqual([]);
    expect(selectOffspring([candidate('cutA', 'addA')], untried, 0, DEFAULT_EXPLORATION_WEIGHTS)).toEqual([]);
  });
});

// --- prioritisation across runs (pure) -------------------------------------------

describe('prioritiseCandidates (why run two is not run one)', () => {
  const untriedCandidate = candidate('cut1', 'add1');
  const promising = candidate('cut2', 'add2');
  const alsoTried = candidate('cut3', 'add3');
  const settledLoser = candidate('cut4', 'add4');

  const priors = new Map<string, PriorEvidence>([
    [promising.key, { gamesPlayed: 26, delta: 0.03, settled: false }],
    [alsoTried.key, { gamesPlayed: 26, delta: -0.01, settled: false }],
    [settledLoser.key, { gamesPlayed: 420, delta: -0.04, settled: true }],
  ]);

  it('puts never-tried candidates first — the actual fix for the reported bug', () => {
    const ordered = prioritiseCandidates(
      [alsoTried, promising, untriedCandidate],
      priors,
      DEFAULT_EXPLORATION_WEIGHTS,
    );
    expect(ordered[0]!.candidate.key).toBe(untriedCandidate.key);
    expect(ordered[0]!.reasons).toContain('never tried');
  });

  it('refines a promising candidate ahead of one that showed nothing', () => {
    const ordered = prioritiseCandidates([alsoTried, promising], priors, DEFAULT_EXPLORATION_WEIGHTS);
    expect(ordered[0]!.candidate.key).toBe(promising.key);
    expect(ordered[0]!.reasons[0]).toMatch(/promising/);
  });

  it('flags settled losers so they are reported, not silently re-tested', () => {
    const ordered = prioritiseCandidates([settledLoser, untriedCandidate], priors, DEFAULT_EXPLORATION_WEIGHTS);
    const settled = ordered.find((p) => p.candidate.key === settledLoser.key);
    expect(settled?.settled).toBe(true);
    expect(settled?.reasons[0]).toMatch(/settled after 420 games/);
  });

  it('with no history at all, orders exactly as the cheap prior does', () => {
    const strong = { ...candidate('cutA', 'addA'), heuristicScore: 2 };
    const weak = { ...candidate('cutB', 'addB'), heuristicScore: 1 };
    const ordered = prioritiseCandidates([weak, strong], new Map(), DEFAULT_EXPLORATION_WEIGHTS);
    expect(ordered.map((p) => p.candidate.key)).toEqual([strong.key, weak.key]);
  });
});

// --- the serializable record ------------------------------------------------------

function historyEntry(overrides: Partial<CandidateHistory> = {}): CandidateHistory {
  return {
    outId: 'out',
    inId: 'in',
    outName: 'Out',
    inName: 'In',
    gamesPlayed: 26,
    delta: -0.01,
    verdict: 'inconclusive',
    provenNotBetter: false,
    runs: 1,
    settled: false,
    ...overrides,
  };
}

describe('the cross-run search record', () => {
  it('is plain JSON — it round-trips through stringify/parse unchanged', () => {
    // The web Lab persists this verbatim; a Map or a Set here would silently
    // become `{}` on the way to localStorage.
    const history = mergeHistory(
      emptyHistory(MONO_RED_AGGRO),
      [
        {
          outId: 'a',
          inId: 'b',
          outName: 'A',
          inName: 'B',
          gamesPlayed: 26,
          delta: 0.02,
          verdict: 'inconclusive',
          provenNotBetter: false,
        },
      ],
      DEFAULT_EXPLORATION_WEIGHTS,
    );
    expect(JSON.parse(JSON.stringify(history))).toEqual(history);
    expect(history.version).toBe(SUGGESTION_HISTORY_VERSION);
    expect(history.runsCompleted).toBe(1);
  });

  it('accumulates games across runs but keeps only the latest run\'s statistics', () => {
    // Games from different runs are different games (the run counter offsets the
    // seed), so the budget spent adds up — but p-values may never be pooled across
    // runs, so delta/verdict are the newest run's alone.
    const first = mergeHistory(
      emptyHistory(MONO_RED_AGGRO),
      [{ outId: 'a', inId: 'b', outName: 'A', inName: 'B', gamesPlayed: 26, delta: -0.02, verdict: 'inconclusive', provenNotBetter: false }],
      DEFAULT_EXPLORATION_WEIGHTS,
    );
    const second = mergeHistory(
      first,
      [{ outId: 'a', inId: 'b', outName: 'A', inName: 'B', gamesPlayed: 52, delta: 0.05, verdict: 'better', provenNotBetter: false }],
      DEFAULT_EXPLORATION_WEIGHTS,
    );
    const entry = second.candidates[0] as CandidateHistory;
    expect(entry.gamesPlayed).toBe(78);
    expect(entry.delta).toBe(0.05);
    expect(entry.verdict).toBe('better');
    expect(entry.runs).toBe(2);
    expect(second.runsCompleted).toBe(2);
  });

  it('never un-proves a candidate that was shown not to be better', () => {
    const first = mergeHistory(
      emptyHistory(MONO_RED_AGGRO),
      [{ outId: 'a', inId: 'b', outName: 'A', inName: 'B', gamesPlayed: 26, delta: -0.05, verdict: 'worse', provenNotBetter: true }],
      DEFAULT_EXPLORATION_WEIGHTS,
    );
    const second = mergeHistory(
      first,
      [{ outId: 'a', inId: 'b', outName: 'A', inName: 'B', gamesPlayed: 26, delta: 0.01, verdict: 'inconclusive', provenNotBetter: false }],
      DEFAULT_EXPLORATION_WEIGHTS,
    );
    expect((second.candidates[0] as CandidateHistory).provenNotBetter).toBe(true);
    expect((second.candidates[0] as CandidateHistory).settled).toBe(true);
  });

  it('settles a candidate that had a fair hearing and never looked promising', () => {
    const w = DEFAULT_EXPLORATION_WEIGHTS;
    expect(isSettled(historyEntry({ gamesPlayed: w.settledAfterGames, delta: -0.01 }), w)).toBe(true);
    expect(isSettled(historyEntry({ gamesPlayed: w.settledAfterGames, delta: 0.05 }), w)).toBe(false);
    expect(isSettled(historyEntry({ gamesPlayed: 4, delta: -0.01 }), w)).toBe(false);
    expect(isSettled(historyEntry({ provenNotBetter: true, gamesPlayed: 4 }), w)).toBe(true);
  });

  it('ignores a record gathered on a DIFFERENT decklist', () => {
    // A swap's measured effect is a property of the deck it was measured in, so
    // stale evidence must be dropped — loudly, with a reason, not silently applied.
    const changed: Deck = {
      ...MONO_RED_AGGRO,
      cards: [...MONO_RED_AGGRO.cards.slice(1), { cardId: 'Sol Ring', count: 1 }],
    };
    const accepted = acceptHistory(emptyHistory(MONO_RED_AGGRO), changed);
    expect(accepted.rejected).toBe('deck-changed');
    expect(accepted.history.candidates).toHaveLength(0);
  });

  it('ignores a record written by an incompatible version', () => {
    const stale = { ...emptyHistory(MONO_RED_AGGRO), version: 999 } as SuggestionHistory;
    expect(acceptHistory(stale, MONO_RED_AGGRO).rejected).toBe('version');
  });

  it('keys the fingerprint on CONTENT, not decklist order or deck name', () => {
    const reordered: Deck = { ...MONO_RED_AGGRO, name: 'Renamed', cards: [...MONO_RED_AGGRO.cards].reverse() };
    expect(deckFingerprint(reordered)).toBe(deckFingerprint(MONO_RED_AGGRO));
  });
});

// --- end to end -------------------------------------------------------------------

describe('suggestSwaps — adaptive end to end', () => {
  const baseOpts = {
    gauntletDecks: [loadDeck(MONO_GREEN_STOMPY, pool), loadDeck(UW_CONTROL, pool)],
    pilots: pilots(),
    pool,
    registry,
    baseSeed: 4242,
    gamesPerCandidate: 4,
    suggestConfig: { ...DEFAULT_SUGGEST_CONFIG, maxCandidates: 6 },
  };

  it('costs far fewer games than the fixed sweep for the same roster and depth', () => {
    const adaptive = suggestSwaps(MONO_RED_AGGRO, baseOpts);
    const fixed = suggestSwaps(MONO_RED_AGGRO, { ...baseOpts, adaptive: false });

    expect(adaptive.notes.totalGamesRun).toBeLessThan(fixed.notes.totalGamesRun);
    // The saving is reported, not implied.
    expect(adaptive.notes.gamesAvoided).toBeGreaterThan(0);
    // The base arm is played once for the whole run, not once per candidate.
    expect(adaptive.notes.baseGamesPlayed).toBeLessThan(fixed.notes.baseGamesPlayed);
  });

  it('reports how many games EACH candidate actually got', () => {
    const report = suggestSwaps(MONO_RED_AGGRO, baseOpts);
    expect(report.suggestions.length).toBeGreaterThan(0);
    for (const s of report.suggestions) {
      expect(s.gamesPlayed).toBeGreaterThan(0);
      expect(s.gamesPlayed).toBe(s.evaluation.nGames);
    }
  });

  it('accounts for every generated candidate — evaluated or explained', () => {
    const report = suggestSwaps(MONO_RED_AGGRO, baseOpts);
    expect(report.notes.candidatesGenerated).toBe(report.candidatesEvaluated + report.skipped.length);
    for (const s of report.skipped) expect(['illegal', 'capped', 'settled']).toContain(s.reason);
  });

  it('corrects the reported verdict for multiple comparisons', () => {
    const report = suggestSwaps(MONO_RED_AGGRO, baseOpts);
    expect(report.multipleComparisons.method).toBe('holm');
    expect(report.multipleComparisons.familySize).toBeGreaterThanOrEqual(report.candidatesEvaluated);
    for (const s of report.suggestions) {
      // The correction can only make a claim weaker, never stronger.
      expect(s.adjustedPValue).toBeGreaterThanOrEqual(s.rawPValue);
      if (s.evaluation.verdict !== 'inconclusive') expect(s.adjustedPValue).toBeLessThan(DEFAULT_STATS_CONFIG.alpha);
    }
  });

  it('is deterministic: same inputs + seed + history reproduce the identical run', () => {
    const a = suggestSwaps(MONO_RED_AGGRO, baseOpts);
    const b = suggestSwaps(MONO_RED_AGGRO, baseOpts);
    const shape = (r: typeof a) =>
      r.suggestions.map((s) => `${s.outName}>${s.inName}:${s.gamesPlayed}:${s.evaluation.delta}:${s.adjustedPValue}`);
    expect(shape(a)).toEqual(shape(b));
    expect(a.notes.totalGamesRun).toBe(b.notes.totalGamesRun);
    expect(a.waves.map((w) => w.cumulativeGames)).toEqual(b.waves.map((w) => w.cumulativeGames));
  });

  it('THE BUG: a second run explores DIFFERENT candidates instead of repeating', () => {
    const first = suggestSwaps(MONO_RED_AGGRO, baseOpts);
    const second = suggestSwaps(MONO_RED_AGGRO, { ...baseOpts, history: first.history });

    const firstKeys = new Set(first.suggestions.map((s) => `${s.outName}>${s.inName}`));
    const secondKeys = second.suggestions.map((s) => `${s.outName}>${s.inName}`);
    const fresh = secondKeys.filter((k) => !firstKeys.has(k));

    // Without the record the second run re-derived the identical shortlist. With
    // it, most of the second run's budget goes somewhere new.
    expect(secondKeys.length).toBeGreaterThan(0);
    expect(fresh.length).toBeGreaterThan(0);
    expect(second.notes.runIndex).toBe(1);
    // Everything the first run learned is carried forward, not thrown away.
    expect(second.history.candidates.length).toBeGreaterThan(first.history.candidates.length);
    // And the correction knows the family got bigger.
    expect(second.multipleComparisons.familySize).toBeGreaterThan(second.multipleComparisons.testedThisRun);
  });

  it('does not re-test candidates a previous run settled', () => {
    const first = suggestSwaps(MONO_RED_AGGRO, baseOpts);
    // Force every candidate the first run touched to be settled.
    const settledHistory: SuggestionHistory = {
      ...first.history,
      candidates: first.history.candidates.map((c) => ({ ...c, provenNotBetter: true, settled: true })),
    };
    const second = suggestSwaps(MONO_RED_AGGRO, { ...baseOpts, history: settledHistory });

    const settledKeys = new Set(settledHistory.candidates.map((c) => candidateKey(c.outId, c.inId)));
    for (const s of second.suggestions) {
      const evaluated = second.history.candidates.find((c) => c.outName === s.outName && c.inName === s.inName);
      expect(settledKeys.has(candidateKey(evaluated!.outId, evaluated!.inId) )).toBe(false);
    }
    expect(second.skipped.some((s) => s.reason === 'settled')).toBe(true);
  });
});
