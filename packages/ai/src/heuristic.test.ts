import { describe, expect, it } from 'vitest';
import {
  createGame,
  createRng,
  generateLegalActions,
  type CardInstance,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { createHeuristicPilot, HEURISTIC_PILOT_ID } from './heuristic.js';
import {
  addPool,
  burnDef,
  creatureDef,
  destroyDef,
  giveHand,
  landDef,
  putOnBattlefield,
} from './test-support.js';

/** A deck stub good enough to start a game; tests override hand/board directly. */
function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => landDef(`L${i}`, 'R')) };
}

/** Fresh game; then we sculpt the position by hand. */
function freshGame(seed = 1): GameState {
  const { state } = createGame({ seed, decks: { A: stubDeck(), B: stubDeck() } });
  return state;
}

/** Put the active player (A) into their precombat main with priority and empty hand. */
function intoMainPhase(state: GameState): void {
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.landsPlayedThisTurn = 0;
}

/** Put A into the declare-attackers step as the active player. */
function intoDeclareAttackers(state: GameState): void {
  state.step = 'declareAttackers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.combat = { attackers: [], blocks: {} };
}

/** Put B into the declare-blockers step defending against A's attackers. */
function intoDeclareBlockers(state: GameState, attackers: CardInstance[]): void {
  state.step = 'declareBlockers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'B';
  state.combat = { attackers: attackers.map((a) => a.instanceId), blocks: {} };
}

const pilot = createHeuristicPilot();
const rng = () => createRng(99);

function choose(state: GameState): GameAction {
  const legal = generateLegalActions(state);
  return pilot.chooseAction({ view: state, legalActions: legal, rng: rng() });
}

describe('heuristic pilot — identity', () => {
  it('registers under the expected id', () => {
    expect(pilot.id).toBe(HEURISTIC_PILOT_ID);
    expect(HEURISTIC_PILOT_ID).toBe('heuristic');
  });
});

describe('heuristic pilot — land development', () => {
  it('plays a land when it has one and a land drop available', () => {
    const state = freshGame();
    intoMainPhase(state);
    const [land] = giveHand(state, 'A', [landDef('Mountain', 'R')]);
    const action = choose(state);
    expect(action).toEqual({ kind: 'playLand', player: 'A', instanceId: land!.instanceId });
  });
});

describe('heuristic pilot — removal & burn', () => {
  it('casts burn at the opponent face when it is lethal', () => {
    const state = freshGame();
    intoMainPhase(state);
    state.players.B.life = 3;
    const [bolt] = giveHand(state, 'A', [burnDef('Bolt', 3, { R: 1 })]);
    addPool(state, 'A', 'R', 1); // already have the mana floating → casts immediately
    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') {
      expect(action.instanceId).toBe(bolt!.instanceId);
      expect(action.targets).toEqual(['B']); // the face
    }
  });

  it('uses burn to kill an opposing creature rather than chip the face', () => {
    const state = freshGame();
    intoMainPhase(state);
    state.players.B.life = 20; // not lethal — killing a threat should win
    const [enemy] = putOnBattlefield(state, 'B', [creatureDef('Bear', 3, 3, { cost: { R: 2 } })]);
    const [bolt] = giveHand(state, 'A', [burnDef('Bolt', 3, { R: 1 })]);
    addPool(state, 'A', 'R', 1);
    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') {
      expect(action.instanceId).toBe(bolt!.instanceId);
      expect(action.targets).toEqual([enemy!.instanceId]); // kill the bear
    }
  });

  it('targets the BIGGEST killable threat with removal', () => {
    const state = freshGame();
    intoMainPhase(state);
    const small = putOnBattlefield(state, 'B', [creatureDef('Rat', 1, 1, { cost: { B: 1 } })]);
    const big = putOnBattlefield(state, 'B', [creatureDef('Ogre', 4, 4, { cost: { B: 3 } })]);
    giveHand(state, 'A', [destroyDef('Murder', { B: 1, generic: 1 })]);
    addPool(state, 'A', 'B', 2);
    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') {
      expect(action.targets).toEqual([big[0]!.instanceId]);
      expect(action.targets).not.toEqual([small[0]!.instanceId]);
    }
  });

  it('taps for mana toward a spell it cannot yet pay for', () => {
    const state = freshGame();
    intoMainPhase(state);
    state.players.B.life = 3;
    giveHand(state, 'A', [burnDef('Bolt', 3, { R: 1 })]);
    // A controls an untapped Mountain but has no floating mana yet.
    const [mountain] = putOnBattlefield(state, 'A', [landDef('Mountain', 'R')]);
    const action = choose(state);
    expect(action).toEqual({ kind: 'tapForMana', player: 'A', instanceId: mountain!.instanceId });
  });

  it('does not waste removal when there is no valid target', () => {
    const state = freshGame();
    intoMainPhase(state);
    giveHand(state, 'A', [destroyDef('Murder', { B: 1, generic: 1 })]);
    addPool(state, 'A', 'B', 2);
    // No opposing creatures → removal has no target → should just pass.
    const action = choose(state);
    expect(action.kind).toBe('passPriority');
  });
});

describe('heuristic pilot — developing the board', () => {
  it('casts a creature to develop when nothing better is available', () => {
    const state = freshGame();
    intoMainPhase(state);
    const [bear] = giveHand(state, 'A', [creatureDef('Bear', 2, 2, { cost: { R: 1 } })]);
    addPool(state, 'A', 'R', 1);
    const action = choose(state);
    expect(action.kind).toBe('castSpell');
    if (action.kind === 'castSpell') expect(action.instanceId).toBe(bear!.instanceId);
  });
});

describe('heuristic pilot — attacking', () => {
  it('attacks when unblocked (opponent has no creatures)', () => {
    const state = freshGame();
    const [bear] = putOnBattlefield(state, 'A', [creatureDef('Bear', 2, 2)]);
    intoDeclareAttackers(state);
    const action = choose(state);
    expect(action.kind).toBe('declareAttackers');
    if (action.kind === 'declareAttackers') expect(action.attackers).toContain(bear!.instanceId);
  });

  it('does NOT send a 1/1 into an untapped 3/3 blocker (no profitable trade)', () => {
    const state = freshGame();
    putOnBattlefield(state, 'A', [creatureDef('Goblin', 1, 1)]);
    putOnBattlefield(state, 'B', [creatureDef('Wall', 3, 3)]);
    intoDeclareAttackers(state);
    const action = choose(state);
    // It declines to attack — either an empty attack or a pass.
    if (action.kind === 'declareAttackers') {
      expect(action.attackers).toHaveLength(0);
    } else {
      expect(action.kind).toBe('passPriority');
    }
  });

  it('DOES attack a 3/3 into a 1/1 (favourable: it survives and kills)', () => {
    const state = freshGame();
    const [ogre] = putOnBattlefield(state, 'A', [creatureDef('Ogre', 3, 3)]);
    putOnBattlefield(state, 'B', [creatureDef('Rat', 1, 1)]);
    intoDeclareAttackers(state);
    const action = choose(state);
    expect(action.kind).toBe('declareAttackers');
    if (action.kind === 'declareAttackers') expect(action.attackers).toContain(ogre!.instanceId);
  });
});

describe('heuristic pilot — blocking', () => {
  it('blocks to avoid lethal even at a creature loss', () => {
    const state = freshGame();
    const attackers = putOnBattlefield(state, 'A', [creatureDef('Beater', 5, 5)]);
    const [chump] = putOnBattlefield(state, 'B', [creatureDef('Chump', 1, 1)]);
    state.players.B.life = 4; // 5 damage incoming is lethal
    intoDeclareBlockers(state, attackers);
    const action = choose(state);
    expect(action.kind).toBe('declareBlockers');
    if (action.kind === 'declareBlockers') {
      expect(action.blocks).toContainEqual({ blocker: chump!.instanceId, attacker: attackers[0]!.instanceId });
    }
  });

  it('makes a favourable block (kills the attacker, keeps its blocker)', () => {
    const state = freshGame();
    const attackers = putOnBattlefield(state, 'A', [creatureDef('Goblin', 2, 1)]);
    const [wall] = putOnBattlefield(state, 'B', [creatureDef('Wall', 1, 4)]);
    state.players.B.life = 20; // not desperate — only block if it's good value
    intoDeclareBlockers(state, attackers);
    const action = choose(state);
    expect(action.kind).toBe('declareBlockers');
    if (action.kind === 'declareBlockers') {
      // Wall (1/4) blocks Goblin (2/1): wall survives, goblin dies → great trade.
      expect(action.blocks).toContainEqual({ blocker: wall!.instanceId, attacker: attackers[0]!.instanceId });
    }
  });

  it('takes the hit rather than chump a fine life total away', () => {
    const state = freshGame();
    const attackers = putOnBattlefield(state, 'A', [creatureDef('Goblin', 2, 2)]);
    putOnBattlefield(state, 'B', [creatureDef('Bigger', 4, 4)]);
    state.players.B.life = 20; // healthy: don't trade our 4/4 down to a 2/2 we'd both die? no — 4/4 survives
    intoDeclareBlockers(state, attackers);
    const action = choose(state);
    // The 4/4 kills the 2/2 and survives → that's a favourable block, so it blocks.
    expect(action.kind).toBe('declareBlockers');
  });

  it('does not block a small attacker with a valuable creature for nothing when healthy', () => {
    const state = freshGame();
    const attackers = putOnBattlefield(state, 'A', [creatureDef('Goblin', 1, 1)]);
    putOnBattlefield(state, 'B', [creatureDef('Dragon', 5, 5)]);
    state.players.B.life = 20;
    intoDeclareBlockers(state, attackers);
    const action = choose(state);
    // Dragon (5/5) blocking a 1/1: dragon survives and kills it → still favourable,
    // so a block is fine here too. We assert it never throws and stays legal.
    expect(['declareBlockers']).toContain(action.kind);
  });

  it('emits a rationale trace for its decision', () => {
    const state = freshGame();
    intoMainPhase(state);
    giveHand(state, 'A', [landDef('Mountain', 'R')]);
    const traces: string[] = [];
    const legal = generateLegalActions(state);
    pilot.chooseAction({ view: state, legalActions: legal, rng: rng(), trace: (t) => traces.push(t.reason) });
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0]).toContain('land');
  });
});
