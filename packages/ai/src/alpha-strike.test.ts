/**
 * LETHAL IS CHECKED BEFORE PROFIT (§3.74).
 *
 * `chooseAttack` judges every attacker INDEPENDENTLY — "does this creature come
 * out ahead against their blockers?" — and three 2/2s each individually lose to
 * one 4/4. So a swing that ends the game on the spot was being declined one
 * creature at a time: a pilot that can win this turn and does not is not being
 * careful, it is misplaying.
 *
 * Measured head-to-head against the pilot exactly as it was before
 * (`packages/sim/bench/alpha-strike-ab.mjs`, 9 decks × 36 pairs × 60 games ×
 * both orientations = 4,320 games): **64 matched slots ahead, 0 behind**,
 * McNemar p = 3.6e-15. In 2,096 of 2,160 slots the two arms play the same game —
 * the case is rare — and when it does arise the new behaviour converted it every
 * single time.
 *
 * The tests below pin the two halves of the rule: it takes the win when the win
 * is guaranteed, and it does NOT swing when the defender could still survive.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState } from '@jonny-boi/core';
import { createGame, DEFAULT_RULES, generateLegalActions } from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import { creatureDef, landDef } from './test-support.js';

const BEAR: CardDefinition = creatureDef('bear', 2, 2);
const WALL: CardDefinition = creatureDef('wall', 4, 4);
const FOREST: CardDefinition = landDef('forest', 'G');

/** A board at the declare-attackers step, with the given creatures in play. */
function boardAtCombat(mine: readonly CardDefinition[], theirs: readonly CardDefinition[], theirLife: number): GameState {
  const { state } = createGame({
    seed: 5,
    startingPlayer: 'A',
    decks: {
      A: { cards: Array.from({ length: 20 }, () => FOREST) },
      B: { cards: Array.from({ length: 20 }, () => FOREST) },
    },
  });
  const place = (def: CardDefinition, controller: 'A' | 'B') => {
    state.battlefield.push({
      instanceId: state.nextInstanceId++,
      def,
      controller,
      owner: controller,
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    } as never);
  };
  for (const def of mine) place(def, 'A');
  for (const def of theirs) place(def, 'B');
  state.players.B.life = theirLife;
  state.step = 'declareAttackers';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  // ⚠️ `combat` MUST BE INITIALISED or the engine offers no `declareAttackers`
  // at all — the menu is just a pass, every arm of the test "declines to
  // attack", and the control passes while proving nothing. The first version of
  // this file did exactly that.
  state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
  return state;
}

function attackChosenBy(state: GameState, alphaStrike: boolean): GameAction {
  const pilot = createHeuristicPilot(undefined, { alphaStrike });
  const legalActions = generateLegalActions(state, DEFAULT_RULES);
  // The board must really be able to attack, or "it declined" is meaningless.
  expect(legalActions.some((a) => a.kind === 'declareAttackers')).toBe(true);
  return pilot.chooseAction({
    view: state,
    legalActions,
    rng: { next: () => 0.5 } as never,
    registry: undefined as never,
    rulesConfig: DEFAULT_RULES,
    observer: undefined,
  });
}

describe('the pilot takes a win it can prove', () => {
  it('swings with everything when no blocking assignment survives it', () => {
    // Three 2/2s into one 4/4, opponent at 4. Each attacker alone is a losing
    // trade — the 4/4 eats any one of them — so the old policy declined all
    // three. But the 4/4 can only block ONE: two 2/2s connect for 4. That is
    // exactly lethal.
    const state = boardAtCombat([BEAR, BEAR, BEAR], [WALL], 4);
    const action = attackChosenBy(state, true);
    expect(action.kind).toBe('declareAttackers');
    expect((action as Extract<GameAction, { kind: 'declareAttackers' }>).attackers).toHaveLength(3);
  });

  it('is exactly the play the old policy refused', () => {
    // The control: the same board, the same pilot, the feature off.
    const state = boardAtCombat([BEAR, BEAR, BEAR], [WALL], 4);
    expect(attackChosenBy(state, false).kind).toBe('passPriority');
  });

  it('does NOT swing when the defender can still survive it', () => {
    // One point of life more, and the arithmetic no longer closes: two 2/2s
    // connect for 4 against 5 life. A pilot that swung here would be throwing
    // creatures away on a hope, which is the mistake this must not trade for.
    const state = boardAtCombat([BEAR, BEAR, BEAR], [WALL], 5);
    expect(attackChosenBy(state, true).kind).toBe('passPriority');
  });

  it('does NOT swing when they have a blocker for every attacker', () => {
    // Two attackers, two untapped blockers, one life: nothing is guaranteed
    // through, however low they are.
    const state = boardAtCombat([BEAR, BEAR], [WALL, WALL], 1);
    expect(attackChosenBy(state, true).kind).toBe('passPriority');
  });

  it('counts a TAPPED creature as no blocker at all', () => {
    // The same losing board, except their wall is tapped — now every attacker
    // connects and 6 damage is plainly lethal at 5.
    const state = boardAtCombat([BEAR, BEAR, BEAR], [WALL], 5);
    const wall = state.battlefield.find((c) => c.controller === 'B');
    if (wall) wall.tapped = true;
    const action = attackChosenBy(state, true);
    expect(action.kind).toBe('declareAttackers');
    expect((action as Extract<GameAction, { kind: 'declareAttackers' }>).attackers).toHaveLength(3);
  });
});
