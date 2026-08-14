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
 * Determinism: no `Math.random`, no wall clock. Every comparison falls back to
 * `instanceId` / option index, so equal-scoring options break ties in a fixed
 * order and the same seed reproduces the same answers.
 */

import type {
  CardInstance,
  ChoiceAnswer,
  ChooseModesChoice,
  ConfirmChoice,
  GameAction,
  GameState,
  InstanceId,
  PendingChoice,
  PlayerId,
  SelectCardsChoice,
  SelectPlayersChoice,
} from '@jonny-boi/core';
import {
  convertedManaCost,
  defaultAnswerFor,
  effectivePower,
  effectiveToughness,
  isCreature,
  isLand,
  opponentOf,
  PLAYER_IDS,
  playerZone,
} from '@jonny-boi/core';
import type { HeuristicWeights } from './weights.js';

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
      return answerAction(choice, answerChooseModes(choice));
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
  const scored = choice.candidates.map((option, index) => ({
    instanceId: option.instanceId,
    index,
    value: cardValue(findInstance(state, option.instanceId), weights),
  }));
  scored.sort((a, b) => b.value - a.value || a.index - b.index);

  const take = selectionSize(choice);
  // 'gain' keeps the best; 'loss' gives up the worst (the tail of the same list),
  // still best-first within the picked set so an ordering lands the right way up.
  const picked = choice.valence === 'loss' ? scored.slice(scored.length - take) : scored.slice(0, take);
  return { kind: 'selectCards', instanceIds: picked.map((p) => p.instanceId) };
}

/**
 * What a card is worth to its controller — the one place the pilot puts a number
 * on "which of these cards would I rather keep". Deliberately coarse and fully
 * weight-driven (DESIGN §1: no magic numbers); it only has to order candidates,
 * not price them.
 *
 * An unknown instance (already gone from the zone it was offered from — a choice
 * can outlive its candidates) scores zero rather than blowing up.
 */
export function cardValue(card: CardInstance | undefined, weights: HeuristicWeights): number {
  if (!card) return 0;
  const def = card.def;
  if (isLand(def)) return weights.choiceLandValue;
  if (isCreature(def)) {
    const stats = effectivePower(card) + effectiveToughness(card);
    return weights.choiceCreatureBaseValue + stats * weights.choiceCreaturePerStatValue;
  }
  const manaValue = def.cost ? convertedManaCost(def.cost) : 0;
  return weights.choiceSpellBaseValue + manaValue * weights.choiceSpellPerManaValue;
}

/** Find a card instance anywhere in the state (battlefield, any player's zones). */
export function findInstance(state: GameState, id: InstanceId): CardInstance | undefined {
  for (const card of state.battlefield) if (card.instanceId === id) return card;
  for (const pid of PLAYER_IDS) {
    const player = state.players[pid];
    for (const zone of ['hand', 'library', 'graveyard', 'exile', 'command'] as const) {
      const cards = playerZone(player, zone);
      if (!cards) continue;
      for (const card of cards) if (card.instanceId === id) return card;
    }
  }
  return undefined;
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
 * Choose modes. Their labels are opaque text, so there is nothing to score: take
 * the largest allowed set (more modes is more spell) in the printed order, or the
 * smallest when selecting is the bad half of the deal.
 */
function answerChooseModes(choice: ChooseModesChoice): ChoiceAnswer {
  const take = selectionSize({ min: choice.min, max: choice.max, valence: choice.valence === 'loss' ? 'loss' : 'gain' });
  return { kind: 'chooseModes', modeIds: choice.modes.slice(0, take).map((m) => m.id) };
}

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
