/**
 * THE PILOT AND A "DISCARD A CARD" COST (DESIGN §3.172) — `activation-cost.ts`.
 *
 * The engine offers one activation per card in hand. Priced by the body alone
 * every offer ties and the pilot pitches hand[0] — its Bear as readily as its
 * eighth land. Priced by the CARD (`cardValue`, the one ranking the cleanup
 * discard already uses) the offer that pitches the flooded land wins by
 * construction. Pinned number by number against the weights, then as a real
 * drive: a flooded pilot with "Discard a card: Draw two cards" on the table
 * names the land, not the creature.
 */
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  type CardDefinition,
  type CardInstance,
  type DeckList,
  type GameAction,
  type GameState,
  type InstanceId,
} from '@jonny-boi/core';
import { buildRegistry } from '@jonny-boi/cards';
import { activationCostValue } from './activation-cost.js';
import { boardIndex } from './board-stats.js';
import { createHeuristicPilot } from './heuristic.js';
import { DEFAULT_HEURISTIC_WEIGHTS as W } from './weights.js';
import { giveHand, landDef } from './test-support.js';

const FOREST = landDef('Forest', 'G');
const BEAR: CardDefinition = {
  id: 'bear',
  name: 'Grizzly Bears',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { generic: 1, G: 1 },
};
/** "Discard a card: Draw two cards" — a body plainly worth a flooded land. */
const LOOTER: CardDefinition = {
  id: 'discard-looter',
  name: 'Test Looter',
  types: ['creature'],
  power: 1,
  toughness: 1,
  activated: [
    {
      cost: { discard: { count: 1 } },
      effects: [{ primitive: 'drawCards', params: { count: 2 } }],
      label: 'Discard a card: Draw two cards',
    },
  ],
};
const RANDOM_LOOTER: CardDefinition = {
  ...LOOTER,
  id: 'random-looter',
  activated: [{ ...LOOTER.activated![0]!, cost: { discard: { count: 1, random: true } } }],
};

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'G')) };
}

/** A's precombat main: `board` in play, `hand` in hand, nothing else. */
function position(board: readonly CardDefinition[], hand: readonly CardDefinition[]): GameState {
  const { state } = createGame({ seed: 11, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 1;
  const placed = giveHand(state, 'A', board);
  state.players.A.hand = [];
  for (const card of placed) {
    card.zone = 'battlefield';
    card.summoningSick = false;
    state.battlefield.push(card as CardInstance);
  }
  giveHand(state, 'A', hand);
  return state;
}

const looterOn = (state: GameState) => state.battlefield.find((c) => c.def.id.endsWith('looter')) as CardInstance;
const inHand = (state: GameState, id: string) => state.players.A.hand.find((c) => c.def.id === id) as CardInstance;
const ctxFor = (state: GameState) => ({ state, player: 'A' as const, weights: W, index: boardIndex(state) });

describe('activationCostValue — a discard, priced by the card it gives up', () => {
  it('a NAMED payer costs that card: the flooded land 2, the Bear 18', () => {
    const s = position([LOOTER, FOREST, FOREST, FOREST, FOREST], [BEAR, FOREST]);
    const cost = LOOTER.activated![0]!.cost;
    expect(activationCostValue(cost, looterOn(s), ctxFor(s), [inHand(s, 'Forest').instanceId])).toBe(-W.choiceLandValue);
    expect(activationCostValue(cost, looterOn(s), ctxFor(s), [inHand(s, 'bear').instanceId])).toBe(
      -(W.choiceCreatureBaseValue + 4 * W.choiceCreaturePerStatValue),
    );
  });

  it('UNNAMED — the funded path deciding whether to tap — it is the cheapest qualifying card', () => {
    const s = position([LOOTER, FOREST, FOREST, FOREST, FOREST], [BEAR, FOREST]);
    expect(activationCostValue(LOOTER.activated![0]!.cost, looterOn(s), ctxFor(s))).toBe(-W.choiceLandValue);
    // While the pilot is still short of lands the land is the dear one and the Bear is cheapest.
    const short = position([LOOTER], [BEAR, FOREST]);
    expect(activationCostValue(LOOTER.activated![0]!.cost, looterOn(short), ctxFor(short))).toBe(
      -(W.choiceCreatureBaseValue + 4 * W.choiceCreaturePerStatValue),
    );
  });

  it('"at random" is the mean of the hand; an empty hand prices at nothing (the engine never offers it)', () => {
    const s = position([RANDOM_LOOTER, FOREST, FOREST, FOREST, FOREST], [BEAR, FOREST]);
    const bear = W.choiceCreatureBaseValue + 4 * W.choiceCreaturePerStatValue;
    expect(activationCostValue(RANDOM_LOOTER.activated![0]!.cost, looterOn(s), ctxFor(s))).toBeCloseTo(
      -(bear + W.choiceLandValue) / 2,
    );
    const empty = position([LOOTER], []);
    expect(activationCostValue(LOOTER.activated![0]!.cost, looterOn(empty), ctxFor(empty))).toBe(0);
  });
});

describe('the pilot, driven — it pitches the flooded land, never the Bear', () => {
  it('activates the looter naming the Forest in hand', () => {
    const reg = buildRegistry();
    const pilot = createHeuristicPilot();
    const state = position([LOOTER, FOREST, FOREST, FOREST, FOREST], [BEAR, FOREST]);
    const legal = generateLegalActions(state);
    const offered = legal.filter(
      (a): a is Extract<GameAction, { kind: 'activateAbility' }> =>
        a.kind === 'activateAbility' && a.instanceId === looterOn(state).instanceId,
    );
    expect(offered, 'one offer per card in hand').toHaveLength(2);
    const action = pilot.chooseAction({ view: state, legalActions: legal, rng: createRng(4) });
    expect(action.kind).toBe('activateAbility');
    const payer = (action as { costInstanceIds?: readonly InstanceId[] }).costInstanceIds;
    expect(payer).toEqual([inHand(state, 'Forest').instanceId]);
    const after = applyAction(state, action, undefined, reg).state;
    expect(after.players.A.hand.some((c) => c.def.id === 'bear'), 'the Bear stays in hand').toBe(true);
    expect(after.players.A.graveyard.some((c) => c.def.id === 'Forest'), 'the land is what left').toBe(true);
  });
});
