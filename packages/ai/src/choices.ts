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
 * SCRY / SURVEIL is the third kind valence alone cannot answer, and for a
 * different reason again: the question is not "how many of these do I want?"
 * but "is THIS card worth drawing next?", asked once per looked-at card. The
 * policy is deliberately one rule with one number — keep every card whose
 * `cardValue` clears `scryKeepValueThreshold`, bottom (or bin) the rest,
 * keeping the survivors best-first because the answer is `ordered` and first =
 * drawn first. That rule is not arbitrary: `cardValue` already prices a land by
 * whether its controller still NEEDS lands, so the threshold makes the pilot
 * bottom lands exactly when it is flooded and keep them while it is short —
 * the decision that carries most of a scry's real value. What it deliberately
 * does NOT do is reason about the curve (a seven-drop with three lands out is
 * kept), or about what the opponent is representing; both need the search
 * pilots' machinery, not a per-card ruler.
 *
 * Determinism: no `Math.random`, no wall clock. Every comparison falls back to
 * `instanceId` / option index, so equal-scoring options break ties in a fixed
 * order and the same seed reproduces the same answers.
 */

import type {
  CardInstance,
  ChoiceAnswer,
  ChooseModesChoice,
  EffectRef,
  InstanceId,
  StackObject,
  ChooseNumberChoice,
  ConfirmChoice,
  GameAction,
  GameState,
  PayLifeChoice,
  PayManaChoice,
  PendingChoice,
  SelectTargetsChoice,
  PlayerId,
  SelectCardsChoice,
  SelectPlayersChoice,
} from '@jonny-boi/core';
import { convertedManaCost, defaultAnswerFor, isLand, modeById, nextUnaimedPick, opponentOf } from '@jonny-boi/core';
import { cardValue, cardValueContext, findInstance } from './card-value.js';
import { modeEffectsFor, resolutionValueContext, valueOfEffects, valueOfMode } from './effect-value.js';
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
    case 'payMana':
      return answerAction(choice, answerPayMana(choice, weights));
    case 'payLife':
      return answerAction(choice, answerPayLife(state, choice, weights));
    case 'chooseNumber':
      return answerAction(choice, answerChooseNumber(choice));
    case 'selectTargets':
      return answerAction(choice, answerSelectTargets(state, choice, weights));
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

/**
 * THE TUTOR / COST POLICY, in one place, because a card selection is now asked by
 * three quite different printed things and they must not each grow an opinion:
 *
 *  - **A LIBRARY SEARCH** (`fromZone: 'library'`, valence `'gain'`) — the pilot
 *    may take any card in its own deck, so raw card value alone would fetch the
 *    deck's biggest bomb on turn two and sit on it. Candidates out of casting
 *    reach are discounted by {@link HeuristicWeights.tutorUncastablePenalty}
 *    (see that weight for why a discount and not a ban), so the answer is "the
 *    best card I can actually use soon", falling back to the best card outright
 *    when nothing is reachable. A ROUTED search (Cultivate's "one onto the
 *    battlefield and the other into your hand") is `ordered`, and this same
 *    best-first order IS the routing: the better card takes the first printed
 *    destination, which for every printed card of that shape is the battlefield.
 *  - **A COST** — a mandatory additional cost's sacrifice/discard, and every
 *    other `'loss'` selection: give up the WORST qualifying card. That is the
 *    tail of the same one sorted list, so there is exactly one ranking in this
 *    file and a card cannot be "best" for one question and "worst" for another.
 *  - **A SCRY/SURVEIL look** — a per-card verdict, not a count; see below.
 */
function answerSelectCards(state: GameState, choice: SelectCardsChoice, weights: HeuristicWeights): ChoiceAnswer {
  // Score every candidate, then sort BEST FIRST. `ordered` choices use exactly this
  // order (first = the position that comes up soonest — top of library, drawn
  // first), so the good card is the one we see again first.
  const context = cardValueContext(state);
  // The reach test is computed once, and ONLY for a genuine library SEARCH — the
  // one selection where every candidate is a card the pilot would have to cast
  // later. The other two library questions are deliberately excluded, because
  // their candidates are not being acquired at all:
  //   - a SCRY/SURVEIL look (`keepOnTop`) decides where cards already on top go;
  //   - a REORDER (Ponder's "put them back in any order") puts every card back,
  //     which is why its floor equals its ceiling. A search's floor is ZERO —
  //     a search may always fail to find — and that is what tells them apart.
  const isLibrarySearch =
    choice.fromZone === 'library' && choice.valence === 'gain' && choice.keepOnTop !== true && choice.min === 0;
  const reach = isLibrarySearch ? castingReach(state, choice.chooser, weights) : undefined;
  const scored = choice.candidates.map((option, index) => {
    const card = findInstance(state, option.instanceId);
    const base = cardValue(card, weights, context);
    return {
      instanceId: option.instanceId,
      index,
      value: reach !== undefined && !withinCastingReach(card, reach) ? base - weights.tutorUncastablePenalty : base,
    };
  });
  scored.sort((a, b) => b.value - a.value || a.index - b.index);

  // A SCRY/SURVEIL look is not a "how many" question — it is a per-card verdict,
  // so it is answered by a threshold rather than by a count. See `scryKeepPicks`.
  if (choice.keepOnTop === true) {
    const kept = scored.filter((card) => card.value > weights.scryKeepValueThreshold);
    return { kind: 'selectCards', instanceIds: kept.map((p) => p.instanceId) };
  }

  const take = selectionSize(choice);
  // 'gain' keeps the best; 'loss' gives up the worst (the tail of the same list),
  // still best-first within the picked set so an ordering lands the right way up.
  const picked = choice.valence === 'loss' ? scored.slice(scored.length - take) : scored.slice(0, take);
  return { kind: 'selectCards', instanceIds: picked.map((p) => p.instanceId) };
}

/**
 * The mana value a pilot can plausibly pay this turn or next: the lands it
 * controls plus {@link HeuristicWeights.tutorReachableManaLead}.
 *
 * Counted from LANDS rather than from the floating pool because a tutor resolves
 * mid-turn, after the mana that paid for it is already spent — the pool is empty
 * exactly when this question is asked, and reading it would call every card
 * unreachable.
 */
function castingReach(state: GameState, who: PlayerId, weights: HeuristicWeights): number {
  let lands = 0;
  for (const perm of state.battlefield) {
    if (perm.controller === who && isLand(perm.def)) lands += 1;
  }
  return lands + weights.tutorReachableManaLead;
}

/**
 * Whether a searched card is one the pilot could cast within its reach. A LAND
 * always is — playing it costs no mana — and so is a card with no printed cost.
 */
function withinCastingReach(card: CardInstance | undefined, reach: number): boolean {
  if (!card) return true; // unknown: never penalised on a guess
  if (isLand(card.def)) return true;
  return (card.def.cost ? convertedManaCost(card.def.cost) : 0) <= reach;
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
  const byId = new Map(modeEffectsFor(state, choice.sourceInstanceId).map((m) => [m.id, m]));
  const context = castValueContext(state, choice.chooser, weights);
  const scored = choice.modes.map((mode, index) => {
    const authored = byId.get(mode.id);
    return {
      id: mode.id,
      index,
      // Priced AIMED — a targeting mode is worth what its best legal target is
      // worth, which is what stops the pilot choosing "counter target spell"
      // when the only spell on the stack is its own (see `valueOfMode`).
      value: authored ? valueOfMode(authored, context) : NO_MODE_VALUE,
    };
  });
  // Best first (worst first on a loss), printed order breaking every tie.
  const worstFirst = choice.valence === 'loss';
  scored.sort((a, b) => (worstFirst ? a.value - b.value : b.value - a.value) || a.index - b.index);

  if (choice.allowRepeats) {
    // With repeats, "the best set" is simply the best mode taken as often as
    // allowed — there is no diminishing return in the value model, so mixing
    // could only lower the total. Still bounded below by `min`.
    const best = scored[worstFirst ? 0 : 0];
    const take = worstFirst
      ? choice.min
      : Math.max(choice.min, best && best.value > NO_MODE_VALUE ? choice.max : choice.min);
    return {
      kind: 'chooseModes',
      modeIds: new Array<string>(take).fill(best?.id ?? (choice.modes[0]?.id ?? '')),
    };
  }

  const take = worstFirst
    ? choice.min
    : Math.max(choice.min, Math.min(choice.max, scored.filter((m) => m.value > NO_MODE_VALUE).length));
  // Answer in printed order: the engine runs chosen modes as printed anyway, and
  // it keeps the answer readable in the event log.
  const picked = scored.slice(0, take).sort((a, b) => a.index - b.index);
  return { kind: 'chooseModes', modeIds: picked.map((m) => m.id) };
}

/**
 * The value context for a question asked while a spell is being CAST.
 *
 * `resolutionValueContext` reads `state.resolution.targets`, and there is no
 * resolution here — the spell is still being announced. Passing an empty target
 * list is not a shortcut but the truth: nothing has been aimed yet, and every
 * scorer that cares supplies its own candidate target.
 */
function castValueContext(state: GameState, player: PlayerId, weights: HeuristicWeights) {
  // `cardValueContext` already built the board's continuous aggregate; the effect
  // scorer reads P/T through that same one rather than through a second — or, as
  // it did before `board-stats.ts`, through none at all.
  const cards = cardValueContext(state);
  return {
    state,
    player,
    targets: [] as readonly (InstanceId | PlayerId)[],
    weights,
    cards,
    index: cards.index,
  };
}

/**
 * Aim a triggered ability — "when ~ enters, it deals 2 damage to any target".
 *
 * Valence cannot answer this one, and neither can a rule of thumb about whose
 * permanent it is: the SAME question ("which creature?") wants the opponent's
 * best body for a damage trigger and the pilot's own best body for a pump. So
 * each candidate is priced by what the ability's OWN effects would do to it
 * (`valueOfEffects`, the same scorer that picks a modal spell's modes), and the
 * best-scoring target wins.
 *
 * The ability is found from the stack by its `awaitingTargets` marker — the
 * engine parks exactly one targeting question at a time, so there is no ambiguity
 * — and an ability whose effects cannot be priced scores every candidate zero and
 * degrades to the first offered, which is legal and deterministic rather than
 * clever.
 */
function answerSelectTargets(
  state: GameState,
  choice: SelectTargetsChoice,
  weights: HeuristicWeights,
): ChoiceAnswer {
  // TWO things park a `selectTargets` question, and they are aimed by different
  // data. A spell being CAST is aiming one announced MODE (its effects are on
  // the card, indexed by which pick is still unaimed); a trigger going on the
  // stack is aiming its own ability. Checked in that order because a modal cast
  // can be sitting on the stack while nothing is triggering, and the pilot must
  // price the mode it is actually being asked about.
  const casting = state.stack.find(
    (object): object is Extract<typeof object, { kind: 'spell' }> =>
      object.kind === 'spell' && object.awaitingCastChoice === 'modeTarget',
  );
  const castingEffects = castingModeEffects(casting);
  const aiming = state.stack.find(
    (object): object is Extract<typeof object, { kind: 'trigger' }> =>
      object.kind === 'trigger' && object.awaitingTargets !== undefined,
  );
  const effects = castingEffects ?? aiming?.effects ?? [];
  const base = casting
    ? castValueContext(state, choice.chooser, weights)
    : resolutionValueContext(state, choice.chooser, weights, cardValueContext(state));
  const scored = choice.candidates.map((candidate, index) => ({
    ref: candidate.ref,
    index,
    // Score the ability AS IF aimed here. Everything else about the board is the
    // same in every branch, so the differences are exactly what the target buys.
    value: valueOfEffects(effects, { ...base, targets: [candidate.ref] }),
  }));
  // A 'loss' valence would mean somebody is making US aim it, so take the worst.
  const worstFirst = choice.valence === 'loss';
  scored.sort((a, b) => (worstFirst ? a.value - b.value : b.value - a.value) || a.index - b.index);
  return { kind: 'selectTargets', targets: scored.slice(0, choice.max).map((s) => s.ref) };
}

/**
 * The effects of the announced mode a casting spell is currently aiming, or
 * `undefined` when that is not what is being asked.
 *
 * The pick being aimed is found by core's own `nextUnaimedPick` — the very rule
 * the engine raised the question by — so the pilot cannot price one mode while
 * answering for another (which is exactly what would happen on a spell that
 * chose the same targeting mode twice).
 */
function castingModeEffects(
  casting: Extract<StackObject, { kind: 'spell' }> | undefined,
): readonly EffectRef[] | undefined {
  if (!casting) return undefined;
  const picks = casting.modePicks ?? [];
  const index = nextUnaimedPick(casting.card.def, picks);
  if (index < 0) return undefined;
  const pick = picks[index];
  return pick ? modeById(casting.card.def, pick.modeId)?.effects : undefined;
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

/**
 * Answer "pay {N}, or lose the thing this is attached to".
 *
 * The same valence rule as a "you may", with one hard gate in front of it: an
 * UNAFFORDABLE payment is declined, always. That branch is not judgement — paying
 * is not a legal answer there — and asserting it here rather than relying on the
 * engine's own clamp keeps the pilot's answer legal on its own terms.
 *
 * Otherwise: `'gain'` (paying keeps something of yours, which is every
 * "unless its controller pays" card) is paid, `'loss'` declined, and an unmarked
 * one follows `choicePayManaNeutralYes`.
 *
 * ⚠️ What this deliberately does NOT do is compare the cost to what is at stake.
 * That comparison needs the *stake* — which card dies if you decline — and the
 * choice does not carry it (nor should it: a choice is renderable by a UI that
 * knows no rules). A pilot that reasons about the stake belongs with the pilots
 * that search, not in the valence rule that answers every card ever printed.
 */
/**
 * Answer "pay N life, or it enters tapped" (a shockland; any pay-life rider).
 *
 * Life is a resource with a cliff in it, so unlike a mana payment this is not a
 * plain valence call: paying 2 at 20 life buys a full turn of tempo, paying 2 at
 * 4 life halves the burn spells needed to kill you. The rule is the pilot's
 * existing danger line — pay while the REMAINING total stays above
 * `desperateLifeThreshold`, decline once it would not. That is also exactly when
 * a human stops shocking themselves.
 *
 * An unaffordable payment is declined unconditionally (paying is not even
 * legal), and a `'loss'` valence — somebody else making us consider it — is
 * declined like every other loss.
 */
function answerPayLife(state: GameState, choice: PayLifeChoice, weights: HeuristicWeights): ChoiceAnswer {
  if (!choice.affordable) return { kind: 'payLife', pay: false };
  if (choice.valence === 'loss') return { kind: 'payLife', pay: false };
  const remaining = state.players[choice.chooser].life - choice.amount;
  return { kind: 'payLife', pay: remaining > weights.desperateLifeThreshold };
}

/**
 * Answer "choose a number" — today, always "choose a value for X" at cast time.
 *
 * The engine already bounded the range by what the board can actually fund, so
 * every value on offer is legal and paid-for. The steer is the valence: `'gain'`
 * (the engine's marking for X — more damage, more cards, more life is the upside
 * the spell was cast for) takes the MAXIMUM affordable; `'loss'` — somebody else
 * making us choose — takes the minimum; an unmarked question takes the minimum,
 * the answer that spends nothing without a reason to spend.
 *
 * What this deliberately does NOT do is hold mana back for a second spell —
 * that comparison needs the rest of the hand priced against the marginal X,
 * which belongs to the pilots that search, not to the valence rule.
 */
function answerChooseNumber(choice: ChooseNumberChoice): ChoiceAnswer {
  return { kind: 'chooseNumber', value: choice.valence === 'gain' ? choice.max : choice.min };
}

function answerPayMana(choice: PayManaChoice, weights: HeuristicWeights): ChoiceAnswer {
  if (!choice.affordable) return { kind: 'payMana', pay: false };
  if (choice.valence === 'gain') return { kind: 'payMana', pay: true };
  if (choice.valence === 'loss') return { kind: 'payMana', pay: false };
  return { kind: 'payMana', pay: weights.choicePayManaNeutralYes };
}
