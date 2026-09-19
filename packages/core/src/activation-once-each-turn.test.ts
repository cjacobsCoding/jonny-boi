/**
 * "ACTIVATE ONLY ONCE EACH TURN" (CR 602.5d) — Mindful Biomancer, Frilled
 * Oculus, Twinblade Slasher, Wolfsbane, Highland Hero … (DESIGN §3.168). 313
 * cards on the corpus print exactly this sentence; 77 of them had it as their
 * ONLY blocking clause.
 *
 * The rule is a memory of THIS permanent for THIS ability for THIS turn, kept
 * the way the planeswalker once-per-turn rule already is (the turn number,
 * compared to the game's; no reset pass; a zone change forgets it — CR 400.7).
 * What is pinned:
 *  - the second activation in a turn is neither offered nor accepted, by name;
 *  - it counts the ACTIVATION, not the resolution — the memory is written as the
 *    cost is paid, while the first activation is still on the stack;
 *  - the next turn offers it again, with no reset pass having run;
 *  - a permanent that leaves and returns is a new object and may activate again
 *    in the same turn;
 *  - it is per ability: a permanent with two such abilities may use each once,
 *    and a sibling ability without the sentence is unlimited.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  type CardDefinition,
  type GameAction,
  type GameState,
  type InstanceId,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { moveToZone, resetInstanceForNewZone } from './internal/zones.js';
import { deckOf, landDef } from './test-fixtures.js';

const FOREST = landDef('Forest', 'G');

/** Mindful Biomancer's shape: a free-to-test once-a-turn pump. */
const BIOMANCER: CardDefinition = {
  id: 'biomancer',
  name: 'Test Biomancer',
  types: ['creature'],
  power: 1,
  toughness: 1,
  activated: [
    {
      cost: {},
      effects: [{ primitive: 'testMark', params: { which: 'once' } }],
      label: 'Once each turn: mark',
      activateOnly: { kind: 'onceEachTurn' },
    },
    {
      cost: {},
      effects: [{ primitive: 'testMark', params: { which: 'free' } }],
      label: 'Any time: mark',
    },
    {
      cost: {},
      effects: [{ primitive: 'testMark', params: { which: 'once-2' } }],
      label: 'The other once each turn: mark',
      activateOnly: { kind: 'onceEachTurn' },
    },
  ],
};

interface Board {
  state: GameState;
  id: InstanceId;
  reg: EffectRegistry;
  marks: string[];
}

function setup(): Board {
  const marks: string[] = [];
  const reg = createEffectRegistry();
  reg.register(
    'testMark',
    (ctx) => void marks.push(String((ctx.params as { which?: string }).which)),
  );
  const { state } = createGame({
    seed: 5,
    decks: { A: deckOf(FOREST, 40), B: deckOf(FOREST, 40) },
    registry: reg,
  });
  const id = state.nextInstanceId++;
  state.battlefield.push({
    instanceId: id,
    def: BIOMANCER,
    controller: 'A',
    owner: 'A',
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return { state, id, reg, marks };
}

function offered(state: GameState, id: InstanceId): number[] {
  return generateLegalActions(state)
    .filter(
      (a): a is Extract<GameAction, { kind: 'activateAbility' }> =>
        a.kind === 'activateAbility' && a.instanceId === id,
    )
    .map((a) => a.abilityIndex)
    .sort();
}

function activate(board: Board, abilityIndex: number) {
  return applyAction(
    board.state,
    { kind: 'activateAbility', player: 'A', instanceId: board.id, abilityIndex },
    DEFAULT_RULES,
    board.reg,
  );
}

function rejection(r: ReturnType<typeof applyAction>): string | undefined {
  return (r.events.find((e) => e.type === 'actionRejected') as { reason?: string } | undefined)
    ?.reason;
}

function settle(state: GameState, reg: EffectRegistry): GameState {
  let s = state;
  for (let guard = 0; guard < 20 && s.stack.length > 0; guard++) {
    s = applyAction(
      s,
      { kind: 'passPriority', player: s.priorityPlayer },
      DEFAULT_RULES,
      reg,
    ).state;
  }
  return s;
}

/** Pass priority until it is the given player's turn again (a fresh turn number). */
function toNextTurnOf(state: GameState, reg: EffectRegistry, player: 'A' | 'B'): GameState {
  const startTurn = state.turnNumber;
  let s = state;
  for (let guard = 0; guard < 400; guard++) {
    if (
      s.turnNumber > startTurn &&
      s.activePlayer === player &&
      s.step === 'precombatMain' &&
      s.stack.length === 0
    )
      return s;
    // Pass when passing is legal; otherwise answer the parked question (the
    // cleanup discard of a hand that drew past seven) with its first option.
    const legal = generateLegalActions(s);
    const next = legal.find((a) => a.kind === 'passPriority') ?? legal[0];
    if (!next) throw new Error('no legal action');
    s = applyAction(s, next, DEFAULT_RULES, reg).state;
  }
  throw new Error('never reached the next turn');
}

describe('"Activate only once each turn"', () => {
  it('offers the ability once, then neither offers nor accepts it again this turn — by name', () => {
    const board = setup();
    expect(offered(board.state, board.id)).toEqual([0, 1, 2]);

    const first = activate(board, 0);
    expect(rejection(first)).toBeUndefined();
    // The memory is written as the cost is paid, with the ability still on the
    // stack: CR 602.5d counts activations, not resolutions.
    expect(first.state.stack).toHaveLength(1);
    expect(
      offered(first.state, board.id),
      'index 0 is off the menu while its own activation waits',
    ).toEqual([1, 2]);

    board.state = settle(first.state, board.reg);
    expect(board.marks).toEqual(['once']);
    expect(offered(board.state, board.id)).toEqual([1, 2]);
    const again = activate(board, 0);
    expect(rejection(again)).toBe("Test Biomancer's ability has already been activated this turn");
  });

  it('is per ABILITY: the sibling once-each-turn ability and the unlimited one are unaffected', () => {
    const board = setup();
    board.state = settle(activate(board, 0).state, board.reg);
    board.state = settle(activate(board, 1).state, board.reg);
    board.state = settle(activate(board, 1).state, board.reg);
    board.state = settle(activate(board, 2).state, board.reg);
    expect(board.marks).toEqual(['once', 'free', 'free', 'once-2']);
    expect(offered(board.state, board.id)).toEqual([1]);
    expect(rejection(activate(board, 2))).toMatch(/already been activated this turn/);
  });

  it('a new turn offers it again — the turn number moved, nothing had to be reset', () => {
    const board = setup();
    board.state = settle(activate(board, 0).state, board.reg);
    const memory = board.state.battlefield.find(
      (c) => c.instanceId === board.id,
    )?.onceEachTurnActivated;
    expect(memory).toEqual({ 0: board.state.turnNumber });

    board.state = toNextTurnOf(board.state, board.reg, 'A');
    expect(offered(board.state, board.id)).toEqual([0, 1, 2]);
    const r = activate(board, 0);
    expect(rejection(r)).toBeUndefined();
    // The stale turn is simply overwritten; the record never grows past its abilities.
    expect(
      r.state.battlefield.find((c) => c.instanceId === board.id)?.onceEachTurnActivated,
    ).toEqual({
      0: r.state.turnNumber,
    });
  });

  it('a permanent that leaves and returns is a new object with no memory (CR 400.7)', () => {
    const board = setup();
    board.state = settle(activate(board, 0).state, board.reg);
    const inst = board.state.battlefield.find((c) => c.instanceId === board.id)!;
    // Bounce it through the engine's own zone funnel and put it straight back,
    // as a flicker would.
    // (Every engine caller of `moveToZone` resets the moving object itself —
    // the funnel moves, `resetInstanceForNewZone` forgets; see the bounce paths.)
    resetInstanceForNewZone(inst);
    moveToZone(board.state, inst, 'hand', () => {});
    expect(inst.onceEachTurnActivated).toBeUndefined();
    const back = board.state.players.A.hand.find((c) => c.instanceId === board.id)!;
    board.state.players.A.hand = board.state.players.A.hand.filter((c) => c !== back);
    back.zone = 'battlefield';
    back.summoningSick = false;
    board.state.battlefield.push(back);
    expect(offered(board.state, board.id)).toEqual([0, 1, 2]);
    expect(rejection(activate(board, 0))).toBeUndefined();
  });
});
