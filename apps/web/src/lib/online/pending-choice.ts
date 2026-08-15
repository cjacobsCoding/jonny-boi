/**
 * The online board's view of a parked player choice — the pure half.
 *
 * ## What changed, and why this module is small
 * The server now masks `GameState.pendingChoice` per seat (`MaskedGameView.
 * pendingChoice`): the seat that must answer receives the FULL `PendingChoice`,
 * everyone else a `RedactedPendingChoice` summary carrying only who was asked, by
 * what card, and of what kind. That is the whole reason this module can be thin —
 * the question that arrives is already the real one, so online play reuses the
 * hotseat's `ChoicePrompt` + `choice-view` model verbatim rather than reconstructing
 * a menu of answers from public information (which is what the temporary
 * `choice-actions` fallback did, and why it is gone).
 *
 * ## The one rule it enforces
 * A prompt may be rendered ONLY from a non-redacted choice addressed to this
 * viewer. Both halves matter: `isRedactedChoice` is the wire-level guard (a summary
 * has no candidates to render), and `isChoiceForViewer` is the belt-and-braces
 * check that the seat matches — a client must not render an opponent's question
 * even if a buggy or hostile server sent it one.
 */
import type { ChoiceAnswer, GameAction, PendingChoice, PlayerId } from '@jonny-boi/core';
import { isRedactedChoice, type MaskedGameView } from '@jonny-boi/protocol';
import { isChoiceForViewer, waitingForChoiceText } from '../play/choice-view.js';

/** What the board needs to render about the outstanding question, if any. */
export interface OnlineChoiceView {
  /** The question to hand to the shared `ChoicePrompt`, or `null`. */
  readonly answerable: PendingChoice | null;
  /** The leak-free "opponent is choosing…" line, or `null` when there is nothing to wait for. */
  readonly waitingText: string | null;
}

const NOTHING_PENDING: OnlineChoiceView = Object.freeze({ answerable: null, waitingText: null });

/**
 * Split the masked pending choice into "a question I must answer" and "a line
 * telling me who else is answering". Exactly one of the two is ever set, because
 * the server sends the full question to precisely one seat.
 */
export function onlineChoiceView(
  view: MaskedGameView,
  names: Readonly<Record<PlayerId, string>>,
): OnlineChoiceView {
  const choice = view.pendingChoice;
  if (!choice) return NOTHING_PENDING;
  if (!isRedactedChoice(choice) && isChoiceForViewer(choice, view.viewer)) {
    return { answerable: choice, waitingText: null };
  }
  // A summary — or, defensively, a full question addressed to the other seat. Either
  // way this viewer only learns who is choosing and which card asked.
  return { answerable: null, waitingText: waitingForChoiceText(choice, names) };
}

/**
 * The action that answers a question. It names the choice by `id`, which is what
 * makes a stale reply (this client answering a question the server has already
 * resolved) rejectable rather than misapplied to whatever is open now.
 */
export function answerChoiceAction(
  viewer: PlayerId,
  choice: PendingChoice,
  answer: ChoiceAnswer,
): GameAction {
  return { kind: 'answerChoice', player: viewer, choiceId: choice.id, answer };
}
