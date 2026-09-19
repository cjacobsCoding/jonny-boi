/**
 * "REMOVE A +1/+1 COUNTER FROM THIS CREATURE" AS AN ACTIVATION COST — Spike
 * Feeder, Spike Weaver, Umezawa's Jitte, Thorn Thallid (DESIGN §3.162).
 *
 * The read half of the counter family. The compiler already stored the inert
 * kinds ("put a charge counter on ~") and every +1/+1 placer; nothing could
 * SPEND them, so 176 cards on the corpus printed a cost the engine could not
 * pay. The cost is paid as the ability is activated (CR 602.2b), before it is
 * on the stack, and is never refunded.
 *
 * What this pins is that the cost is REAL, in both directions:
 *  - not offered, and refused by name, when the counters are not there
 *    (CR 122.5 — you cannot remove what is not on the permanent);
 *  - paying it takes the counters off BEFORE the ability resolves, with the
 *    same `counterAdded` event (negative) every other counter site emits;
 *  - the last counter off a 0/0 is lethal — the state-based action runs after
 *    the activation settles, exactly as paying life to zero does;
 *  - a kind is a kind: a charge counter cannot pay for a +1/+1 one.
 *
 * Beside it, the other activated-ability row the same lane added — "**another**
 * target creature" on an ACTIVATED ability (`targetsExcludeSelf`, Heliod's
 * lifelink grant): the source is never on its own menu, and an action naming it
 * anyway is refused, by the same flag.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  PLUS_ONE_COUNTER,
  type CardDefinition,
  type GameAction,
  type GameState,
  type InstanceId,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { deckOf, landDef } from './test-fixtures.js';

const FOREST = landDef('Forest', 'G');
const CHARGE = 'charge';

/** Spike Feeder's free half: a 0/0 that pays counters for life. */
const SPIKE: CardDefinition = {
  id: 'spike',
  name: 'Test Spike',
  types: ['creature'],
  power: 0,
  toughness: 0,
  activated: [
    {
      cost: { removeCounters: { kind: PLUS_ONE_COUNTER, count: 1 } },
      effects: [{ primitive: 'testMark' }],
      label: 'Remove a +1/+1 counter: mark',
    },
  ],
};

/** "Remove TWO charge counters from ~: mark" — a count above one, an inert kind. */
const BATTERY: CardDefinition = {
  id: 'battery',
  name: 'Test Battery',
  types: ['artifact'],
  activated: [
    {
      cost: { removeCounters: { kind: CHARGE, count: 2 } },
      effects: [{ primitive: 'testMark' }],
      label: 'Remove two charge counters: mark',
    },
  ],
};

/** Heliod's shape: "{0}: ANOTHER target creature gains lifelink until end of turn" — the aim is the point. */
const HERALD: CardDefinition = {
  id: 'herald',
  name: 'Test Herald',
  types: ['creature'],
  power: 2,
  toughness: 2,
  activated: [
    {
      cost: {},
      effects: [{ primitive: 'testMark', params: { targets: 'creature' } }],
      label: 'Another target creature: mark',
      targetsExcludeSelf: true,
    },
  ],
};

function creature(id: string): CardDefinition {
  return { id, name: id, types: ['creature'], power: 2, toughness: 2 };
}

interface Board {
  state: GameState;
  ids: InstanceId[];
  reg: EffectRegistry;
  marks: number[];
}

function setup(defs: readonly { def: CardDefinition; counters?: Record<string, number> }[]): Board {
  const marks: number[] = [];
  const reg = createEffectRegistry();
  reg.register('testMark', () => void marks.push(1));
  const { state } = createGame({ seed: 11, decks: { A: deckOf(FOREST, 40), B: deckOf(FOREST, 40) }, registry: reg });
  const ids: InstanceId[] = [];
  for (const { def, counters } of defs) {
    const id = state.nextInstanceId++;
    ids.push(id);
    state.battlefield.push({
      instanceId: id,
      def,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: counters ?? {},
    });
  }
  return { state, ids, reg, marks };
}

function offersFor(state: GameState, id: InstanceId): Extract<GameAction, { kind: 'activateAbility' }>[] {
  return generateLegalActions(state).filter(
    (a): a is Extract<GameAction, { kind: 'activateAbility' }> => a.kind === 'activateAbility' && a.instanceId === id,
  );
}

function activate(board: Board, id: InstanceId, targets?: InstanceId[]) {
  return applyAction(
    board.state,
    { kind: 'activateAbility', player: 'A', instanceId: id, abilityIndex: 0, ...(targets ? { targets } : {}) },
    DEFAULT_RULES,
    board.reg,
  );
}

function settle(state: GameState, reg: EffectRegistry): GameState {
  let s = state;
  for (let guard = 0; guard < 20 && s.stack.length > 0; guard++) {
    s = applyAction(s, { kind: 'passPriority', player: s.priorityPlayer }, DEFAULT_RULES, reg).state;
  }
  return s;
}

describe('an activation cost that removes counters from the source', () => {
  it('is NOT offered when the counters are not there, and is refused by name', () => {
    const board = setup([{ def: SPIKE, counters: {} }]);
    const [spike] = board.ids as [InstanceId];
    expect(offersFor(board.state, spike)).toEqual([]);
    const r = activate(board, spike);
    const rejected = r.events.find((e) => e.type === 'actionRejected') as { reason?: string } | undefined;
    expect(rejected?.reason).toMatch(/does not have 1 \+1\/\+1 counter/);
    expect(board.marks, 'nothing resolved').toEqual([]);
  });

  it('takes the counters off BEFORE the ability resolves, and never gives them back', () => {
    const board = setup([{ def: SPIKE, counters: { [PLUS_ONE_COUNTER]: 2 } }]);
    const [spike] = board.ids as [InstanceId];
    expect(offersFor(board.state, spike)).toHaveLength(1);
    const r = activate(board, spike);
    expect(r.events.find((e) => e.type === 'actionRejected')).toBeUndefined();
    const paid = r.state.battlefield.find((c) => c.instanceId === spike);
    expect(paid?.counters[PLUS_ONE_COUNTER], 'one counter gone with the ability still on the stack').toBe(1);
    expect(r.state.stack).toHaveLength(1);
    expect(
      r.events.some((e) => e.type === 'counterAdded' && e.instanceId === spike && e.kind === PLUS_ONE_COUNTER && e.amount === -1),
      'the same counterAdded vocabulary, negative',
    ).toBe(true);
    const after = settle(r.state, board.reg);
    expect(board.marks, 'the body resolved').toEqual([1]);
    expect(after.battlefield.find((c) => c.instanceId === spike)?.counters[PLUS_ONE_COUNTER]).toBe(1);
  });

  it('the last counter off a 0/0 is lethal — the cost is paid, the body resolves, the Spike dies', () => {
    const board = setup([{ def: SPIKE, counters: { [PLUS_ONE_COUNTER]: 1 } }]);
    const [spike] = board.ids as [InstanceId];
    const r = activate(board, spike);
    expect(r.events.find((e) => e.type === 'actionRejected')).toBeUndefined();
    const after = settle(r.state, board.reg);
    expect(after.battlefield.find((c) => c.instanceId === spike), 'toughness 0 — CR 704.5f').toBeUndefined();
    expect(after.players.A.graveyard.some((c) => c.instanceId === spike)).toBe(true);
    expect(board.marks, 'the ability still resolved (CR 602.2b — the cost is not refunded and the source is not required)').toEqual([1]);
  });

  it('counts above one, and a kind is a kind', () => {
    const one = setup([{ def: BATTERY, counters: { [CHARGE]: 1 } }]);
    expect(offersFor(one.state, one.ids[0] as InstanceId), 'one charge counter cannot pay for two').toEqual([]);
    const wrongKind = setup([{ def: BATTERY, counters: { [PLUS_ONE_COUNTER]: 5 } }]);
    expect(offersFor(wrongKind.state, wrongKind.ids[0] as InstanceId), 'five +1/+1 counters cannot pay a charge cost').toEqual([]);
    const two = setup([{ def: BATTERY, counters: { [CHARGE]: 3 } }]);
    const battery = two.ids[0] as InstanceId;
    expect(offersFor(two.state, battery)).toHaveLength(1);
    const r = activate(two, battery);
    expect(r.state.battlefield.find((c) => c.instanceId === battery)?.counters[CHARGE]).toBe(1);
  });
});

describe('"another target creature" on an ACTIVATED ability', () => {
  it('never offers the source to itself, and refuses an action that names it anyway', () => {
    const board = setup([{ def: HERALD }, { def: creature('bear') }]);
    const [herald, bear] = board.ids as [InstanceId, InstanceId];
    const offers = offersFor(board.state, herald);
    expect(offers.map((a) => a.targets?.[0]), 'only the other creature is on the menu').toEqual([bear]);
    const self = activate(board, herald, [herald]);
    const rejected = self.events.find((e) => e.type === 'actionRejected') as { reason?: string } | undefined;
    expect(rejected?.reason).toMatch(/another/);
    const other = activate(board, herald, [bear]);
    expect(other.events.find((e) => e.type === 'actionRejected')).toBeUndefined();
  });

  it('alone on the board it has nothing to aim at and is not offered at all', () => {
    const board = setup([{ def: HERALD }]);
    expect(offersFor(board.state, board.ids[0] as InstanceId)).toEqual([]);
  });
});
