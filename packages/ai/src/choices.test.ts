/**
 * Pilots answering player CHOICES.
 *
 * Two things have to be true for the choice system to be usable by the sim, and
 * both are asserted here. First, a pilot must ALWAYS have an answer — an
 * unanswered choice would hang a headless game, so every pilot answers every kind
 * from every position. Second, the answers must be sensible and DETERMINISTIC:
 * the lab's whole premise is that a win-rate delta means something, which it does
 * not if the AI throws away its best card or picks differently on a replay.
 *
 * The fixtures are inline card definitions again (the `ai` package may not depend
 * on `@jonny-boi/cards`), built from small primitives that ask through the choice
 * API — the same shapes as Brainstorm, Thoughtseize and a modal spell.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  cardOption,
  collectCardOptions,
  createGame,
  createRng,
  DEFAULT_RULES,
  generateLegalActions,
  normalizeChoiceRequest,
  opponentOf,
  serializeState,
  validateChoiceAnswer,
  type CardDefinition,
  type ChoiceRequest,
  type EffectContext,
  type EffectRegistry,
  type GameAction,
  type GameState,
  type InstanceId,
  type PendingChoice,
} from '@jonny-boi/core';
import { createEffectRegistry } from '@jonny-boi/core';
import type { EffectRef } from '@jonny-boi/core';
import { answerChoiceHeuristically, cardValue, cardValueContext, safeFallbackAction } from './choices.js';
import { resolutionValueContext, valueOfEffects } from './effect-value.js';
import { createHeuristicPilot } from './heuristic.js';
import { createMctsPilot } from './mcts.js';
import { FAST_MCTS_CONFIG } from './mcts-config.js';
import { createRandomPilot } from './random.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';
import { creatureDef, giveHand, landDef, putOnBattlefield, putOnStack } from './test-support.js';

const WEIGHTS = DEFAULT_HEURISTIC_WEIGHTS;
const SOURCE = { id: 7, sourceInstanceId: 1, sourceName: 'Test Card' };

/** Normalise a request the way the engine does, so tests see real parked choices. */
function park(request: ChoiceRequest): PendingChoice {
  const choice = normalizeChoiceRequest(request, SOURCE);
  if (!choice) throw new Error('expected a normalised choice');
  return choice;
}

// --- fixture cards ------------------------------------------------------------------

function choiceRegistry(): EffectRegistry {
  const reg = createEffectRegistry();
  reg.register('drawCards', (ctx: EffectContext) => {
    const count = (ctx.params.count as number | undefined) ?? 1;
    const player = ctx.state.players[ctx.controller];
    for (let i = 0; i < count; i++) {
      const top = player.library.shift();
      if (!top) break;
      top.zone = 'hand';
      player.hand.push(top);
      ctx.emit({ type: 'drawCard', player: ctx.controller, instanceId: top.instanceId });
    }
  });
  reg.register('gainLife', (ctx: EffectContext) => {
    const amount = (ctx.params.amount as number | undefined) ?? 1;
    ctx.state.players[ctx.controller].life += amount;
    ctx.emit({ type: 'gainLife', player: ctx.controller, amount });
  });
  /** The opponent names one of their own nonland cards to discard. */
  reg.register('opponentDiscardsChosen', (ctx: EffectContext) => {
    const victim = opponentOf(ctx.controller);
    const chosen = ctx.chooseCards({
      chooser: victim,
      prompt: 'Choose a nonland card to discard',
      candidates: collectCardOptions(ctx.state, 'hand', { controller: victim, filter: { noneOfTypes: ['land'] } }),
      min: 1,
      max: 1,
      valence: 'loss',
      fromZone: 'hand',
    });
    if (!chosen) return;
    const player = ctx.state.players[victim];
    for (const id of chosen) {
      const index = player.hand.findIndex((c) => c.instanceId === id);
      if (index < 0) continue;
      const [card] = player.hand.splice(index, 1);
      if (!card) continue;
      card.zone = 'graveyard';
      player.graveyard.push(card);
      ctx.emit({ type: 'zoneChange', instanceId: card.instanceId, from: 'hand', to: 'graveyard' });
    }
  });
  /** A "you may" whose payoff is drawing a card. */
  reg.register('mayDraw', (ctx: EffectContext) => {
    const yes = ctx.confirm({ prompt: 'You may draw a card', valence: 'gain' });
    if (yes === undefined) return;
    if (!yes) return;
    ctx.enqueueEffects([{ primitive: 'drawCards', params: { count: 1 } }]);
  });
  /** Choose N of the listed modes and run them. */
  reg.register('modal', (ctx: EffectContext) => {
    const modes = (ctx.params.modes as ReadonlyArray<{ id: string; label: string; effects: CardDefinition['effects'] }>) ?? [];
    const count = (ctx.params.count as number | undefined) ?? 1;
    const chosen = ctx.chooseModes({
      prompt: 'Choose two —',
      modes: modes.map((m) => ({ id: m.id, label: m.label })),
      min: count,
      max: count,
      valence: 'gain',
    });
    if (!chosen) return;
    ctx.enqueueEffects(chosen.flatMap((id) => modes.find((m) => m.id === id)?.effects ?? []));
  });
  return reg;
}

function freeInstant(id: string, effects: CardDefinition['effects']): CardDefinition {
  return { id, name: id, types: ['instant'], timing: 'instant', effects };
}

const DISCARD_SPELL = freeInstant('Thoughtseize', [{ primitive: 'opponentDiscardsChosen' }]);
const MAY_SPELL = freeInstant('Optional Insight', [{ primitive: 'mayDraw' }]);
const MODAL_SPELL = freeInstant('Cryptic Command', [
  {
    primitive: 'modal',
    params: {
      count: 2,
      modes: [
        { id: 'draw', label: 'Draw', effects: [{ primitive: 'drawCards', params: { count: 1 } }] },
        { id: 'life', label: 'Gain 3 life', effects: [{ primitive: 'gainLife', params: { amount: 3 } }] },
        { id: 'draw2', label: 'Draw again', effects: [{ primitive: 'drawCards', params: { count: 1 } }] },
      ],
    },
  },
]);

const ISLAND = landDef('Island', 'U');
const BEAR = creatureDef('Bear', 2, 2);
const DRAGON = creatureDef('Dragon', 6, 6, { cost: { generic: 6 } });

// --- card ranking ---------------------------------------------------------------------

describe('card ranking (what "my best / my worst card" means)', () => {
  function instances(state: GameState, defs: readonly CardDefinition[]) {
    return giveHand(state, 'A', defs);
  }

  it('ranks a big creature over a small one, and both over a land', () => {
    const state = newGame().state;
    const [dragon, bear, island] = instances(state, [DRAGON, BEAR, ISLAND]);
    expect(cardValue(dragon, WEIGHTS)).toBeGreaterThan(cardValue(bear, WEIGHTS));
    expect(cardValue(bear, WEIGHTS)).toBeGreaterThan(cardValue(island, WEIGHTS));
  });

  it('scores an unknown/vanished card as zero rather than throwing', () => {
    expect(cardValue(undefined, WEIGHTS)).toBe(0);
  });
});

// --- the cleanup discard (CR 514.1) ------------------------------------------------

describe('discarding down to maximum hand size', () => {
  /** The cleanup discard as the ENGINE raises it: a `'loss'` selection of exactly `count`. */
  function cleanupDiscard(state: GameState, count: number): PendingChoice {
    return {
      ...park({
        kind: 'selectCards',
        chooser: 'A',
        prompt: `Cleanup: discard ${count}`,
        candidates: state.players.A.hand.map(cardOption),
        min: count,
        max: count,
        fromZone: 'hand',
        valence: 'loss',
      }),
      context: 'cleanupDiscard',
    };
  }

  /** The instance ids the pilot chooses to pitch, unwrapped from its action. */
  function discardAnswer(state: GameState, count: number): readonly InstanceId[] {
    const action = answerChoiceHeuristically(state, cleanupDiscard(state, count), WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectCards') {
      throw new Error(`expected a card selection, got ${action.kind}`);
    }
    return action.answer.instanceIds;
  }

  it('pitches the LEAST valuable card, not an arbitrary one', () => {
    const state = newGame().state;
    state.players.A.hand = [];
    const [dragon, bear, island] = giveHand(state, 'A', [DRAGON, BEAR, ISLAND]);
    // A pilot with plenty of lands already: the Island is the chaff.
    for (let i = 0; i < WEIGHTS.choiceLandsWanted; i++) putOnBattlefield(state, 'A', [ISLAND]);

    const answer = discardAnswer(state, 1);
    expect(answer).toEqual([island!.instanceId]);
    // …and emphatically not the cards it wants to cast.
    expect(answer).not.toContain(dragon!.instanceId);
    expect(answer).not.toContain(bear!.instanceId);
  });

  it('keeps its LAND when it is still short of mana — the board decides, not the card type', () => {
    // The same three cards, the same question, an unbuilt board: now the land is
    // the lifeline and the small creature is the thing to let go. A discard
    // policy that simply ranked by card type could not tell these two apart.
    const state = newGame().state;
    state.players.A.hand = [];
    const [, bear, island] = giveHand(state, 'A', [DRAGON, BEAR, ISLAND]);

    const answer = discardAnswer(state, 1);
    expect(answer).toEqual([bear!.instanceId]);
    expect(answer).not.toContain(island!.instanceId);
  });

  it('gives up exactly the number asked for, worst first', () => {
    const state = newGame().state;
    state.players.A.hand = [];
    const [dragon, bear, island] = giveHand(state, 'A', [DRAGON, BEAR, ISLAND]);
    for (let i = 0; i < WEIGHTS.choiceLandsWanted; i++) putOnBattlefield(state, 'A', [ISLAND]);

    const answer = discardAnswer(state, 2);
    expect(answer).toHaveLength(2);
    expect(new Set(answer)).toEqual(new Set([island!.instanceId, bear!.instanceId]));
    expect(answer).not.toContain(dragon!.instanceId);
  });

  it('is deterministic — the same hand answers the same way every time', () => {
    // The lab's premise is that a win-rate delta means something, which it does
    // not if a pilot discards differently on a replay of the same game.
    const state = newGame().state;
    state.players.A.hand = [];
    giveHand(state, 'A', [DRAGON, BEAR, ISLAND, BEAR, ISLAND]);
    const first = discardAnswer(state, 2);
    for (let i = 0; i < 5; i++) {
      expect(discardAnswer(state, 2)).toEqual(first);
    }
  });
});

// --- scry / surveil ----------------------------------------------------------------------

describe('the scry / surveil keep-on-top policy', () => {
  /**
   * A scry-shaped question over `defs` seated on top of A's library, with A
   * already controlling `lands` lands — the one board fact the policy turns on.
   */
  function scryChoice(defs: readonly CardDefinition[], lands: number) {
    const state = newGame().state;
    state.players.A.hand = [];
    if (lands > 0) putOnBattlefield(state, 'A', Array.from({ length: lands }, () => ISLAND));
    const looked = giveHand(state, 'A', defs);
    // Move them out of the hand and onto the top of the library, where a scry
    // actually looks.
    state.players.A.hand = [];
    for (const card of looked) card.zone = 'library';
    state.players.A.library = [...looked, ...state.players.A.library];
    const choice = park({
      kind: 'selectCards',
      chooser: 'A',
      prompt: 'keep on top',
      candidates: collectCardOptions(state, 'library', { controller: 'A', limit: defs.length, fromTop: true }),
      min: 0,
      max: defs.length,
      ordered: true,
      keepOnTop: true,
      valence: 'neutral',
      fromZone: 'library',
    });
    return { state, choice, looked };
  }

  function keptNames(state: GameState, choice: PendingChoice): string[] {
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectCards') throw new Error('wrong shape');
    return action.answer.instanceIds.map(
      (id) => state.players.A.library.find((c) => c.instanceId === id)!.def.name,
    );
  }

  it('BOTTOMS a land while flooded, and keeps the spells', () => {
    // A built mana base: another land is the card you do not want to draw next.
    const { state, choice } = scryChoice([ISLAND, BEAR], WEIGHTS.choiceLandsWanted);
    expect(keptNames(state, choice)).toEqual(['Bear']);
  });

  it('KEEPS a land while short of mana — the same card, the opposite answer', () => {
    const { state, choice } = scryChoice([ISLAND, BEAR], 0);
    // Both are worth keeping when the mana base is unbuilt, and the land is the
    // more urgent card, so it is ordered first (drawn first).
    expect(keptNames(state, choice)).toEqual(['Island', 'Bear']);
  });

  it('keeps the BEST card first — the answer order is the draw order', () => {
    const { state, choice } = scryChoice([BEAR, DRAGON], WEIGHTS.choiceLandsWanted);
    expect(keptNames(state, choice)).toEqual(['Dragon', 'Bear']);
  });

  it('bottoms EVERYTHING when nothing clears the bar, and that answer is legal', () => {
    const { state, choice } = scryChoice([ISLAND, ISLAND], WEIGHTS.choiceLandsWanted);
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice') throw new Error('wrong shape');
    expect(validateChoiceAnswer(choice, action.answer).ok).toBe(true);
    if (action.answer.kind !== 'selectCards') throw new Error('wrong shape');
    expect(action.answer.instanceIds).toHaveLength(0);
  });

  it('is deterministic — the same board answers identically every time', () => {
    const first = scryChoice([ISLAND, BEAR, DRAGON], WEIGHTS.choiceLandsWanted);
    const second = scryChoice([ISLAND, BEAR, DRAGON], WEIGHTS.choiceLandsWanted);
    expect(keptNames(first.state, first.choice)).toEqual(keptNames(second.state, second.choice));
  });
});

// --- the tutor / cost policy -------------------------------------------------------------

describe('the tutor policy (what a library search actually fetches)', () => {
  /** A "search your library" question over `defs`, with A controlling `lands` lands. */
  function tutorChoice(defs: readonly CardDefinition[], lands: number) {
    const state = newGame().state;
    state.players.A.hand = [];
    if (lands > 0) putOnBattlefield(state, 'A', Array.from({ length: lands }, () => ISLAND));
    const inDeck = giveHand(state, 'A', defs);
    state.players.A.hand = [];
    for (const card of inDeck) card.zone = 'library';
    state.players.A.library = [...inDeck, ...state.players.A.library];
    const choice = park({
      kind: 'selectCards',
      chooser: 'A',
      prompt: 'Search your library for 1 card(s)',
      candidates: inDeck.map((card) => ({ instanceId: card.instanceId, name: card.def.name })),
      min: 0,
      max: 1,
      valence: 'gain',
      fromZone: 'library',
    });
    return { state, choice };
  }

  function fetched(state: GameState, choice: PendingChoice): string[] {
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectCards') throw new Error('wrong shape');
    return action.answer.instanceIds.map((id) => state.players.A.library.find((c) => c.instanceId === id)!.def.name);
  }

  it('fetches the card it can actually CAST, not the biggest bomb in the deck', () => {
    // One land in play: the Dragon costs {6} and is dead for five turns.
    const { state, choice } = tutorChoice([BEAR, DRAGON], 1);
    expect(fetched(state, choice)).toEqual(['Bear']);
  });

  it('…and fetches the bomb once the mana is there — the same two cards, the opposite answer', () => {
    const { state, choice } = tutorChoice([BEAR, DRAGON], 6);
    expect(fetched(state, choice)).toEqual(['Dragon']);
  });

  it('reaches ONE mana past the board, because the land drop is mana it is about to have', () => {
    const fiveDrop = creatureDef('Wurm', 5, 5, { cost: { generic: 5 } });
    // Four lands + the turn's land drop == {5}, so the Wurm is in reach.
    const { state, choice } = tutorChoice([BEAR, fiveDrop], 5 - WEIGHTS.tutorReachableManaLead);
    expect(fetched(state, choice)).toEqual(['Wurm']);
  });

  it('still fetches the BEST card when nothing is in reach — an unreachable card beats no card', () => {
    const { state, choice } = tutorChoice([DRAGON, creatureDef('Titan', 8, 8, { cost: { generic: 8 } })], 0);
    expect(fetched(state, choice)).toEqual(['Titan']);
  });

  it('never penalises a LAND — playing one costs no mana', () => {
    const { state, choice } = tutorChoice([ISLAND, DRAGON], 0);
    expect(fetched(state, choice)).toEqual(['Island']);
  });

  it('the reach test applies ONLY to a library search — a hand selection is unaffected', () => {
    const state = newGame().state;
    state.players.A.hand = [];
    const held = giveHand(state, 'A', [BEAR, DRAGON]);
    const choice = park({
      kind: 'selectCards',
      chooser: 'A',
      prompt: 'Choose a card in your hand',
      candidates: held.map((card) => ({ instanceId: card.instanceId, name: card.def.name })),
      min: 1,
      max: 1,
      valence: 'gain',
      fromZone: 'hand',
    });
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectCards') throw new Error('wrong shape');
    // Uncastable or not, the Dragon is the better card in hand and stays the pick.
    expect(state.players.A.hand.find((c) => c.instanceId === action.answer.instanceIds[0])?.def.name).toBe('Dragon');
  });

  it('leaves a Ponder-style REORDER alone — every card goes back, so nothing is being acquired', () => {
    // The floor equalling the ceiling is what makes it a reorder and not a
    // search: this is "in what order do these go back", not "which do I take".
    const state = newGame().state;
    state.players.A.hand = [];
    const looked = giveHand(state, 'A', [BEAR, DRAGON]);
    state.players.A.hand = [];
    for (const card of looked) card.zone = 'library';
    state.players.A.library = [...looked, ...state.players.A.library];
    const choice = park({
      kind: 'selectCards',
      chooser: 'A',
      prompt: 'Put the top 2 card(s) of your library back in any order',
      candidates: looked.map((card) => ({ instanceId: card.instanceId, name: card.def.name })),
      min: 2,
      max: 2,
      ordered: true,
      valence: 'gain',
      fromZone: 'library',
    });
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectCards') throw new Error('wrong shape');
    const ordered = action.answer.instanceIds.map(
      (id) => state.players.A.library.find((c) => c.instanceId === id)!.def.name,
    );
    // Unchanged by the tutor policy: the best card is still put on top.
    expect(ordered).toEqual(['Dragon', 'Bear']);
  });

  it('pays a COST with the worst qualifying permanent, not the best', () => {
    const state = newGame().state;
    state.players.A.hand = [];
    const board = putOnBattlefield(state, 'A', [BEAR, DRAGON]);
    const choice = park({
      kind: 'selectCards',
      chooser: 'A',
      prompt: 'Village Rites: Sacrifice creature',
      candidates: board.map((card) => ({ instanceId: card.instanceId, name: card.def.name })),
      min: 1,
      max: 1,
      valence: 'loss',
      fromZone: 'battlefield',
    });
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectCards') throw new Error('wrong shape');
    expect(state.battlefield.find((c) => c.instanceId === action.answer.instanceIds[0])?.def.name).toBe('Bear');
  });
});

// --- answering each kind ----------------------------------------------------------------

describe('the heuristic answers every choice kind sensibly', () => {
  function handChoice(valence: 'gain' | 'loss' | 'neutral', min = 1, max = min, ordered = false) {
    const state = newGame().state;
    state.players.A.hand = [];
    // A BUILT mana base, which is what makes "the land is the worst card in hand"
    // true. (Short of mana the ranking deliberately inverts — see the board-aware
    // ranking tests below.)
    putOnBattlefield(state, 'A', Array.from({ length: WEIGHTS.choiceLandsWanted }, () => ISLAND));
    const cards = giveHand(state, 'A', [BEAR, ISLAND, DRAGON]);
    const choice = park({
      kind: 'selectCards',
      chooser: 'A',
      prompt: 'pick',
      candidates: collectCardOptions(state, 'hand', { controller: 'A' }),
      min,
      max,
      ordered,
      valence,
    });
    return { state, choice, cards };
  }

  it('gives up its WORST card when being selected is a loss (a discard)', () => {
    const { state, choice } = handChoice('loss');
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    expect(action.kind).toBe('answerChoice');
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectCards') throw new Error('wrong shape');
    const picked = action.answer.instanceIds[0];
    expect(state.players.A.hand.find((c) => c.instanceId === picked)!.def.name).toBe('Island');
  });

  it('takes its BEST card when being selected is a gain (a graveyard return)', () => {
    const { state, choice } = handChoice('gain');
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectCards') throw new Error('wrong shape');
    expect(state.players.A.hand.find((c) => c.instanceId === action.answer.instanceIds[0])!.def.name).toBe('Dragon');
  });

  it('takes as many as allowed on a gain, and as few as allowed on a loss', () => {
    const gain = handChoice('gain', 0, 3);
    const gainAction = answerChoiceHeuristically(gain.state, gain.choice, WEIGHTS);
    if (gainAction.kind !== 'answerChoice' || gainAction.answer.kind !== 'selectCards') throw new Error('wrong shape');
    expect(gainAction.answer.instanceIds).toHaveLength(3);

    const loss = handChoice('loss', 0, 3);
    const lossAction = answerChoiceHeuristically(loss.state, loss.choice, WEIGHTS);
    if (lossAction.kind !== 'answerChoice' || lossAction.answer.kind !== 'selectCards') throw new Error('wrong shape');
    expect(lossAction.answer.instanceIds).toHaveLength(0);
  });

  it('orders an ORDERED answer best-first (the card seen soonest is the good one)', () => {
    const { state, choice } = handChoice('loss', 2, 2, true);
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectCards') throw new Error('wrong shape');
    const picked = action.answer.instanceIds.map((id) => state.players.A.hand.find((c) => c.instanceId === id)!.def.name);
    // Two worst cards go back (Bear + Island), best of those two first.
    expect(picked).toEqual(['Bear', 'Island']);
  });

  it('picks the MAXIMUM affordable X on a gain, and the minimum otherwise', () => {
    const state = newGame().state;
    // "Choose a value for X" as the engine parks it at cast time: 'gain', ranged
    // by what the board can fund.
    const gain = park({ kind: 'chooseNumber', chooser: 'A', prompt: 'Choose X', min: 0, max: 5, valence: 'gain' });
    const gainAction = answerChoiceHeuristically(state, gain, WEIGHTS);
    if (gainAction.kind !== 'answerChoice' || gainAction.answer.kind !== 'chooseNumber') throw new Error('wrong shape');
    expect(gainAction.answer.value).toBe(5);
    // The answer is legal by the engine's own validator — never an illegal X.
    expect(validateChoiceAnswer(gain, gainAction.answer).ok).toBe(true);

    const neutral = park({ kind: 'chooseNumber', chooser: 'A', prompt: 'Choose X', min: 0, max: 5 });
    const neutralAction = answerChoiceHeuristically(state, neutral, WEIGHTS);
    if (neutralAction.kind !== 'answerChoice' || neutralAction.answer.kind !== 'chooseNumber') {
      throw new Error('wrong shape');
    }
    expect(neutralAction.answer.value).toBe(0); // no steer ⇒ spend nothing
  });

  it('points a "loss" player choice at the opponent and a "gain" at itself', () => {
    const state = newGame().state;
    const loss = park({ kind: 'selectPlayers', chooser: 'A', prompt: 'who', candidates: ['A', 'B'], valence: 'loss' });
    const gain = park({ kind: 'selectPlayers', chooser: 'A', prompt: 'who', candidates: ['A', 'B'], valence: 'gain' });
    const lossAction = answerChoiceHeuristically(state, loss, WEIGHTS);
    const gainAction = answerChoiceHeuristically(state, gain, WEIGHTS);
    if (lossAction.kind !== 'answerChoice' || lossAction.answer.kind !== 'selectPlayers') throw new Error('wrong shape');
    if (gainAction.kind !== 'answerChoice' || gainAction.answer.kind !== 'selectPlayers') throw new Error('wrong shape');
    expect(lossAction.answer.players).toEqual(['B']);
    expect(gainAction.answer.players).toEqual(['A']);
  });

  it('takes the full allowance of modes', () => {
    const state = newGame().state;
    const choice = park({
      kind: 'chooseModes',
      chooser: 'A',
      prompt: 'choose two',
      modes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
      max: 2,
      valence: 'gain',
    });
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'chooseModes') throw new Error('wrong shape');
    expect(action.answer.modeIds).toHaveLength(2);
    expect(validateChoiceAnswer(choice, action.answer).ok).toBe(true);
  });

  it('accepts a "you may" that helps it and declines one that costs it', () => {
    const state = newGame().state;
    const yes = answerChoiceHeuristically(state, park({ kind: 'confirm', chooser: 'A', prompt: '?', valence: 'gain' }), WEIGHTS);
    const no = answerChoiceHeuristically(state, park({ kind: 'confirm', chooser: 'A', prompt: '?', valence: 'loss' }), WEIGHTS);
    if (yes.kind !== 'answerChoice' || yes.answer.kind !== 'confirm') throw new Error('wrong shape');
    if (no.kind !== 'answerChoice' || no.answer.kind !== 'confirm') throw new Error('wrong shape');
    expect(yes.answer.yes).toBe(true);
    expect(no.answer.yes).toBe(false);
  });

  it('pays a tax that keeps its own spell, and never one it cannot afford', () => {
    const state = newGame().state;
    const payable = park({
      kind: 'payMana',
      chooser: 'A',
      prompt: 'Pay {3}',
      cost: { generic: 3 },
      affordable: true,
      valence: 'gain',
    });
    const broke = park({
      kind: 'payMana',
      chooser: 'A',
      prompt: 'Pay {3}',
      cost: { generic: 3 },
      affordable: false,
      valence: 'gain',
    });

    const paid = answerChoiceHeuristically(state, payable, WEIGHTS);
    const declined = answerChoiceHeuristically(state, broke, WEIGHTS);
    if (paid.kind !== 'answerChoice' || paid.answer.kind !== 'payMana') throw new Error('wrong shape');
    if (declined.kind !== 'answerChoice' || declined.answer.kind !== 'payMana') throw new Error('wrong shape');
    expect(paid.answer.pay).toBe(true);
    expect(declined.answer.pay).toBe(false);
    // Both must be answers the ENGINE would accept — "pay" is illegal when the
    // board cannot produce the cost, so this is the property, not the preference.
    expect(validateChoiceAnswer(payable, paid.answer).ok).toBe(true);
    expect(validateChoiceAnswer(broke, declined.answer).ok).toBe(true);
  });

  it('declines a payment somebody else is making it consider (a "loss" valence)', () => {
    const state = newGame().state;
    const choice = park({
      kind: 'payMana',
      chooser: 'A',
      prompt: 'Pay {1}',
      cost: { generic: 1 },
      affordable: true,
      valence: 'loss',
    });
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'payMana') throw new Error('wrong shape');
    expect(action.answer.pay).toBe(false);
  });

  it('always addresses the answer to the choice\'s own chooser, never itself', () => {
    const state = newGame().state;
    state.players.B.hand = [];
    giveHand(state, 'B', [BEAR, DRAGON]);
    const choice = park({
      kind: 'selectCards',
      chooser: 'B',
      prompt: 'discard',
      candidates: collectCardOptions(state, 'hand', { controller: 'B' }),
      valence: 'loss',
    });
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    expect(action.kind === 'answerChoice' && action.player).toBe('B');
    expect(action.kind === 'answerChoice' && action.choiceId).toBe(choice.id);
  });

  it('produces a LEGAL answer for every shape it can be handed', () => {
    const state = newGame().state;
    state.players.A.hand = [];
    giveHand(state, 'A', [BEAR, ISLAND, DRAGON, BEAR]);
    const candidates = collectCardOptions(state, 'hand', { controller: 'A' });
    for (const valence of ['gain', 'loss', 'neutral'] as const) {
      for (let min = 0; min <= 4; min++) {
        for (let max = min; max <= 4; max++) {
          for (const ordered of [false, true]) {
            const choice = park({ kind: 'selectCards', chooser: 'A', prompt: 'p', candidates, min, max, ordered, valence });
            const action = answerChoiceHeuristically(state, choice, WEIGHTS);
            if (action.kind !== 'answerChoice') throw new Error('wrong shape');
            expect(validateChoiceAnswer(choice, action.answer).ok).toBe(true);
          }
        }
      }
    }
  });
});

// --- modal spells: the pilot EVALUATES each mode ------------------------------------

/**
 * Cryptic Command's real four modes, authored exactly as the pool authors them
 * (registered primitive ids + params). The pilot must reach the right pick from
 * this data alone — it has no idea what "Cryptic Command" is.
 */
const CRYPTIC_MODES = [
  { id: 'counter', label: 'Counter target spell', targets: 'spell', effects: [{ primitive: 'counterSpell' }] },
  {
    id: 'bounce',
    label: "Return target permanent to its owner's hand",
    targets: 'permanent',
    effects: [{ primitive: 'returnToHand' }],
  },
  {
    id: 'tapAll',
    label: 'Tap all creatures your opponents control',
    effects: [{ primitive: 'tapPermanents', params: { who: 'opponent', types: ['creature'] } }],
  },
  { id: 'draw', label: 'Draw a card', effects: [{ primitive: 'drawCards', params: { count: 1 } }] },
] as const satisfies readonly SpellMode[];

const CRYPTIC_DEF: CardDefinition = {
  ...freeInstant('Cryptic Command', []),
  modal: { min: 2, max: 2, modes: CRYPTIC_MODES },
};

/**
 * Park a modal spell's MODE question the way the engine really does: the card is
 * on the STACK being cast (`awaitingCastChoice: 'modes'`), nothing is resolving,
 * and no target has been chosen — because each announced mode is aimed
 * afterwards, as its own question.
 *
 * `offer` is the menu the engine computed from the board; the pilot's job is to
 * pick from it, and its picks are graded here against what the board is worth.
 */
function parkModal(
  state: GameState,
  opts: {
    readonly offer: readonly string[];
    /** A real modal spell says "choose exactly N", so `count` sets both bounds. */
    readonly count?: number;
    readonly min?: number;
    readonly max?: number;
    readonly valence?: 'gain' | 'loss' | 'neutral';
  },
): PendingChoice {
  const [card] = giveHand(state, 'A', [CRYPTIC_DEF]);
  state.players.A.hand = state.players.A.hand.filter((c) => c.instanceId !== card!.instanceId);
  card!.zone = 'stack';
  state.stack.push({
    kind: 'spell',
    instanceId: card!.instanceId,
    card: card!,
    controller: 'A',
    resolvesTo: 'graveyard',
    targets: [],
    awaitingCastChoice: 'modes',
  });
  const count = opts.count ?? 2;
  // The choice names the SPELL as its source — that is how the pilot finds the
  // card whose modes it is being asked about, so a stand-in id would silently
  // degrade every mode decision below to printed order.
  const choice = normalizeChoiceRequest(
    {
      kind: 'chooseModes',
      chooser: 'A',
      prompt: 'Choose two —',
      modes: CRYPTIC_MODES.filter((m) => opts.offer.includes(m.id)).map((m) => ({ id: m.id, label: m.label })),
      min: opts.min ?? count,
      max: opts.max ?? count,
      valence: opts.valence ?? 'gain',
    },
    { id: 7, sourceInstanceId: card!.instanceId, sourceName: 'Cryptic Command' },
  );
  if (!choice) throw new Error('expected a normalised choice');
  state.pendingChoice = choice;
  return choice;
}

/**
 * Park the question that AIMS one announced mode: the spell is on the stack with
 * its picks recorded and `awaitingCastChoice: 'modeTarget'`, exactly as the
 * engine leaves it between announcing modes and aiming them.
 */
function parkModeTarget(
  state: GameState,
  modeId: string,
  candidates: readonly InstanceId[],
): PendingChoice {
  const [card] = giveHand(state, 'A', [CRYPTIC_DEF]);
  state.players.A.hand = state.players.A.hand.filter((c) => c.instanceId !== card!.instanceId);
  card!.zone = 'stack';
  state.stack.push({
    kind: 'spell',
    instanceId: card!.instanceId,
    card: card!,
    controller: 'A',
    resolvesTo: 'graveyard',
    targets: [],
    modePicks: [{ modeId }],
    awaitingCastChoice: 'modeTarget',
  });
  const mode = CRYPTIC_MODES.find((m) => m.id === modeId)!;
  const choice = normalizeChoiceRequest(
    {
      kind: 'selectTargets',
      chooser: 'A',
      prompt: `Choose a target for ${mode.label}`,
      candidates: candidates.map((ref) => ({ ref, name: String(ref), controller: 'A' as const })),
      restriction: (mode as { targets?: TargetRestriction }).targets ?? 'any',
      min: 1,
      max: 1,
    },
    { id: 8, sourceInstanceId: card!.instanceId, sourceName: 'Cryptic Command' },
  );
  if (!choice) throw new Error('expected a normalised choice');
  return choice;
}

/** The targets the pilot picks for a parked targeting choice. */
function chosenTargets(state: GameState, choice: PendingChoice): readonly (InstanceId | 'A' | 'B')[] {
  const action = answerChoiceHeuristically(state, choice, WEIGHTS);
  if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectTargets') throw new Error('wrong shape');
  expect(validateChoiceAnswer(choice, action.answer).ok).toBe(true);
  return action.answer.targets;
}

/** The mode ids the pilot picks for a parked modal choice. */
function chosenModes(state: GameState, choice: PendingChoice): readonly string[] {
  const action = answerChoiceHeuristically(state, choice, WEIGHTS);
  if (action.kind !== 'answerChoice' || action.answer.kind !== 'chooseModes') throw new Error('wrong shape');
  expect(validateChoiceAnswer(choice, action.answer).ok).toBe(true);
  return action.answer.modeIds;
}

describe('what a SOFT counter is worth ("unless its controller pays {3}")', () => {
  /** Price one effect ref against a board where B is casting a Dragon. */
  function priceAgainstDragon(ref: EffectRef, bLands: number): number {
    const state = newGame().state;
    const dragon = putOnStack(state, 'B', DRAGON);
    putOnBattlefield(state, 'B', Array.from({ length: bLands }, () => ISLAND));
    const context = resolutionValueContext(state, 'A', WEIGHTS, cardValueContext(state));
    return valueOfEffects([ref], { ...context, targets: [dragon.instanceId] });
  }

  const SOFT: EffectRef = { primitive: 'counterUnlessPaid', params: { unlessPaid: { generic: 3 } } };
  const HARD: EffectRef = { primitive: 'counterSpell' };

  it('is worth a full counter against a player who cannot pay the tax', () => {
    expect(priceAgainstDragon(SOFT, 2)).toBe(priceAgainstDragon(HARD, 2));
  });

  it('is worth LESS than a hard counter against a player who can', () => {
    const soft = priceAgainstDragon(SOFT, 5);
    const hard = priceAgainstDragon(HARD, 5);
    expect(soft).toBeLessThan(hard);
    // Still worth something — paying strips them of three mana.
    expect(soft).toBeGreaterThan(0);
    expect(soft).toBeCloseTo(hard * WEIGHTS.softCounterPayableFactor);
  });

  it('is a mistake to point at your OWN spell, exactly like a hard counter', () => {
    const state = newGame().state;
    const own = putOnStack(state, 'A', DRAGON);
    const context = resolutionValueContext(state, 'A', WEIGHTS, cardValueContext(state));
    expect(valueOfEffects([SOFT], { ...context, targets: [own.instanceId] })).toBeLessThan(0);
  });
});

describe('aiming a triggered ability (the choice with no resolution behind it)', () => {
  /**
   * Park a trigger-targeting question exactly as the engine does: the ability is
   * ON THE STACK carrying `awaitingTargets`, and the choice offers the candidates.
   * The pilot has to recover what the ability DOES from the stack — that is the
   * whole mechanism, since a target choice carries no valence that could tell it
   * whether being pointed at is good or bad.
   */
  function parkAim(
    state: GameState,
    effects: readonly EffectRef[],
    candidates: readonly { ref: InstanceId | PlayerId; name: string; controller: PlayerId }[],
  ): PendingChoice {
    state.stack.push({
      kind: 'trigger',
      instanceId: 9001,
      sourceInstanceId: 1,
      controller: 'A',
      effects,
      targets: [],
      label: 'Enters: aim me',
      awaitingTargets: 'creature',
    });
    const choice = park({
      kind: 'selectTargets',
      chooser: 'A',
      prompt: 'Choose a creature',
      candidates: [...candidates],
      restriction: 'creature',
      min: 1,
      max: 1,
    });
    state.pendingChoice = choice;
    return choice;
  }

  function aimedAt(state: GameState, choice: PendingChoice): InstanceId | PlayerId | undefined {
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectTargets') throw new Error('wrong shape');
    expect(validateChoiceAnswer(choice, action.answer).ok).toBe(true);
    return action.answer.targets[0];
  }

  it('points a DAMAGE trigger at the opponent’s creature, not its own', () => {
    const state = newGame().state;
    const [mine] = putOnBattlefield(state, 'A', [BEAR]);
    const [theirs] = putOnBattlefield(state, 'B', [BEAR]);
    const choice = parkAim(state, [{ primitive: 'dealDamage', params: { amount: 3 } }], [
      { ref: mine!.instanceId, name: 'Bear', controller: 'A' },
      { ref: theirs!.instanceId, name: 'Bear', controller: 'B' },
    ]);
    expect(aimedAt(state, choice)).toBe(theirs!.instanceId);
  });

  it('points a PUMP trigger at its own creature — the same question, the other way', () => {
    // This is why aiming cannot be a valence rule: "which creature?" wants the
    // opponent's for damage and ours for a buff, and only the ability's own
    // effects distinguish them.
    const state = newGame().state;
    const [mine] = putOnBattlefield(state, 'A', [BEAR]);
    const [theirs] = putOnBattlefield(state, 'B', [BEAR]);
    const choice = parkAim(
      state,
      [{ primitive: 'pumpUntilEndOfTurn', params: { power: 2, toughness: 2 } }],
      [
        { ref: theirs!.instanceId, name: 'Bear', controller: 'B' },
        { ref: mine!.instanceId, name: 'Bear', controller: 'A' },
      ],
    );
    expect(aimedAt(state, choice)).toBe(mine!.instanceId);
  });

  it('kills the BIGGEST thing it can when several are legal', () => {
    const state = newGame().state;
    const [small] = putOnBattlefield(state, 'B', [BEAR]);
    const [big] = putOnBattlefield(state, 'B', [DRAGON]);
    const choice = parkAim(state, [{ primitive: 'destroyTarget', params: {} }], [
      { ref: small!.instanceId, name: 'Bear', controller: 'B' },
      { ref: big!.instanceId, name: 'Dragon', controller: 'B' },
    ]);
    expect(aimedAt(state, choice)).toBe(big!.instanceId);
  });

  it('still answers legally when the ability is one it cannot price', () => {
    const state = newGame().state;
    const [one] = putOnBattlefield(state, 'B', [BEAR]);
    const [two] = putOnBattlefield(state, 'B', [BEAR]);
    const choice = parkAim(state, [{ primitive: 'someMechanicFromTheFuture', params: {} }], [
      { ref: one!.instanceId, name: 'Bear', controller: 'B' },
      { ref: two!.instanceId, name: 'Bear', controller: 'B' },
    ]);
    // Deterministic and legal: the first offered candidate, not a crash.
    expect(aimedAt(state, choice)).toBe(one!.instanceId);
  });
});

describe('choosing modal-spell modes (scripted positions)', () => {
  it('DRAWS instead of bouncing a permanent that is not worth bouncing', () => {
    // A lone Forest is the only thing on the board, so bouncing is nearly free
    // value for the opponent and tapping does nothing at all. Drawing is the one
    // mode that is worth a card, and a "choose one" must find it.
    const state = newGame().state;
    putOnBattlefield(state, 'B', [landDef('Forest', 'G')]);
    const choice = parkModal(state, { offer: ['bounce', 'tapAll', 'draw'], count: 1 });
    expect(chosenModes(state, choice)).toEqual(['draw']);
  });

  it('BOUNCES instead of drawing when the target is a real threat', () => {
    const state = newGame().state;
    putOnBattlefield(state, 'B', [creatureDef('Serra Angel', 4, 4, { cost: { generic: 3, W: 2 } })]);
    const choice = parkModal(state, { offer: ['bounce', 'tapAll', 'draw'] });
    expect(chosenModes(state, choice)).toEqual(['bounce', 'draw']);
  });

  it('COUNTERS the opponent’s spell and still draws (never bounces nothing)', () => {
    const state = newGame().state;
    putOnStack(state, 'B', DRAGON);
    const choice = parkModal(state, { offer: ['counter', 'tapAll', 'draw'] });
    expect(chosenModes(state, choice)).toEqual(['counter', 'draw']);
  });

  it('never AIMS a mode at its own board when the opponent has a target', () => {
    // Aiming is its own question now, asked once per announced mode — so "don't
    // bounce your own Angel" is a property of the TARGET answer, not of which
    // modes were chosen.
    const state = newGame().state;
    const [mine] = putOnBattlefield(state, 'A', [creatureDef('My Angel', 4, 4, { cost: { generic: 3, W: 2 } })]);
    const [theirs] = putOnBattlefield(state, 'B', [creatureDef('Their Angel', 4, 4, { cost: { generic: 3, W: 2 } })]);
    const choice = parkModeTarget(state, 'bounce', [mine!.instanceId, theirs!.instanceId]);
    expect(chosenTargets(state, choice)).toEqual([theirs!.instanceId]);
  });

  it('never AIMS the counter mode at its own spell', () => {
    const state = newGame().state;
    const own = putOnStack(state, 'A', DRAGON);
    const theirs = putOnStack(state, 'B', DRAGON);
    const choice = parkModeTarget(state, 'counter', [own.instanceId, theirs.instanceId]);
    expect(chosenTargets(state, choice)).toEqual([theirs.instanceId]);
  });

  it('never CHOOSES the counter mode when the only spell it could hit is its own', () => {
    // A spell is an object on the stack while its own modes are being chosen, so
    // "counter target spell" is legally announceable here — and pointless. The
    // pilot prices the mode by its best aim, finds only self-harm, and passes.
    const state = newGame().state;
    putOnStack(state, 'A', DRAGON);
    putOnBattlefield(state, 'B', [BEAR]);
    const choice = parkModal(state, { offer: ['counter', 'tapAll', 'draw'] });
    expect(chosenModes(state, choice)).toEqual(['tapAll', 'draw']);
  });

  it('refuses to draw off a library that cannot pay (decking itself)', () => {
    const state = newGame().state;
    state.players.A.library = [];
    putOnBattlefield(state, 'B', [BEAR]);
    const choice = parkModal(state, { offer: ['tapAll', 'draw'], count: 1 });
    expect(chosenModes(state, choice)).toEqual(['tapAll']);
  });

  it('takes FEWER modes than allowed when the extra ones would do nothing at all', () => {
    // Nothing on either board and nothing targeted: only "draw" does anything, so a
    // "choose up to two" takes exactly the one mode that is real.
    const state = newGame().state;
    const choice = parkModal(state, { offer: ['bounce', 'tapAll', 'draw'], min: 0, max: 2 });
    expect(chosenModes(state, choice)).toEqual(['draw']);
  });

  it('still names the required number of modes when every mode is bad', () => {
    const state = newGame().state;
    state.players.A.library = [];
    putOnBattlefield(state, 'A', [BEAR]);
    const choice = parkModal(state, { offer: ['bounce', 'draw'], count: 2 });
    expect(chosenModes(state, choice)).toHaveLength(2);
  });

  it('on a LOSS valence it picks the WORST modes, and as few as allowed', () => {
    const state = newGame().state;
    putOnBattlefield(state, 'B', [creatureDef('Serra Angel', 4, 4, { cost: { generic: 3, W: 2 } })]);
    const choice = parkModal(state, {
      offer: ['bounce', 'tapAll', 'draw'],
      count: 1,
      valence: 'loss',
    });
    // Tapping an already-untapped-but-worthless board is the emptiest of the three
    // (the Angel is the only creature, and bouncing/drawing both do real work).
    expect(chosenModes(state, choice)).toEqual(['tapAll']);
  });

  it('is deterministic: the same position always yields the same modes', () => {
    const build = () => {
      const state = newGame().state;
      putOnBattlefield(state, 'B', [creatureDef('Serra Angel', 4, 4, { cost: { generic: 3, W: 2 } })]);
      return { state, choice: parkModal(state, { offer: ['bounce', 'tapAll', 'draw'] }) };
    };
    const first = build();
    const second = build();
    expect(chosenModes(second.state, second.choice)).toEqual(chosenModes(first.state, first.choice));
  });

  it('produces a LEGAL answer for every count and valence, with or without card data', () => {
    for (const valence of ['gain', 'loss', 'neutral'] as const) {
      for (let count = 0; count <= 3; count++) {
        const state = newGame().state;
        putOnBattlefield(state, 'B', [BEAR]);
        const choice = parkModal(state, { offer: ['bounce', 'tapAll', 'draw'], count, valence });
        expect(chosenModes(state, choice).length).toBeGreaterThanOrEqual(choice.min);
        // A choice whose card data cannot be read must still answer legally.
        state.stack = [];
        expect(chosenModes(state, choice).length).toBeGreaterThanOrEqual(choice.min);
      }
    }
  });
});

// --- the card ranking is board-aware ------------------------------------------------

describe('what "my worst card" means depends on the board', () => {
  function discardFrom(defs: readonly CardDefinition[], landsInPlay: number): string {
    const state = newGame().state;
    state.players.A.hand = [];
    if (landsInPlay > 0) putOnBattlefield(state, 'A', Array.from({ length: landsInPlay }, () => ISLAND));
    giveHand(state, 'A', defs);
    const choice = park({
      kind: 'selectCards',
      chooser: 'A',
      prompt: 'discard',
      candidates: collectCardOptions(state, 'hand', { controller: 'A' }),
      valence: 'loss',
    });
    const action = answerChoiceHeuristically(state, choice, WEIGHTS);
    if (action.kind !== 'answerChoice' || action.answer.kind !== 'selectCards') throw new Error('wrong shape');
    const picked = action.answer.instanceIds[0];
    return state.players.A.hand.find((c) => c.instanceId === picked)!.def.name;
  }

  const CHEAP_SPELL = freeInstant('Cantrip', [{ primitive: 'drawCards', params: { count: 1 } }]);

  it('keeps the land and pitches a cheap spell while still short of mana', () => {
    expect(discardFrom([ISLAND, CHEAP_SPELL, DRAGON], 0)).toBe('Cantrip');
  });

  it('pitches the land once the mana is built', () => {
    expect(discardFrom([ISLAND, CHEAP_SPELL, DRAGON], WEIGHTS.choiceLandsWanted)).toBe('Island');
  });
});

describe('safeFallbackAction', () => {
  it('answers the parked choice rather than passing (which the engine would reject)', () => {
    const state = newGame().state;
    state.pendingChoice = park({ kind: 'confirm', chooser: 'B', prompt: '?' });
    const action = safeFallbackAction(state);
    expect(action.kind).toBe('answerChoice');
    expect(action.kind === 'answerChoice' && action.player).toBe('B');
  });

  it('passes priority when no choice is parked', () => {
    const state = newGame().state;
    expect(safeFallbackAction(state).kind).toBe('passPriority');
  });
});

// --- pilots in real games ----------------------------------------------------------------

function newGame(seed = 99, reg?: EffectRegistry) {
  return createGame({
    seed,
    registry: reg,
    decks: {
      A: { cards: Array.from({ length: 30 }, () => ISLAND) },
      B: { cards: Array.from({ length: 30 }, () => ISLAND) },
    },
  });
}

/** Drive a game with the given pilot, answering everything, until it ends or caps. */
function playOut(
  pilotId: 'heuristic' | 'random',
  seed: number,
  setUp: (state: GameState) => void,
  maxSteps = 3000,
): { final: string; actions: GameAction[]; rejections: number } {
  const reg = choiceRegistry();
  const pilot = pilotId === 'heuristic' ? createHeuristicPilot() : createRandomPilot();
  const created = newGame(seed, reg);
  let state = created.state;
  setUp(state);
  const rng = createRng(seed);
  const actions: GameAction[] = [];
  let rejections = 0;
  for (let i = 0; i < maxSteps && !state.gameOver; i++) {
    const legal = generateLegalActions(state);
    // The property that makes a headless game safe: there is always a move.
    expect(legal.length).toBeGreaterThan(0);
    const action = pilot.chooseAction({ view: state, legalActions: legal, rng, registry: reg, rulesConfig: DEFAULT_RULES });
    actions.push(action);
    const result = applyAction(state, action, DEFAULT_RULES, reg);
    if (result.events.some((e) => e.type === 'actionRejected')) rejections++;
    state = result.state;
  }
  return { final: JSON.stringify(serializeState(state)), actions, rejections };
}

/** Stock both hands with the choice-asking spells. */
function stockChoiceSpells(state: GameState): void {
  giveHand(state, 'A', [DISCARD_SPELL, MAY_SPELL, MODAL_SPELL, BEAR]);
  giveHand(state, 'B', [DISCARD_SPELL, MAY_SPELL, MODAL_SPELL, DRAGON]);
}

describe('a game full of choice-asking spells', () => {
  it('never rejects an action the heuristic pilot proposes', () => {
    const run = playOut('heuristic', 4242, stockChoiceSpells);
    expect(run.rejections).toBe(0);
    expect(run.actions.some((a) => a.kind === 'answerChoice')).toBe(true);
  });

  it('never rejects an action the random pilot proposes either', () => {
    const run = playOut('random', 4242, stockChoiceSpells);
    expect(run.rejections).toBe(0);
    expect(run.actions.some((a) => a.kind === 'answerChoice')).toBe(true);
  });

  it('is deterministic for the heuristic: same seed ⇒ identical choices and final state', () => {
    const first = playOut('heuristic', 31337, stockChoiceSpells);
    const second = playOut('heuristic', 31337, stockChoiceSpells);
    expect(JSON.stringify(second.actions)).toBe(JSON.stringify(first.actions));
    expect(second.final).toBe(first.final);
  });

  it('is deterministic for the random baseline too', () => {
    const first = playOut('random', 31337, stockChoiceSpells);
    const second = playOut('random', 31337, stockChoiceSpells);
    expect(JSON.stringify(second.actions)).toBe(JSON.stringify(first.actions));
    expect(second.final).toBe(first.final);
  });

  it('terminates across several seeds with both pilots', () => {
    for (const seed of [1, 2, 3]) {
      for (const pilot of ['heuristic', 'random'] as const) {
        const run = playOut(pilot, seed, stockChoiceSpells);
        expect(run.rejections).toBe(0);
      }
    }
  });
});

/** Cast the (free) spell and pass twice, leaving the game parked on its question. */
function parkedOnDiscard(reg: EffectRegistry): GameState {
  const created = newGame(5, reg);
  let state = created.state;
  state.players.A.hand = [];
  state.players.B.hand = [];
  const [spell] = giveHand(state, 'A', [DISCARD_SPELL]);
  giveHand(state, 'B', [DRAGON, BEAR]);
  let guard = 0;
  while (state.step !== 'precombatMain' && guard++ < 50) {
    state = applyAction(state, { kind: 'passPriority', player: state.priorityPlayer }, DEFAULT_RULES, reg).state;
  }
  const id = (spell as { instanceId: InstanceId }).instanceId;
  state = applyAction(state, { kind: 'castSpell', player: 'A', instanceId: id }, DEFAULT_RULES, reg).state;
  state = applyAction(state, { kind: 'passPriority', player: 'A' }, DEFAULT_RULES, reg).state;
  return applyAction(state, { kind: 'passPriority', player: 'B' }, DEFAULT_RULES, reg).state;
}

describe('the discard a pilot actually makes', () => {
  it('the victim throws away its cheapest card, not its best', () => {
    const reg = choiceRegistry();
    const state = parkedOnDiscard(reg);
    expect(state.pendingChoice?.chooser).toBe('B');

    const action = createHeuristicPilot().chooseAction({
      view: state,
      legalActions: generateLegalActions(state),
      rng: createRng(1),
      registry: reg,
      rulesConfig: DEFAULT_RULES,
    });
    const done = applyAction(state, action, DEFAULT_RULES, reg);
    expect(done.events.some((e) => e.type === 'actionRejected')).toBe(false);
    expect(done.state.players.B.graveyard.map((c) => c.def.name)).toEqual(['Bear']);
    expect(done.state.players.B.hand.map((c) => c.def.name)).toEqual(['Dragon']);
  });

  it('the look-ahead pilot answers too — it searches answers like any other action', () => {
    const reg = choiceRegistry();
    const state = parkedOnDiscard(reg);
    // A tiny search budget: this asserts MCTS handles the decision shape, not that
    // it out-plays the heuristic (that is `mcts.test.ts`'s job).
    const pilot = createMctsPilot({ ...FAST_MCTS_CONFIG, simulationsPerDecision: 8 });
    const decide = (): GameAction =>
      pilot.chooseAction({
        view: state,
        legalActions: generateLegalActions(state),
        rng: createRng(3),
        registry: reg,
        rulesConfig: DEFAULT_RULES,
      });

    const action = decide();
    expect(action.kind).toBe('answerChoice');
    expect(action.kind === 'answerChoice' && action.player).toBe('B');
    const done = applyAction(state, action, DEFAULT_RULES, reg);
    expect(done.events.some((e) => e.type === 'actionRejected')).toBe(false);
    // Same seed, same search, same answer.
    expect(JSON.stringify(decide())).toBe(JSON.stringify(action));
  });
});
