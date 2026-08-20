/**
 * The pilot actually CHOOSES A HALF — the wiring that keeps split, aftermath
 * and adventure cards from being inert.
 *
 * A pilot that only ever reads `card.def` sees a split card's CR 709.4 combined
 * object: no script, and a cost equal to both halves added together. It would
 * score that as a do-nothing spell it cannot afford, never cast either half,
 * and every A/B verdict that swapped a split card in would measure a deck
 * holding a blank. The adventure failure mode is worse and quieter: the pilot
 * casts Stomp, the Giant waits in exile, and nothing ever takes it — strictly
 * worse than not owning the card.
 *
 * So this drives the REAL heuristic pilot on three positions and asserts on the
 * action it submits, then hands that action to the engine to prove offer and
 * accept agree:
 *  1. a split card in hand whose RIGHT half is the lethal line;
 *  2. an aftermath half in the graveyard;
 *  3. an adventurer's creature half waiting in exile with permission.
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
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { createTestRegistry, giveHand, landDef } from './test-support.js';

/** The left half: 2 damage to a creature only, so it is never the lethal line. */
const LEFT_HALF: CardDefinition = {
  id: 'split-left',
  name: 'Snuff',
  types: ['sorcery'],
  cost: { R: 1 },
  effects: [{ primitive: 'dealDamage', params: { amount: 2, targets: 'creature' } }],
};

/** The right half: 4 damage anywhere — lethal on the board below. */
const RIGHT_HALF: CardDefinition = {
  id: 'split-right',
  name: 'Blast',
  types: ['sorcery'],
  cost: { generic: 1, R: 1 },
  effects: [{ primitive: 'dealDamage', params: { amount: 4, targets: 'any' } }],
  isBackFace: true,
};

/** "Snuff // Blast" as the compiler builds it: the combined object, uncastable. */
const SNUFF_BLAST: CardDefinition = {
  id: 'snuff-blast',
  name: 'Snuff // Blast',
  types: ['sorcery'],
  cost: { generic: 1, R: 2 },
  frontFace: LEFT_HALF,
  backFace: RIGHT_HALF,
  backFaceCastable: true,
};

/** The same card with the right half restricted to the graveyard (aftermath). */
const AFTERMATH_CARD: CardDefinition = {
  ...SNUFF_BLAST,
  id: 'aftermath-card',
  name: 'Snuff // Rise',
  backFaceCastZones: ['graveyard'],
};

/** An adventurer: a 5/5 body whose adventure half deals 1 damage. */
const ADVENTURE_HALF: CardDefinition = {
  id: 'adv-half',
  name: 'Stomp',
  types: ['instant'],
  timing: 'instant',
  cost: { R: 1 },
  effects: [{ primitive: 'dealDamage', params: { amount: 1, targets: 'any' } }],
  isBackFace: true,
  adventure: true,
};
const ADVENTURER: CardDefinition = {
  id: 'adventurer',
  name: 'Bonecrusher Giant',
  types: ['creature'],
  cost: { generic: 2, R: 1 },
  power: 5,
  toughness: 5,
  backFace: ADVENTURE_HALF,
  backFaceCastable: true,
};

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

/** A's precombat main, no land drop left, B on 4 life, N untapped Mountains. */
function position(mountains: number): GameState {
  const { state } = createGame({ seed: 7, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 1;
  state.players.B.life = 4;
  const lands = giveHand(state, 'A', Array.from({ length: mountains }, (_, i) => landDef(`M${i}`, 'R')));
  state.players.A.hand = [];
  for (const land of lands) {
    land.zone = 'battlefield';
    land.summoningSick = false;
    state.battlefield.push(land);
  }
  return state;
}

/** Run the pilot until it submits a cast, tapping toward it in between. */
function driveToCast(state: GameState): { cast: Extract<GameAction, { kind: 'castSpell' }>; state: GameState } {
  const reg = createTestRegistry();
  const pilot = createHeuristicPilot();
  let current = state;
  for (let ply = 0; ply < 12; ply++) {
    const legal = generateLegalActions(current);
    const action = pilot.chooseAction({ view: current, legalActions: legal, rng: createRng(99) });
    if (action.kind === 'castSpell') return { cast: action, state: current };
    expect(action.kind, 'the pilot should be tapping toward a cast').toBe('tapForMana');
    current = applyAction(current, action, undefined, reg).state;
  }
  throw new Error('the pilot never attempted a cast');
}

/** Assert the engine accepts the pilot's own action end-to-end. */
function engineAccepts(state: GameState, action: GameAction): void {
  const result = applyAction(state, action, undefined, createTestRegistry());
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  expect(rejected, `engine rejected the pilot's action: ${JSON.stringify(rejected)}`).toBeUndefined();
}

describe('heuristic pilot vs a split card', () => {
  it('casts the RIGHT half when that is the lethal line, naming the face', () => {
    const state = position(3);
    const [card] = giveHand(state, 'A', [SNUFF_BLAST]);
    const { cast, state: ready } = driveToCast(state);
    expect(cast.instanceId).toBe(card!.instanceId);
    expect(cast.face, 'the pilot must name the half it means').toBe('back');
    expect(cast.targets).toEqual(['B']);
    engineAccepts(ready, cast);
  });

  it('does not try to pay the COMBINED cost — the half it chose is what it funds', () => {
    // Three Mountains is enough for either half ({R} or {1}{R}) but NOT for the
    // combined {1}{R}{R}… which it also is. So the sharper claim: with only TWO
    // Mountains, more than the left half but less than the combined cost, the
    // pilot still finds and funds a half rather than giving up.
    const state = position(2);
    const [card] = giveHand(state, 'A', [SNUFF_BLAST]);
    const { cast, state: ready } = driveToCast(state);
    expect(cast.instanceId).toBe(card!.instanceId);
    engineAccepts(ready, cast);
  });
});

describe('heuristic pilot vs aftermath', () => {
  it('casts the right half out of its own graveyard, from the graveyard', () => {
    const state = position(3);
    const [card] = giveHand(state, 'A', [AFTERMATH_CARD]);
    state.players.A.hand = [];
    const inst = card as CardInstance;
    inst.zone = 'graveyard';
    state.players.A.graveyard.push(inst);
    const { cast, state: ready } = driveToCast(state);
    expect(cast.instanceId).toBe(inst.instanceId);
    expect(cast.fromZone).toBe('graveyard');
    expect(cast.face).toBe('back');
    engineAccepts(ready, cast);
  });
});

describe('heuristic pilot vs an adventure', () => {
  it('takes the creature half out of exile once the adventure has resolved', () => {
    const reg = createTestRegistry();
    let state = position(6);
    const [card] = giveHand(state, 'A', [ADVENTURER]);
    // Cast and resolve the adventure the way a game would, so the exile and the
    // permission come from the engine rather than from a hand-built state.
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };
    state = applyAction(
      state,
      { kind: 'castSpell', player: 'A', instanceId: card!.instanceId, face: 'back', targets: ['B'] },
      undefined,
      reg,
    ).state;
    state = applyAction(state, { kind: 'passPriority', player: 'A' }, undefined, reg).state;
    state = applyAction(state, { kind: 'passPriority', player: 'B' }, undefined, reg).state;
    expect(state.players.A.exile.some((c) => c.instanceId === card!.instanceId)).toBe(true);

    state.priorityPlayer = 'A';
    state.step = 'precombatMain';
    const { cast, state: ready } = driveToCast(state);
    expect(cast.instanceId, 'the pilot must take the creature half it paid for').toBe(card!.instanceId);
    expect(cast.fromZone).toBe('exile');
    engineAccepts(ready, cast);
  });
});
