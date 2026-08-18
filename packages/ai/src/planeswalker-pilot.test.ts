/**
 * The pilot vs planeswalkers — the "no inert features" half of the walker system.
 *
 * A walker no pilot ever activates, attacks, or burns proves nothing. These pin
 * the three behaviours that make walkers REAL in a sim:
 *   1. the controller activates a loyalty ability in its main phase;
 *   2. the attacker diverts enough power to KILL an enemy walker (and only
 *      diverts when the attack is not already lethal to the player);
 *   3. burn finishes off a killable walker rather than chipping the face.
 */

import { describe, expect, it } from 'vitest';
import {
  createGame,
  createRng,
  generateLegalActions,
  LOYALTY_COUNTER,
  type CardDefinition,
  type CardInstance,
  type DeckList,
  type GameAction,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { burnDef, creatureDef, giveHand, landDef, putOnBattlefield, addPool } from './test-support.js';

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

function freshGame(seed = 1): GameState {
  const { state } = createGame({ seed, decks: { A: stubDeck(), B: stubDeck() } });
  return state;
}

function intoMainPhase(state: GameState): void {
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 0;
}

function intoDeclareAttackers(state: GameState): void {
  state.step = 'declareAttackers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
}

/** A walker definition with a draw-a-card +1 (a primitive the pilot can price). */
function walkerDef(id: string, loyalty: number): CardDefinition {
  return {
    id,
    name: id,
    types: ['planeswalker'],
    loyalty,
    activated: [
      {
        cost: { loyalty: 1 },
        timing: 'sorcery',
        effects: [{ primitive: 'drawCards', params: { count: 1 } }],
        label: '+1: Draw a card.',
      },
    ],
  };
}

/** Put a walker onto the battlefield carrying its loyalty counters. */
function putWalker(state: GameState, player: PlayerId, def: CardDefinition, loyalty?: number): CardInstance {
  const [inst] = putOnBattlefield(state, player, [def]);
  inst!.counters = { [LOYALTY_COUNTER]: loyalty ?? def.loyalty ?? 0 };
  return inst!;
}

const pilot = createHeuristicPilot();
const rng = () => createRng(99);

function choose(state: GameState): GameAction {
  const legal = generateLegalActions(state);
  return pilot.chooseAction({ view: state, legalActions: legal, rng: rng() });
}

describe('heuristic pilot — activates its own walker', () => {
  it('activates the +1 in its main phase rather than passing', () => {
    const state = freshGame();
    intoMainPhase(state);
    const walker = putWalker(state, 'A', walkerDef('My Walker', 3));
    const action = choose(state);
    expect(action.kind).toBe('activateAbility');
    if (action.kind === 'activateAbility') {
      expect(action.instanceId).toBe(walker.instanceId);
      expect(action.abilityIndex).toBe(0);
    }
  });
});

describe('heuristic pilot — attacks enemy walkers', () => {
  it('diverts enough attackers to kill a walker it can finish', () => {
    const state = freshGame(2);
    intoDeclareAttackers(state);
    const walker = putWalker(state, 'B', walkerDef('Enemy Walker', 3));
    const [big, small] = putOnBattlefield(state, 'A', [
      creatureDef('Ogre', 4, 4),
      creatureDef('Goblin', 1, 1),
    ]);
    const action = choose(state);
    expect(action.kind).toBe('declareAttackers');
    if (action.kind === 'declareAttackers') {
      // Both profitable attackers swing; the big one covers the walker's 3
      // loyalty alone, the small one stays on the player.
      expect([...action.attackers].sort()).toEqual([big!.instanceId, small!.instanceId].sort());
      expect(action.attackTargets).toEqual({ [big!.instanceId]: walker.instanceId });
    }
  });

  it('goes all-in on the player when the attack is lethal, walker or no walker', () => {
    const state = freshGame(3);
    intoDeclareAttackers(state);
    putWalker(state, 'B', walkerDef('Enemy Walker', 3));
    state.players.B.life = 4;
    putOnBattlefield(state, 'A', [creatureDef('Ogre', 5, 5)]);
    const action = choose(state);
    expect(action.kind).toBe('declareAttackers');
    if (action.kind === 'declareAttackers') {
      expect(action.attackTargets).toBeUndefined();
    }
  });

  it('does not chip a walker the attack cannot kill', () => {
    const state = freshGame(4);
    intoDeclareAttackers(state);
    putWalker(state, 'B', walkerDef('Enemy Walker', 6));
    putOnBattlefield(state, 'A', [creatureDef('Goblin', 2, 2)]);
    const action = choose(state);
    expect(action.kind).toBe('declareAttackers');
    if (action.kind === 'declareAttackers') {
      expect(action.attackTargets).toBeUndefined();
    }
  });
});

describe('heuristic pilot — burns walkers it can finish', () => {
  it('bolts a 3-loyalty walker instead of chipping a healthy face', () => {
    const state = freshGame(5);
    intoMainPhase(state);
    state.players.B.life = 20;
    const walker = putWalker(state, 'B', walkerDef('Enemy Walker', 3));
    const [bolt] = giveHand(state, 'A', [burnDef('Bolt', 3, { R: 1 })]);
    addPool(state, 'A', 'R', 1);
    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') {
      expect(action.instanceId).toBe(bolt!.instanceId);
      expect(action.targets).toEqual([walker.instanceId]);
    }
  });

  it('still takes the lethal face line over a walker kill', () => {
    const state = freshGame(6);
    intoMainPhase(state);
    state.players.B.life = 3;
    putWalker(state, 'B', walkerDef('Enemy Walker', 3));
    const [bolt] = giveHand(state, 'A', [burnDef('Bolt', 3, { R: 1 })]);
    addPool(state, 'A', 'R', 1);
    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') {
      expect(action.instanceId).toBe(bolt!.instanceId);
      expect(action.targets).toEqual(['B']);
    }
  });
});
