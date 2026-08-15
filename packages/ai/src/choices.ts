/**
 * Answering player CHOICES (core's `GameState.pendingChoice`).
 *
 * When a resolving spell parks a question, the engine offers the chooser exactly
 * one kind of action — `answerChoice` — so a pilot could technically answer by
 * picking any enumerated option and never think about it. That is what the
 * `random` baseline does, and it is correct but weak: a pilot that discards its
 * best card, declines every upside, or hands its opponent the good half of a modal
 * spell plays materially worse, and the sim's whole point is that the numbers
 * reflect real play.
 *
 * So the heuristic answers *properly*, from ONE rule that needs no card knowledge:
 * **the chooser picks what is best for the chooser**, steered by the request's
 * `ChoiceValence` (is being selected good or bad?) and scored by a small, tunable
 * card-value function. That handles cards this package has never heard of,
 * including the ones where the OPPONENT is the chooser — a discard the victim
 * picks, they pick their worst card, which is exactly right.
 *
 * MODES are the one kind that cannot be answered from valence alone: "choose two"
 * of four is a question about the board, not about the chooser. Those are scored
 * by reading the modal card's own authored modes and pricing each one's effects
 * against the live state (`./effect-value`), in the pilot's existing score
 * vocabulary — so Cryptic Command draws a card when there is nothing worth
 * bouncing, and counters when there is something worth countering.
 *
 * Determinism: no `Math.random`, no wall clock. Every comparison falls back to
 * `instanceId` / option index, so equal-scoring options break ties in a fixed
 * order and the same seed reproduces the same answers.
 */

import type {
  ChoiceAnswer,
  ChooseModesChoice,
  ConfirmChoice,
  GameAction,
  GameState,
  PendingChoice,
  PlayerId,
  SelectCardsChoice,
  SelectPlayersChoice,
} from '@jonny-boi/core';
import { defaultAnswerFor, opponentOf } from '@jonny-boi/core';
import { cardValue, cardValueContext, findInstance } from './card-value.js';
import { modeEffectsFor, resolutionValueContext, valueOfEffects } from './effect-value.js';
import type { HeuristicWeights } from './weights.js';

/**
 * Re-exported from `./card-value.js`, where the ranking now lives so the effect
 * scorer can price a countered/regrown card with the very same ruler. Kept exported
 * from here because "what is my worst card" is part of this module's public story.
 */
export { cardValue, cardValueContext, findInstance };
export type { CardValueContext } from './card-value.js';

/**
 * Wrap an answer as the action the engine accepts. Always addressed to the
 * choice's own `chooser` and stamped with its `id`, so a pilot cannot accidentally
 * answer for the wrong seat or answer a question that has already gone.
 */
export function answerAction(choice: PendingChoice, answer: ChoiceAnswer): GameAction {
  return { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer };
}

/**
 * The action that always moves the game on, whatever has gone wrong: the engine's
 * own default answer while a choice is parked (passing is *rejected* there, so a
 * pilot that falls back to passing would spin until the harness's rejection cap),
 * and a plain priority pass otherwise.
 */
export function safeFallbackAction(state: GameState): GameAction {
  const choice = state.pendingChoice;
  if (choice) return answerAction(choice, defaultAnswerFor(choice));
  return { kind: 'passPriority', player: state.priorityPlayer };
}

/**
 * Answer any pending choice sensibly. Never throws and never returns an illegal
 * answer: every branch selects between `min` and `max` of the offered options, and
 * the count clamps guarantee such a selection exists.
 */
export function answerChoiceHeuristically(
  state: GameState,
  choice: PendingChoice,
  weights: HeuristicWeights,
): GameAction {
  switch (choice.kind) {
    case 'selectCards':
      return answerAction(choice, answerSelectCards(state, choice, weights));
    case 'selectPlayers':
      return answerAction(choice, answerSelectPlayers(choice));
    case 'chooseModes':
      return answerAction(choice, answerChooseModes(state, choice, weights));
    case 'confirm':
      return answerAction(choice, answerConfirm(choice, weights));
    default:
      // A kind this build does not know: take the smallest legal answer the engine
      // itself would take. Robustness over cleverness — never a throw.
      return answerAction(choice, { kind: 'confirm', yes: false });
  }
}

// --- card selection ---------------------------------------------------------------

/**
 * How many options to take when the request allows a range. Selecting is good
 * under `'gain'` (take as many as allowed) and costs you under `'loss'` or with no
 * steer (take as few as allowed).
 */
function selectionSize(choice: { min: number; max: number; valence: PendingChoice['valence'] }): number {
  return choice.valence === 'gain' ? choice.max : choice.min;
}

function answerSelectCards(state: GameState, choice: SelectCardsChoice, weights: HeuristicWeights): ChoiceAnswer {
  // Score every candidate, then sort BEST FIRST. `ordered` choices use exactly this
  // order (first = the position that comes up soonest — top of library, drawn
  // first), so the good card is the one we see again first.
  const context = cardValueContext(state);
  const scored = choice.candidates.map((option, index) => ({
    instanceId: option.instanceId,
    index,
    value: cardValue(findInstance(state, option.instanceId), weights, context),
  }));
  scored.sort((a, b) => b.value - a.value || a.index - b.index);

  const take = selectionSize(choice);
  // 'gain' keeps the best; 'loss' gives up the worst (the tail of the same list),
  // still best-first within the picked set so an ordering lands the right way up.
  const picked = choice.valence === 'loss' ? scored.slice(scored.length - take) : scored.slice(0, take);
  return { kind: 'selectCards', instanceIds: picked.map((p) => p.instanceId) };
}

// --- players / modes / yes-no ------------------------------------------------------

/**
 * Choose players. Being selected is bad under `'loss'` (point it at the opponent)
 * and good under `'gain'` (take it yourself); with no steer, take the smallest
 * legal selection in the offered order.
 */
function answerSelectPlayers(choice: SelectPlayersChoice): ChoiceAnswer {
  const take = selectionSize(choice);
  const preferred: PlayerId | undefined =
    choice.valence === 'loss' ? opponentOf(choice.chooser) : choice.valence === 'gain' ? choice.chooser : undefined;
  // Preferred seat first (when it is actually on offer), then the rest in the
  // order the choice listed them — a stable, RNG-free ordering.
  const ordered = preferred
    ? [...choice.candidates].sort((a, b) => Number(b === preferred) - Number(a === preferred))
    : choice.candidates;
  return { kind: 'selectPlayers', players: ordered.slice(0, take) };
}

/**
 * Choose modes — EVALUATE each one on this board and take the best allowed set.
 *
 * The choice itself carries only opaque labels, so the meaning is recovered from
 * the modal card's own data (`modeEffectsFor`) and each mode is priced by what its
 * effects would actually do right now (`valueOfEffects`, in the pilot's existing
 * score vocabulary). That is the difference between Cryptic Command countering a
 * spell that is not there / bouncing a Forest, and drawing the card that wins the
 * long game.
 *
 * Three rules, in order:
 *   1. A `'loss'` valence inverts everything (somebody is making us choose): take
 *      the FEWEST allowed, and the worst of them.
 *   2. Otherwise take every mode worth more than doing nothing, up to `max`…
 *   3. …but never fewer than `min`, filling the shortfall with the best of the
 *      rest — a modal spell with a floor still has to name that many modes.
 *
 * Ties break on printed order, so the answer is fully deterministic. A card whose
 * modes cannot be read scores every mode zero, which degrades to exactly the old
 * printed-order behaviour rather than to anything illegal.
 */
function answerChooseModes(state: GameState, choice: ChooseModesChoice, weights: HeuristicWeights): ChoiceAnswer {
  const byId = new Map(modeEffectsFor(state, choice.sourceInstanceId).map((m) => [m.id, m.effects]));
  const context = resolutionValueContext(state, choice.chooser, weights, cardValueContext(state));
  const scored = choice.modes.map((mode, index) => ({
    id: mode.id,
    index,
    value: valueOfEffects(byId.get(mode.id) ?? [], context),
  }));
  // Best first (worst first on a loss), printed order breaking every tie.
  const worstFirst = choice.valence === 'loss';
  scored.sort((a, b) => (worstFirst ? a.value - b.value : b.value - a.value) || a.index - b.index);

  const take = worstFirst
    ? choice.min
    : Math.max(choice.min, Math.min(choice.max, scored.filter((m) => m.value > NO_MODE_VALUE).length));
  // Answer in printed order: the engine runs chosen modes as printed anyway, and
  // it keeps the answer readable in the event log.
  const picked = scored.slice(0, take).sort((a, b) => a.index - b.index);
  return { kind: 'chooseModes', modeIds: picked.map((m) => m.id) };
}

/** The value of a mode that does nothing at all — the bar a mode must clear. */
const NO_MODE_VALUE = 0;

/**
 * Answer a "you may". A `'gain'` is taken, a `'loss'` declined; an unmarked one
 * falls back to the tunable `choiceConfirmNeutralYes` — which defaults to yes,
 * because an optional clause printed on a card you chose to cast is normally the
 * upside you cast it for.
 */
function answerConfirm(choice: ConfirmChoice, weights: HeuristicWeights): ChoiceAnswer {
  if (choice.valence === 'gain') return { kind: 'confirm', yes: true };
  if (choice.valence === 'loss') return { kind: 'confirm', yes: false };
  return { kind: 'confirm', yes: weights.choiceConfirmNeutralYes };
}
