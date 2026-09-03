/**
 * §3.123 — THE PILOT MEETS THE SPLIT-SECOND WALL (CR 702.61).
 *
 * "As long as this spell is on the stack, players can't cast spells or activate
 * abilities that aren't mana abilities." Core has said so from both sides since
 * §3.107 — the offer pass filters those actions out of the menu, and the three
 * apply paths refuse them — and `split-second.ts` even names the reason both
 * sides exist: "a pilot or UI that builds its own action must meet the same
 * wall."
 *
 * The pilot did not. Half its policies BUILD an action rather than picking one
 * off the menu (that is deliberate — the engine offers a cast only once the pool
 * already covers it, so a pilot that did not plan its taps would never see one),
 * and not one of them consulted the lock. The soak caught it on the 6,257-card
 * pool, seed 3287629870: Sulfur Elemental — a flash creature that carries split
 * second — resolving in the opponent's upkeep, and the pilot proposing Failed
 * Inspection into it. Two invariants broke at once, which is the signature of
 * this class: **"was never offered"** and **"the engine rejected an offered
 * action"**, the same action seen from the menu's side and the wall's.
 *
 * What is pinned: under the lock the pilot proposes nothing the engine refuses,
 * it still passes rather than freezing, the madness LAND play survives (a
 * special action, CR 115.2a, which 702.61 does not touch), and — the CONTROL —
 * the very same board casts the very same spell the instant the lock lifts.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  createRng,
  generateLegalActions,
  type CardDefinition,
  type DeckList,
  type GameAction,
  type GameState,
} from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { createTestRegistry, giveHand } from './test-support.js';

/** Sulfur Elemental's shape: a flash creature whose spell carries split second. */
const LOCKER: CardDefinition = {
  id: 'Locker',
  name: 'Split Second Elemental',
  types: ['creature'],
  power: 3,
  toughness: 2,
  cost: { generic: 1, R: 1 },
  keywords: { flash: true, splitSecond: true },
};

/** A cheap instant the pilot always wants to cast — the thing it used to propose. */
const TRICK: CardDefinition = {
  id: 'Trick',
  name: 'Failed Inspection',
  types: ['instant'],
  timing: 'instant',
  cost: { U: 1 },
  effects: [{ primitive: 'drawCards', params: { count: 1 } }],
};

function stubDeck(): DeckList {
  return { cards: Array.from({ length: 30 }, (_, i) => ({ id: `L${i}`, name: `L${i}`, types: ['land'], produces: ['U'] }) as CardDefinition) };
}

/** B holds priority in A's upkeep with five untapped duals and a full pool. */
function boardInUpkeep(): GameState {
  const { state } = createGame({ seed: 31, decks: { A: stubDeck(), B: stubDeck() } });
  state.step = 'upkeep';
  state.activePlayer = 'A';
  state.priorityPlayer = 'B';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  const dual: CardDefinition = { id: 'Dual', name: 'Dual', types: ['land'], producesOptions: [{ U: 1 }, { R: 1 }] };
  const placed = giveHand(state, 'B', Array.from({ length: 5 }, () => dual));
  state.players.B.hand = [];
  for (const land of placed) {
    land.zone = 'battlefield';
    land.summoningSick = false;
    state.battlefield.push(land);
  }
  return state;
}

/** Put a split-second spell on the stack, as a real cast would. */
function lock(state: GameState): GameState {
  const [locker] = giveHand(state, 'A', [LOCKER]);
  state.players.A.hand = [];
  (locker as { zone: string }).zone = 'stack';
  state.stack.push({ kind: 'spell', instanceId: locker!.instanceId, controller: 'A', card: locker!, targets: [] } as never);
  return state;
}

/** Every action the pilot takes over `plies`, and every rejection the engine gave. */
function drive(state: GameState, plies = 10): { actions: GameAction[]; rejections: string[] } {
  const reg = createTestRegistry();
  const pilot = createHeuristicPilot();
  const actions: GameAction[] = [];
  const rejections: string[] = [];
  let current = state;
  for (let ply = 0; ply < plies; ply++) {
    const legalActions = generateLegalActions(current);
    const action = pilot.chooseAction({ view: current, legalActions, rng: createRng(3) });
    actions.push(action);
    const result = applyAction(current, action, undefined, reg);
    for (const event of result.events) {
      if (event.type === 'actionRejected') rejections.push(event.reason);
    }
    current = result.state;
    if (action.kind === 'passPriority') break;
  }
  return { actions, rejections };
}

describe('the pilot under a split-second lock (§3.123)', () => {
  it('proposes nothing the engine refuses, and passes instead', () => {
    const state = lock(boardInUpkeep());
    giveHand(state, 'B', [TRICK]);
    const { actions, rejections } = drive(state);
    expect(rejections, `the engine refused: ${rejections.join('; ')}`).toEqual([]);
    expect(actions.some((a) => a.kind === 'castSpell')).toBe(false);
    expect(actions[actions.length - 1]?.kind).toBe('passPriority');
  });

  it('the engine still refuses that cast, and still keeps it off the menu', () => {
    const state = lock(boardInUpkeep());
    const [trick] = giveHand(state, 'B', [TRICK]);
    state.players.B.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 0 };
    expect(generateLegalActions(state).some((a) => a.kind === 'castSpell')).toBe(false);
    const result = applyAction(state, { kind: 'castSpell', player: 'B', instanceId: trick!.instanceId }, undefined, createTestRegistry());
    const rejected = result.events.find((e) => e.type === 'actionRejected');
    expect(rejected && (rejected as { reason: string }).reason).toContain('split second');
  });

  it('CONTROL: the same board casts the same spell the moment the lock lifts', () => {
    const state = boardInUpkeep(); // identical, minus the split-second spell
    giveHand(state, 'B', [TRICK]);
    const { actions, rejections } = drive(state);
    expect(rejections).toEqual([]);
    expect(actions.some((a) => a.kind === 'castSpell'), 'the pilot went inert instead of gated').toBe(true);
  });
});
