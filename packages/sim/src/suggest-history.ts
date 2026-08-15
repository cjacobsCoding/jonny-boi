/**
 * THE PROGRESSIVE-SEARCH RECORD — what a run hands back so the NEXT run can pick up
 * where it left off instead of re-deriving the same shortlist.
 *
 * The reported bug in one sentence: the engine pre-ranked candidates with a
 * deterministic heuristic that ignores outcomes, so a second run re-tested exactly
 * the first run's shortlist and spent the same compute to print the same answer.
 * Making the search progressive needs memory, and the sim is a pure library with no
 * storage of its own — so a run RETURNS its memory as plain JSON and the caller
 * (the web Lab; the CLI's `--history` file) persists it and hands it back next time.
 *
 * Design rules this shape obeys:
 *
 *  - **JSON-safe and versioned.** No `Map`, no `Set`, no class instances; a
 *    `version` field so a future change can migrate rather than crash.
 *  - **Bound to the deck it was learned on.** A decklist fingerprint travels with
 *    the record. Change the deck and the evidence no longer applies, so a stale
 *    record is rejected rather than quietly steering a different deck's search.
 *  - **Evidence is never pooled across runs.** Each run reports statistics computed
 *    ONLY from the games that run played. History decides *where to spend budget*;
 *    it never inflates a p-value by adding up runs. (Runs deliberately play
 *    different games — the run counter offsets the seed — so pooling would also
 *    need a correction nobody would remember to apply.)
 *  - **It carries the family size.** Multiple-comparisons correction must account
 *    for every candidate ever tested on this deck, or "run it again until something
 *    looks significant" becomes a p-hacking machine.
 */

import type { SwapVerdict } from './swap.js';
import type { Deck } from './deck.js';
import type { PriorEvidence } from './suggest-schedule.js';
import type { ExplorationWeights } from './suggest-config.js';

/** The current record version. Bump when the shape changes incompatibly. */
export const SUGGESTION_HISTORY_VERSION = 1;

/** What previous runs learned about ONE candidate swap. */
export interface CandidateHistory {
  /** Resolved card ids — stable across renames and display formatting. */
  readonly outId: string;
  readonly inId: string;
  /** Human-readable, for a UI that wants to list what has been tried. */
  readonly outName: string;
  readonly inName: string;
  /** Paired games this candidate has received, summed across runs. */
  readonly gamesPlayed: number;
  /** Its observed paired win-rate delta in the most recent run that tested it. */
  readonly delta: number;
  /**
   * The most recent run's UNCORRECTED verdict. Stored uncorrected on purpose: this
   * field drives budget decisions ("has this candidate had a fair hearing?"), not
   * published claims, and the multiple-comparisons correction is re-derived from
   * the whole family on every run anyway.
   */
  readonly verdict: SwapVerdict;
  /**
   * The search established this candidate is not better — a 'worse' verdict, or the
   * futility rule retiring it because even the optimistic bound on its discordant
   * win-share sat below break-even. Recorded separately from `verdict` because a
   * candidate can be provably not-better long before it has enough games for a
   * significance claim.
   */
  readonly provenNotBetter: boolean;
  /** How many runs have tested it. */
  readonly runs: number;
  /**
   * Settled: enough games, never promising — do not spend budget here again.
   * Recomputed each run rather than trusted blindly, so re-tuning the exploration
   * weights re-opens candidates an older, stricter run had closed.
   */
  readonly settled: boolean;
}

/** The serializable record a caller persists between runs. */
export interface SuggestionHistory {
  readonly version: number;
  /**
   * Fingerprint of the deck this evidence was gathered on. A record whose
   * fingerprint doesn't match the deck being tuned is ignored (and said so).
   */
  readonly deckFingerprint: string;
  /** Human-facing deck name at the time of recording (for UI/debugging). */
  readonly deckName: string;
  /** How many suggestion runs have contributed. Also offsets the next run's seed. */
  readonly runsCompleted: number;
  /** Every candidate any run has evaluated, in a stable order. */
  readonly candidates: readonly CandidateHistory[];
}

/** The stable key identifying a candidate swap across runs. */
export function candidateKey(outId: string, inId: string): string {
  return `${outId}>${inId}`;
}

/**
 * A fingerprint of the decklist's CONTENT — card ids and counts, order-independent.
 * Renaming a deck keeps its evidence; changing a single card invalidates it, which
 * is the honest behaviour: a swap's measured effect is a property of the deck it
 * was measured in.
 */
export function deckFingerprint(deck: Deck): string {
  const totals = new Map<string, number>();
  for (const entry of deck.cards) {
    totals.set(entry.cardId, (totals.get(entry.cardId) ?? 0) + entry.count);
  }
  return [...totals.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id, count]) => `${id}:${count}`)
    .join('|');
}

/** An empty record for a deck nobody has tuned yet. */
export function emptyHistory(deck: Deck): SuggestionHistory {
  return {
    version: SUGGESTION_HISTORY_VERSION,
    deckFingerprint: deckFingerprint(deck),
    deckName: deck.name,
    runsCompleted: 0,
    candidates: [],
  };
}

/** Why a supplied history was not used. `undefined` = it was used. */
export type HistoryRejection = 'version' | 'deck-changed';

/**
 * Validate a caller-supplied record against the deck being tuned. Robust by
 * design (CLAUDE.md rule 6): anything unusable degrades to "no history" with a
 * reason the report prints, never a thrown error mid-run.
 */
export function acceptHistory(
  history: SuggestionHistory | undefined,
  deck: Deck,
): { readonly history: SuggestionHistory; readonly rejected?: HistoryRejection } {
  if (!history) return { history: emptyHistory(deck) };
  if (history.version !== SUGGESTION_HISTORY_VERSION) {
    return { history: emptyHistory(deck), rejected: 'version' };
  }
  if (history.deckFingerprint !== deckFingerprint(deck)) {
    return { history: emptyHistory(deck), rejected: 'deck-changed' };
  }
  return { history };
}

/**
 * Turn a record into the prior evidence the scheduler consults, applying the
 * CURRENT exploration weights to decide what counts as settled. Deciding here
 * rather than trusting the stored flag means a caller who loosens the weights can
 * re-open candidates an earlier, stricter run had closed.
 */
export function priorEvidenceFrom(
  history: SuggestionHistory,
  weights: ExplorationWeights,
): ReadonlyMap<string, PriorEvidence> {
  const priors = new Map<string, PriorEvidence>();
  for (const entry of history.candidates) {
    priors.set(candidateKey(entry.outId, entry.inId), {
      gamesPlayed: entry.gamesPlayed,
      delta: entry.delta,
      settled: isSettled(entry, weights),
    });
  }
  return priors;
}

/**
 * A candidate is settled when it has had a fair hearing and never looked
 * promising: at least `settledAfterGames` paired games with no positive delta, or a
 * proven-worse verdict at any depth. Those are the "worse or inconclusive" results
 * the user watched a second run pointlessly re-derive.
 */
export function isSettled(entry: CandidateHistory, weights: ExplorationWeights): boolean {
  if (entry.provenNotBetter) return true;
  return entry.gamesPlayed >= weights.settledAfterGames && entry.delta <= weights.promisingDelta;
}

/** One candidate's outcome in the run being recorded. */
export interface HistoryUpdate {
  readonly outId: string;
  readonly inId: string;
  readonly outName: string;
  readonly inName: string;
  readonly gamesPlayed: number;
  readonly delta: number;
  readonly verdict: SwapVerdict;
  /** The search proved it is not better (a 'worse' verdict, or futility). */
  readonly provenNotBetter: boolean;
}

/**
 * Fold this run's results into the record for the next one. Games accumulate
 * (they were different games — the run counter offsets the seed), while delta and
 * verdict are the LATEST run's, since only same-run numbers may be compared.
 * Candidates are stored in a stable key order so persisted records diff cleanly.
 */
export function mergeHistory(
  previous: SuggestionHistory,
  updates: readonly HistoryUpdate[],
  weights: ExplorationWeights,
): SuggestionHistory {
  const byKey = new Map<string, CandidateHistory>();
  for (const entry of previous.candidates) byKey.set(candidateKey(entry.outId, entry.inId), entry);

  for (const update of updates) {
    const key = candidateKey(update.outId, update.inId);
    const existing = byKey.get(key);
    const merged: CandidateHistory = {
      outId: update.outId,
      inId: update.inId,
      outName: update.outName,
      inName: update.inName,
      gamesPlayed: (existing?.gamesPlayed ?? 0) + update.gamesPlayed,
      delta: update.delta,
      verdict: update.verdict,
      // Once proven not-better, always: evidence does not un-happen.
      provenNotBetter: (existing?.provenNotBetter ?? false) || update.provenNotBetter,
      runs: (existing?.runs ?? 0) + 1,
      settled: false,
    };
    byKey.set(key, { ...merged, settled: isSettled(merged, weights) });
  }

  return {
    version: SUGGESTION_HISTORY_VERSION,
    deckFingerprint: previous.deckFingerprint,
    deckName: previous.deckName,
    runsCompleted: previous.runsCompleted + 1,
    candidates: [...byKey.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([, entry]) => entry),
  };
}
