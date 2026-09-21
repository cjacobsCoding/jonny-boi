/**
 * The trim SESSION's decisions, as pure functions (DESIGN §3.174).
 *
 * The panel drives the worker pool one ROUND at a time — each round is one
 * ordinary sim request, so Cancel is the ordinary cancel — and between rounds
 * it has to decide: apply and go again, stop and ask, widen to pairs, or report
 * exhaustion. Those decisions are the user's settings applied to a round's
 * report, and nothing about them needs React, so they live here where a test
 * can walk every branch of the closed table.
 *
 * The sim's `trimDeck` makes the same decisions for the headless loop; both read
 * the same `nextWideningStep` and the same settings vocabulary, so the Lab and
 * the engine cannot disagree about what "keep looking" means.
 */
import {
  DEFAULT_TRIM_BUDGET,
  TRIM_ROUND_KINDS,
  deeperGamesPerCandidate,
  nextWideningStep,
  type LandRatio,
  type TrimRoundKind,
  type TrimRoundReport,
  type TrimRow,
  type TrimSettings,
  type TrimSpend,
  type TrimStopReason,
} from '@jonny-boi/sim';
import { resolveEntries, type Deck } from '../deck.js';

/** What the panel does next, decided from a finished round and the settings. */
export type TrimNextStep =
  /** Auto mode: apply this removal, then (once the deck has shrunk) round again. */
  | { readonly kind: 'apply'; readonly row: TrimRow }
  /** Ask mode: show the winner and wait for the user. */
  | { readonly kind: 'ask'; readonly row: TrimRow }
  /** Nothing improved, and the settings say widen: issue this round next. */
  | { readonly kind: 'widen'; readonly round: number; readonly roundKind: TrimRoundKind }
  /**
   * The kinds are spent but the round is still UNSURE (§3.179): run the ladder
   * again DEEPER. `gamesPerCandidate` is what the next request must ask for.
   */
  | { readonly kind: 'deepen'; readonly round: number; readonly roundKind: TrimRoundKind; readonly gamesPerCandidate: number }
  /** The session is over. `reason` says WHICH of the several ways it ended. */
  | { readonly kind: 'stopped'; readonly reason: TrimStopReason; readonly edge?: TrimRow };

/** The first round of a session, and of every fresh start after an apply. */
export const FIRST_ROUND_KIND: TrimRoundKind = TRIM_ROUND_KINDS[0];

/**
 * Decide what follows a finished round. The whole closed table, in one place.
 *
 * ⚠️ THIS MIRRORS `trimDeck`'s LOOP AND MUST NOT DRIFT FROM IT. The panel drives
 * one round per worker request so Cancel stays the ordinary cancel, which is why
 * the loop cannot simply be called — but every DECISION is imported
 * (`nextWideningStep`, `deeperGamesPerCandidate`, the stop-reason vocabulary),
 * so the engine and the Lab cannot disagree about what "keep looking" means.
 * `trim-session-parity.test.ts` drives both over the same rounds and fails if
 * they diverge.
 */
export function stepAfterRound(
  report: TrimRoundReport,
  settings: TrimSettings,
  spend: TrimSpend,
  gamesPerCandidate: number,
): TrimNextStep {
  if (report.verdict === 'improved' && report.winner) {
    return settings.onImprovement === 'auto' ? { kind: 'apply', row: report.winner } : { kind: 'ask', row: report.winner };
  }
  const edge = report.edgeCandidate ? { edge: report.edgeCandidate } : {};
  if (settings.onNoImprovement === 'pause') return { kind: 'stopped', reason: 'paused', ...edge };

  const next = nextWideningStep(report.roundKind, report.deckSize, report.targetSize);
  if (next !== undefined) return { kind: 'widen', round: report.round + 1, roundKind: next };

  // The kinds are spent. A CONCLUSIVE round has settled the question; an UNSURE
  // one has not, and the lever left is depth.
  if (report.verdict === 'exhausted') return { kind: 'stopped', reason: 'no-improvement-conclusive', ...edge };

  const budget = settings.budget ?? DEFAULT_TRIM_BUDGET;
  if (spend.games >= budget.maxGames || spend.seconds >= budget.maxSeconds) {
    return { kind: 'stopped', reason: 'budget-exhausted', ...edge };
  }
  const deeper = deeperGamesPerCandidate(gamesPerCandidate);
  if (deeper === undefined) return { kind: 'stopped', reason: 'budget-exhausted', ...edge };
  return { kind: 'deepen', round: report.round + 1, roundKind: FIRST_ROUND_KIND, gamesPerCandidate: deeper };
}

/** After a removal is applied: another round, or done? */
export function stepAfterApply(
  deckSize: number,
  targetSize: number,
  lastRound: number,
): { readonly kind: 'round'; readonly round: number; readonly roundKind: TrimRoundKind } | { readonly kind: 'target-reached' } {
  if (deckSize > targetSize) return { kind: 'round', round: lastRound + 1, roundKind: FIRST_ROUND_KIND };
  return { kind: 'target-reached' };
}

/** The deck's land ratio, read from the card index — the pre-run reading the panel shows. */
export function landRatioOfWebDeck(deck: Deck): LandRatio {
  let lands = 0;
  for (const { card, count } of resolveEntries(deck)) {
    if (card.typeLine.types.includes('Land')) lands += count;
  }
  const size = deck.cards.reduce((sum, entry) => sum + entry.count, 0);
  return { lands, size };
}

/**
 * Clamp a typed target into what the deck can actually be trimmed to: never
 * below the format minimum, never at or above the deck's current size (there
 * would be nothing to do). Returns the reason when the deck cannot be trimmed
 * at all, so the panel says so instead of offering a dead button.
 */
export function targetProblem(targetSize: number, deckSize: number, minDeckSize: number): string | null {
  if (!Number.isInteger(targetSize)) return 'The target must be a whole number of cards.';
  if (targetSize < minDeckSize) return `The target cannot go below the format minimum of ${minDeckSize} cards.`;
  if (deckSize <= minDeckSize) return `This deck is already at the ${minDeckSize}-card minimum — there is nothing to trim.`;
  if (targetSize >= deckSize) return `This deck is ${deckSize} cards — the target must be smaller.`;
  return null;
}
