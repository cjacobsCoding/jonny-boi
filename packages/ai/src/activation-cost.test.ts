/**
 * THE DEBIT SIDE OF AN ACTIVATION (DESIGN §3.162) — `activation-cost.ts`.
 *
 * Spike Feeder's free half, "Remove a +1/+1 counter from this creature: You
 * gain 2 life", is offered by the engine whenever a counter is there, and
 * `bestOfferedActivation` priced only the body. Two priority windows later the
 * pilot's 2/2 was a dead 0/0 and it had four life it did not need. The
 * discriminator below is a REAL drive of the heuristic pilot on that board: it
 * must pass the turn with the Spike intact.
 *
 * The pricing itself is pinned number by number against the weights it reads,
 * so a change to a weight moves the expectation with it rather than around it.
 */
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  MINUS_ONE_COUNTER,
  PLUS_ONE_COUNTER,
  type CardDefinition,
  type CardInstance,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { buildRegistry } from '@jonny-boi/cards';
import { activationCostValue } from './activation-cost.js';
import { boardIndex } from './board-stats.js';
import { createHeuristicPilot } from './heuristic.js';
import { DEFAULT_HEURISTIC_WEIGHTS as W } from './weights.js';
import { giveHand, landDef } from './test-support.js';

/** Spike Feeder as engine data — the compiled shape, hand-written so this file needs no compiler. */
const SPIKE_FEEDER: CardDefinition = {
  id: 'spike-feeder',
  name: 'Spike Feeder',
  types: ['creature'],
  cost: { generic: 1, G: 2 },
  power: 0,
  toughness: 0,
  subtypes: ['spike'],
  activated: [
    {
      cost: { mana: { generic: 2 }, removeCounters: { kind: PLUS_ONE_COUNTER, count: 1 } },
      effects: [{ primitive: 'addCounters', params: { amount: 1, targets: 'creature' } }],
      label: '{2}, Remove a +1/+1 counter from ~: Put a +1/+1 counter on target creature',
    },
    {
      cost: { removeCounters: { kind: PLUS_ONE_COUNTER, count: 1 } },
      effects: [{ primitive: 'gainLife', params: { amount: 2 } }],
      label: 'Remove a +1/+1 counter from ~: You gain 2 life',
    },
  ],
};

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'G')) };
}

/** A's precombat main with `board` in play (counters as given) and nothing else. */
function position(board: readonly { def: CardDefinition; counters?: Record<string, number> }[]): GameState {
  const { state } = createGame({ seed: 11, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 1;
  const placed = giveHand(state, 'A', board.map((b) => b.def));
  state.players.A.hand = [];
  placed.forEach((card, i) => {
    card.zone = 'battlefield';
    card.summoningSick = false;
    card.counters = board[i]?.counters ?? {};
    state.battlefield.push(card as CardInstance);
  });
  return state;
}

function spikeOn(state: GameState): CardInstance {
  return state.battlefield.find((c) => c.def.id === 'spike-feeder') as CardInstance;
}

describe('activationCostValue — the numbers, against the weights they read', () => {
  const perCounter = 2 * W.modeCounterPerStatValue;
  const ctxFor = (state: GameState) => ({ state, player: 'A' as const, weights: W, index: boardIndex(state) });

  it('a +1/+1 counter off a body that survives it costs its two stat points', () => {
    const s = position([{ def: SPIKE_FEEDER, counters: { [PLUS_ONE_COUNTER]: 2 } }]);
    expect(activationCostValue(SPIKE_FEEDER.activated![1]!.cost, spikeOn(s), ctxFor(s))).toBe(-perCounter);
  });

  it('the LAST counter off a 0/0 costs the body too', () => {
    const s = position([{ def: SPIKE_FEEDER, counters: { [PLUS_ONE_COUNTER]: 1 } }]);
    expect(activationCostValue(SPIKE_FEEDER.activated![1]!.cost, spikeOn(s), ctxFor(s))).toBe(
      -perCounter - W.choiceCreatureBaseValue,
    );
  });

  it('a -1/-1 counter removed is a credit; an inert kind is priced at nothing', () => {
    const s = position([{ def: SPIKE_FEEDER, counters: { [PLUS_ONE_COUNTER]: 3, [MINUS_ONE_COUNTER]: 1, charge: 2 } }]);
    const spike = spikeOn(s);
    expect(activationCostValue({ removeCounters: { kind: MINUS_ONE_COUNTER, count: 1 } }, spike, ctxFor(s))).toBe(perCounter);
    expect(activationCostValue({ removeCounters: { kind: 'charge', count: 2 } }, spike, ctxFor(s))).toBe(0);
  });

  it('sacrificing the source, and paying life — at the healthy and the desperate rate', () => {
    const s = position([{ def: SPIKE_FEEDER, counters: { [PLUS_ONE_COUNTER]: 2 } }]);
    const spike = spikeOn(s);
    expect(activationCostValue({ sacrificeSelf: true }, spike, ctxFor(s))).toBe(-W.choiceCreatureBaseValue);
    expect(activationCostValue({ life: 3 }, spike, ctxFor(s))).toBe(-3 * W.modeLifePerPointValue);
    s.players.A.life = W.desperateLifeThreshold;
    expect(activationCostValue({ life: 3 }, spike, ctxFor(s))).toBe(
      -3 * W.modeLifePerPointValue * W.modeDesperateLifeMultiplier,
    );
    expect(activationCostValue({ mana: { generic: 2 } }, spike, ctxFor(s)), 'mana is the planner’s, not this').toBe(0);
  });
});

describe('the pilot, driven — it does not strip its own Spike for life it does not need', () => {
  it('passes with both counters still on the Feeder at a healthy life total', () => {
    const reg = buildRegistry();
    const pilot = createHeuristicPilot();
    let state = position([{ def: SPIKE_FEEDER, counters: { [PLUS_ONE_COUNTER]: 2 } }]);
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 4, C: 0 };
    const taken: GameAction[] = [];
    for (let i = 0; i < 12 && !state.gameOver && state.step === 'precombatMain' && state.turnNumber === 1; i++) {
      const legal = generateLegalActions(state);
      expect(
        legal.some((a) => a.kind === 'activateAbility' && a.instanceId === spikeOn(state).instanceId),
        'the lifegain IS on the menu — the engine offers it; only the pilot’s judgement says no',
      ).toBe(true);
      const action = pilot.chooseAction({ view: state, legalActions: legal, rng: createRng(4) });
      taken.push(action);
      const result = applyAction(state, action, undefined, reg);
      if (result.events.some((e) => e.type === 'actionRejected')) break;
      state = result.state;
      if (action.kind === 'passPriority' && action.player === 'A') break;
    }
    expect(
      taken.filter((a) => a.kind === 'activateAbility' && a.player === 'A'),
      `the pilot activated the Spike: ${taken.map((a) => a.kind).join(', ')}`,
    ).toHaveLength(0);
    expect(spikeOn(state)?.counters[PLUS_ONE_COUNTER], 'both counters still there').toBe(2);
  });
});
