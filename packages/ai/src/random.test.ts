import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { createRandomPilot, RANDOM_PILOT_ID } from './random.js';
import { creatureDef, landDef } from './test-support.js';

/** A simple two-color-ish deck of lands + small creatures, padded for a long game. */
function makeDeck(): DeckList {
  const cards = [];
  for (let i = 0; i < 12; i++) cards.push(landDef(`Mountain${i % 3}`, 'R'));
  for (let i = 0; i < 8; i++) cards.push(creatureDef(`Goblin${i}`, 2, 2, { cost: { R: 1 } }));
  return { cards };
}

function newGame(seed: number): GameState {
  const { state } = createGame({ seed, decks: { A: makeDeck(), B: makeDeck() } });
  return state;
}

/** Drive a game with the random pilot for both seats and collect the action stream. */
function runRandomGame(seed: number, maxActions: number): GameAction[] {
  const pilot = createRandomPilot();
  const rng = createRng(seed ^ 0x9e3779b9); // a distinct decision stream from the deck seed
  let state = newGame(seed);
  const actions: GameAction[] = [];
  for (let i = 0; i < maxActions && !state.gameOver; i++) {
    const legal = generateLegalActions(state);
    const action = pilot.chooseAction({ view: state, legalActions: legal, rng });
    actions.push(action);
    state = applyAction(state, action).state;
  }
  return actions;
}

describe('random pilot', () => {
  it('registers under the expected id', () => {
    expect(createRandomPilot().id).toBe(RANDOM_PILOT_ID);
    expect(RANDOM_PILOT_ID).toBe('random');
  });

  it('is deterministic: same seed → same action sequence', () => {
    const a = runRandomGame(1234, 200);
    const b = runRandomGame(1234, 200);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(10);
  });

  it('different seeds generally diverge', () => {
    const a = runRandomGame(1, 200);
    const b = runRandomGame(2, 200);
    // Not a hard guarantee in theory, but with these seeds the streams differ.
    expect(a).not.toEqual(b);
  });

  it('only ever returns a legal action across many states', () => {
    const pilot = createRandomPilot();
    const rng = createRng(777);
    let state = newGame(42);
    for (let i = 0; i < 400 && !state.gameOver; i++) {
      const legal = generateLegalActions(state);
      const action = pilot.chooseAction({ view: state, legalActions: legal, rng });
      // The chosen action must be one the generator offered (random never
      // constructs novel actions).
      expect(legal).toContainEqual(action);
      state = applyAction(state, action).state;
    }
  });

  it('passes priority gracefully when no actions are offered', () => {
    const pilot = createRandomPilot();
    const rng = createRng(5);
    const state = newGame(9);
    const action = pilot.chooseAction({ view: state, legalActions: [], rng });
    expect(action).toEqual({ kind: 'passPriority', player: state.priorityPlayer });
  });

  it('emits a trace when a sink is provided', () => {
    const pilot = createRandomPilot();
    const rng = createRng(3);
    const state = newGame(11);
    const legal = generateLegalActions(state);
    const traces: string[] = [];
    pilot.chooseAction({ view: state, legalActions: legal, rng, trace: (t) => traces.push(t.reason) });
    expect(traces.length).toBe(1);
    expect(traces[0]).toContain('random pick');
  });
});
