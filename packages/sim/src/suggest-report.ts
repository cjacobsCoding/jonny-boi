/**
 * THE SUGGESTION REPORT — the shapes a run returns, and the one function that
 * turns a finished search into them.
 *
 * Assembling the report is where the multiple-comparisons correction is applied,
 * every verdict is re-decided from the corrected p-value, the list is ranked, and
 * the record for the NEXT run is folded together. All of that is statistics, so it
 * lives here and only here: a host that merely *schedules* the games (the web
 * Lab's worker pool does) calls `finishSuggestionRun` with the tallies it
 * collected and gets the identical report the single-threaded engine would have
 * produced. It never decides a verdict of its own.
 */

import type { MultipleComparisonsMethod } from './stats.js';
import { adjustPValues } from './stats.js';
import type { StatsConfig } from './config.js';
import { FIDELITY_CAVEAT } from './config.js';
import type { SwapEvaluation } from './swap.js';
import { decideVerdict, gamesToSettle, SWAP_VERDICT_REASON_BY_KEY } from './swap.js';
import type { EliminationReason } from './suggest-schedule.js';
import type { SwapCandidate, SkippedCandidate } from './suggest-candidates.js';
import { rankEvaluations } from './suggest-candidates.js';
import type { PairedArmsUsage } from './paired-arms.js';
import type { ExplorationWeights } from './suggest-config.js';
import type { HistoryRejection, HistoryUpdate, SuggestionHistory } from './suggest-history.js';
import { candidateKey, mergeHistory } from './suggest-history.js';

/**
 * One evaluated, ranked swap recommendation.
 *
 * ⚠️ **Two p-values, on purpose.** `evaluation.pValue` is the raw McNemar p — a
 * valid significance statement about the games THIS candidate actually played, and
 * nothing more. `adjustedPValue` corrects it for the whole family of candidates
 * tested, and it is what `evaluation.verdict` is decided from, because the honest
 * question for a suggestion list is "is this better, given we looked at 139 cards?"
 * rather than "is this better, if it were the only card I had ever considered?".
 */
export interface RankedSwap {
  readonly rank: number;
  readonly outName: string;
  readonly inName: string;
  /** The paired A/B verdict; its `verdict` is the multiplicity-adjusted call. */
  readonly evaluation: SwapEvaluation;
  /** Paired games this candidate actually received (adaptive: not all are equal). */
  readonly gamesPlayed: number;
  /** The uncorrected McNemar p-value (identical to `evaluation.pValue`). */
  readonly rawPValue: number;
  /** The multiplicity-corrected p-value the verdict is decided from. */
  readonly adjustedPValue: number;
  /** Present when the search stopped spending games here, with the reason. */
  readonly elimination?: EliminationNote;
}

/** Why a candidate stopped receiving games, and on what evidence. */
export interface EliminationNote {
  /** The wave after which it was dropped. */
  readonly wave: number;
  /** 'futile' = provably not better; 'outranked' = budget bought more elsewhere. */
  readonly reason: EliminationReason;
  readonly detail: string;
}

/** An eliminated candidate, named for the report. */
export interface EliminatedSwap extends EliminationNote {
  readonly outName: string;
  readonly inName: string;
  readonly gamesPlayed: number;
}

/** What one wave of the adaptive search did — reported so nothing is silent. */
export interface WaveReport {
  readonly wave: number;
  /** Paired games each candidate in this wave was played up to (cumulative). */
  readonly cumulativeGames: number;
  /** How many candidates the wave played. */
  readonly candidatesPlayed: number;
  /** How many carried into the next wave. */
  readonly survivors: number;
  /** Who was dropped after this wave, and why. */
  readonly eliminated: readonly EliminatedSwap[];
  /** Untried candidates pulled in because they resemble this wave's leaders. */
  readonly offspring: readonly string[];
}

/** How the family of simultaneous tests was corrected. */
export interface MultipleComparisonsReport {
  readonly method: MultipleComparisonsMethod;
  /**
   * Tests the correction accounted for: every candidate this run evaluated PLUS
   * every candidate previous runs evaluated on this deck. Counting past runs is
   * what stops "just run it again until something looks significant" from working.
   */
  readonly familySize: number;
  /** Of those, how many this run evaluated. */
  readonly testedThisRun: number;
  /** Candidates whose RAW p cleared alpha but whose corrected p did not. */
  readonly demotedByCorrection: number;
}

/** The suggestion engine's report for one deck. */
export interface SuggestionReport {
  readonly baseDeck: string;
  /** The base deck's overall gauntlet win-rate (variantless reference point). */
  readonly baseGauntletWinRate: SwapEvaluation['baseWinRate'];
  /** How many candidate swaps were actually simulated. */
  readonly candidatesEvaluated: number;
  /** The ranked recommendations: proven-better, then inconclusive, then worse. */
  readonly suggestions: readonly RankedSwap[];
  /** Candidates generated but not evaluated (illegal / capped / settled). */
  readonly skipped: readonly SkippedCandidate[];
  /** What each wave played, dropped, and pulled in. Empty in fixed-budget mode. */
  readonly waves: readonly WaveReport[];
  /** How the multiple-comparisons problem was handled. */
  readonly multipleComparisons: MultipleComparisonsReport;
  /**
   * The record to persist and hand back next time — this is what makes a re-run
   * explore new ground instead of repeating itself.
   */
  readonly history: SuggestionHistory;
  /** Throughput + coverage notes (games run, games/sec, caveats). */
  readonly notes: SuggestionNotes;
}

/** Performance + honesty notes carried in the report (not console spam). */
export interface SuggestionNotes {
  /** Total individual games the sim actually played. */
  readonly totalGamesRun: number;
  /** Observed throughput; undefined when not timed. */
  readonly gamesPerSecond?: number;
  /** Wall-clock seconds the evaluations took, when measured. */
  readonly elapsedSeconds?: number;
  /** Candidates generated in total (evaluated + skipped). */
  readonly candidatesGenerated: number;
  /** True when the roster cap trimmed the candidate set. */
  readonly cappedByBudget: boolean;
  /** Base-deck games played — ONCE for the whole run under base-arm reuse. */
  readonly baseGamesPlayed: number;
  /** Variant games played. */
  readonly variantGamesPlayed: number;
  /** Variant games answered for free because the swapped card was never seen. */
  readonly variantGamesSkipped: number;
  /**
   * Games the fixed scheme would have played for the same candidates and depths —
   * the honest denominator for "how much did adaptive sampling save?".
   */
  readonly gamesAvoided: number;
  /** Whether the identical-game optimisation was live, and why not when it wasn't. */
  readonly identicalGameSkipEnabled: boolean;
  readonly identicalGameSkipDisabledReason?: string;
  /** Which run this was for this deck (0 = the first ever). */
  readonly runIndex: number;
  /** Set when a supplied history was rejected, with the reason. */
  readonly historyRejected?: HistoryRejection;
  /**
   * How many workers played the games. 1 for the headless engine; the pool size
   * in the Lab. Reported so a timing can be read honestly, never used as an input
   * to anything — a run's numbers must not know how many cores ran it.
   */
  readonly workersUsed?: number;
  /** The shared fidelity caveat (`FIDELITY_CAVEAT`), carried for the UI/CLI. */
  readonly fidelityCaveat: string;
  /**
   * THE BAR THIS RUN WAS READ AT (§3.179). Carried because alpha is a Lab
   * control now: a panel that printed its CURRENT slider position beside an
   * OLD run's rows would relabel a 0.05 result as a 0.10 one, which is the same
   * "reports something other than what happened" defect the reason column
   * exists to end. Every surface reads the bar from the report, never from its
   * own state.
   */
  readonly stats: StatsConfig;
}

/** What a search strategy hands back for assembly into the report. */
export interface CandidateOutcome {
  readonly candidate: SwapCandidate;
  readonly evaluation: SwapEvaluation;
  readonly gamesPlayed: number;
  readonly elimination?: EliminationNote;
}

/** The raw result of a search, before any correction or ranking. */
export interface SuggestionSearchResult {
  readonly outcomes: readonly CandidateOutcome[];
  readonly waves: readonly WaveReport[];
  readonly usage: PairedArmsUsage;
  /** Candidates that failed at evaluation time (recorded, never fatal). */
  readonly failures: readonly SkippedCandidate[];
  /**
   * Games a fixed-budget sweep would have played to reach the same per-candidate
   * depths: `2 × Σ gamesPlayed` (each paired game plays both arms).
   */
  readonly fixedSchemeGames: number;
}

/** Everything `finishSuggestionRun` needs; grouped so the call site stays readable. */
export interface SuggestionReportInput {
  readonly baseDeckName: string;
  readonly search: SuggestionSearchResult;
  readonly skipped: readonly SkippedCandidate[];
  readonly candidatesGenerated: number;
  readonly cappedByBudget: boolean;
  readonly elapsedSeconds: number;
  readonly history: SuggestionHistory;
  readonly historyRejected?: HistoryRejection;
  readonly method: MultipleComparisonsMethod;
  readonly exploration: ExplorationWeights;
  readonly stats: StatsConfig;
  /** How many workers played the games; omitted means single-threaded. */
  readonly workersUsed?: number;
}

/**
 * Correct for multiplicity, re-decide every verdict from the corrected p-value,
 * rank, and assemble — plus the record the next run continues from.
 *
 * The family is every candidate tested on this deck EVER, not just this run: the
 * padding entries stand for candidates a previous run tested and this one didn't,
 * which is exactly what keeps "run it again until something looks significant" from
 * manufacturing a winner. Padding with p = 1 is the standard, conservative way to
 * apply Holm/BH to a family you only partly observe.
 */
export function finishSuggestionRun(input: SuggestionReportInput): SuggestionReport {
  const outcomes = input.search.outcomes;
  const priorKeys = new Set(input.history.candidates.map((c) => candidateKey(c.outId, c.inId)));
  for (const outcome of outcomes) priorKeys.add(outcome.candidate.key);
  const familySize = Math.max(priorKeys.size, outcomes.length);

  const rawPValues = outcomes.map((o) => o.evaluation.pValue);
  const padded = [...rawPValues, ...new Array(Math.max(0, familySize - rawPValues.length)).fill(1)];
  const adjustedAll = adjustPValues(padded, input.method);
  const adjusted = adjustedAll.slice(0, rawPValues.length);

  let demotedByCorrection = 0;
  const byEvaluation = new Map<SwapEvaluation, { readonly outcome: CandidateOutcome; readonly adjustedP: number }>();
  const corrected: SwapEvaluation[] = outcomes.map((outcome, i) => {
    const adjustedP = adjusted[i] as number;
    const decision = decideVerdict(
      outcome.evaluation.delta,
      adjustedP,
      outcome.evaluation.nGames,
      input.stats.alpha,
      input.stats.minGamesForVerdict,
    );
    if (outcome.evaluation.verdict !== 'inconclusive' && decision.verdict === 'inconclusive') demotedByCorrection++;
    // ⚠️ THE GAMES-TO-SETTLE ESTIMATE IS RECOMPUTED AGAINST THE CORRECTED BAR.
    // `summarizePairedSwap` computed it against the raw alpha, but inside a
    // family this row must clear HOLM's bar, which is stricter — printing the
    // raw number beside a Holm-corrected verdict would understate the cost of
    // settling it, and an estimate that is quietly too small is worse than none.
    // Holm scales a p-value by a rank multiplier, so requiring `adjustedP <
    // alpha` is requiring `rawP < alpha · rawP/adjustedP`: that ratio IS the
    // effective bar. (The multiplier can change as the row's rank moves, which
    // is one of several reasons this is an estimate and is labelled as one.)
    const rawP = outcome.evaluation.pValue;
    const effectiveAlpha = adjustedP > 0 && rawP > 0 ? input.stats.alpha * (rawP / adjustedP) : input.stats.alpha;
    const settle = SWAP_VERDICT_REASON_BY_KEY[decision.reason].moreGamesCouldSettle
      ? gamesToSettle(outcome.evaluation.paired, outcome.evaluation.nGames, input.stats, effectiveAlpha)
      : undefined;
    const evaluation: SwapEvaluation = {
      ...outcome.evaluation,
      verdict: decision.verdict,
      verdictReason: decision.reason,
      // Spread first, then override: a stale raw estimate must not survive when
      // the corrected bar says there is none.
      ...(settle ? { gamesToSettle: settle } : { gamesToSettle: undefined }),
    };
    byEvaluation.set(evaluation, { outcome, adjustedP });
    return evaluation;
  });

  const ranked = rankEvaluations(corrected);
  const suggestions: RankedSwap[] = ranked.map((evaluation, i) => {
    const meta = byEvaluation.get(evaluation) as { outcome: CandidateOutcome; adjustedP: number };
    return {
      rank: i + 1,
      outName: evaluation.outName,
      inName: evaluation.inName,
      evaluation,
      gamesPlayed: meta.outcome.gamesPlayed,
      rawPValue: evaluation.pValue,
      adjustedPValue: meta.adjustedP,
      ...(meta.outcome.elimination ? { elimination: meta.outcome.elimination } : {}),
    };
  });

  // History records the UNCORRECTED verdict on purpose: it drives budget decisions
  // ("has this candidate had a fair hearing?"), not published claims, and the
  // correction is re-derived from the whole family each run anyway.
  const updates: HistoryUpdate[] = outcomes.map((outcome) => ({
    outId: outcome.candidate.outId,
    inId: outcome.candidate.inId,
    outName: outcome.candidate.outName,
    inName: outcome.candidate.inName,
    gamesPlayed: outcome.gamesPlayed,
    delta: outcome.evaluation.delta,
    verdict: outcome.evaluation.verdict,
    // Futility is the scheduler saying "provably not better" — settle it for good.
    provenNotBetter: outcome.evaluation.verdict === 'worse' || outcome.elimination?.reason === 'futile',
  }));

  const usage = input.search.usage;
  const totalGamesRun = usage.totalGamesPlayed;
  const notes: SuggestionNotes = {
    totalGamesRun,
    elapsedSeconds: input.elapsedSeconds > 0 ? input.elapsedSeconds : undefined,
    gamesPerSecond: input.elapsedSeconds > 0 ? totalGamesRun / input.elapsedSeconds : undefined,
    candidatesGenerated: input.candidatesGenerated,
    cappedByBudget: input.cappedByBudget,
    baseGamesPlayed: usage.baseGamesPlayed,
    variantGamesPlayed: usage.variantGamesPlayed,
    variantGamesSkipped: usage.variantGamesSkipped,
    gamesAvoided: Math.max(0, input.search.fixedSchemeGames - totalGamesRun),
    identicalGameSkipEnabled: usage.identicalGameSkipEnabled,
    ...(usage.identicalGameSkipDisabledReason
      ? { identicalGameSkipDisabledReason: usage.identicalGameSkipDisabledReason }
      : {}),
    runIndex: input.history.runsCompleted,
    ...(input.historyRejected ? { historyRejected: input.historyRejected } : {}),
    ...(input.workersUsed !== undefined ? { workersUsed: input.workersUsed } : {}),
    fidelityCaveat: FIDELITY_CAVEAT,
    stats: input.stats,
  };

  return {
    baseDeck: input.baseDeckName,
    // No candidate ran (empty report) → a zero win-rate placeholder, clearly noted.
    baseGauntletWinRate: outcomes[0]?.evaluation.baseWinRate ?? { p: 0, low: 0, high: 0, successes: 0, n: 0 },
    candidatesEvaluated: outcomes.length,
    suggestions,
    skipped: input.skipped,
    waves: input.search.waves,
    multipleComparisons: {
      method: input.method,
      familySize,
      testedThisRun: outcomes.length,
      demotedByCorrection,
    },
    history: mergeHistory(input.history, updates, input.exploration),
    notes,
  };
}
