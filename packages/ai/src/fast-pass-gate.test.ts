/**
 * THE WIDENED FAST-PASS GATE, RULE BY RULE (§3.108).
 *
 * `heuristicWillPass` answers `true` only where the pilot provably passes, and
 * §3.108 taught it four windows the first gate refused wholesale: the priority
 * round AFTER a combat declaration, a defender with nothing to block with, a
 * non-empty stack, and an instant whose intent has nothing to act on (a counter
 * with an empty stack, a trick outside combat, removal with no creature to aim
 * at). Each rule is pinned here in both directions — where it fires, the pilot
 * really passes; where the decision is real, it refuses — because a `true` in
 * the wrong window makes the pilot silently weaker in every recorded win rate,
 * and the whole-game transcript guard (`packages/sim/src/action-plan.test.ts`)
 * can only catch a lie the sample decks happen to reach.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState } from '@jonny-boi/core';
import { createGame, DEFAULT_RULES, generateLegalActions } from '@jonny-boi/core';
import { createHeuristicPilot } from './heuristic.js';
import {
  burnDef,
  counterDef,
  creatureDef,
  giveHand,
  landDef,
  pumpDef,
  putOnBattlefield,
  putOnStack,
  shrinkDef,
} from './test-support.js';

const ISLAND = landDef('island', 'U');
const BEAR = creatureDef('bear', 2, 2);

/** A settled board: three untapped Islands for A, at the given step, with priority to A. */
function board(opts: { step: GameState['step']; active: 'A' | 'B' }): GameState {
  const { state } = createGame({
    seed: 3,
    startingPlayer: 'A',
    decks: {
      A: { cards: Array.from({ length: 20 }, () => ISLAND) },
      B: { cards: Array.from({ length: 20 }, () => ISLAND) },
    },
  });
  putOnBattlefield(state, 'A', [ISLAND, ISLAND, ISLAND]);
  state.step = opts.step;
  state.activePlayer = opts.active;
  state.priorityPlayer = 'A';
  // Past the land drop, so the hand's lands cannot be what keeps the gate shut.
  state.players.A.landsPlayedThisTurn = 1;
  return state;
}

const pilot = createHeuristicPilot();

function gate(state: GameState): boolean {
  return pilot.willPassPriority!(state, DEFAULT_RULES);
}

function chosen(state: GameState): GameAction {
  const legalActions = generateLegalActions(state, DEFAULT_RULES);
  return pilot.chooseAction({
    view: state,
    legalActions,
    rng: { next: () => 0.5 } as never,
    registry: undefined as never,
    rulesConfig: DEFAULT_RULES,
    observer: undefined,
  });
}

/** The promise itself: where the gate says pass, the pilot passes. */
function expectPromisedPass(state: GameState): void {
  expect(gate(state)).toBe(true);
  expect(chosen(state).kind).toBe('passPriority');
}

describe('an instant with nothing to act on does not keep the gate shut', () => {
  it('a counterspell with an empty stack is a pass; with a spell on the stack it is a decision', () => {
    const held = board({ step: 'precombatMain', active: 'B' });
    giveHand(held, 'A', [counterDef('counter')]);
    expectPromisedPass(held);

    const live = board({ step: 'precombatMain', active: 'B' });
    giveHand(live, 'A', [counterDef('counter')]);
    putOnStack(live, 'B', BEAR);
    expect(gate(live)).toBe(false);
  });

  it('a combat trick outside combat is a pass', () => {
    const state = board({ step: 'precombatMain', active: 'B' });
    giveHand(state, 'A', [pumpDef('pump', 2, 2, { U: 1 })]);
    expectPromisedPass(state);
  });

  it('shrink-removal with no enemy creature is a pass; with one it is a decision', () => {
    const empty = board({ step: 'precombatMain', active: 'B' });
    giveHand(empty, 'A', [shrinkDef('shrink', -2, -2, { U: 1 })]);
    expectPromisedPass(empty);

    const target = board({ step: 'precombatMain', active: 'B' });
    giveHand(target, 'A', [shrinkDef('shrink', -2, -2, { U: 1 })]);
    putOnBattlefield(target, 'B', [BEAR]);
    expect(gate(target)).toBe(false);
  });

  it('burn that can go to the face is always a decision', () => {
    const state = board({ step: 'precombatMain', active: 'B' });
    giveHand(state, 'A', [burnDef('bolt', 3, { U: 1 })]);
    expect(gate(state)).toBe(false);
  });
});

describe('a combat step is refused only while the declaration is still to be made', () => {
  it('the attacker\'s priority round after declaring is a pass', () => {
    const state = board({ step: 'declareAttackers', active: 'A' });
    const [bear] = putOnBattlefield(state, 'A', [BEAR]);
    bear!.tapped = true; // it attacked
    state.combat = { attackers: [bear!.instanceId], blocks: {}, attackersDeclared: true, blockersDeclared: false };
    expectPromisedPass(state);
  });

  it('the attack declaration itself is a decision', () => {
    const state = board({ step: 'declareAttackers', active: 'A' });
    putOnBattlefield(state, 'A', [BEAR]);
    state.combat = { attackers: [], blocks: {}, attackersDeclared: false, blockersDeclared: false };
    expect(generateLegalActions(state, DEFAULT_RULES).some((a) => a.kind === 'declareAttackers')).toBe(true);
    expect(gate(state)).toBe(false);
  });

  it('a defender with no untapped creature has nothing to declare, and passes', () => {
    const state = board({ step: 'declareBlockers', active: 'B' });
    const [attacker] = putOnBattlefield(state, 'B', [BEAR]);
    attacker!.tapped = true;
    state.combat = { attackers: [attacker!.instanceId], blocks: {}, attackersDeclared: true, blockersDeclared: false };
    // The empty declaration IS on the menu — §3.79's trap — and the pilot still passes.
    expect(generateLegalActions(state, DEFAULT_RULES).some((a) => a.kind === 'declareBlockers')).toBe(true);
    expectPromisedPass(state);
  });

  it('a defender with an untapped creature is making a real block decision', () => {
    const state = board({ step: 'declareBlockers', active: 'B' });
    const [attacker] = putOnBattlefield(state, 'B', [BEAR]);
    attacker!.tapped = true;
    putOnBattlefield(state, 'A', [BEAR]);
    state.combat = { attackers: [attacker!.instanceId], blocks: {}, attackersDeclared: true, blockersDeclared: false };
    expect(gate(state)).toBe(false);
  });

  it('a fog-shaped trick is a decision once attackers are in combat', () => {
    // The same trick that was a pass outside combat above.
    const state = board({ step: 'declareBlockers', active: 'B' });
    const [attacker] = putOnBattlefield(state, 'B', [BEAR]);
    attacker!.tapped = true;
    state.combat = { attackers: [attacker!.instanceId], blocks: {}, attackersDeclared: true, blockersDeclared: true };
    giveHand(state, 'A', [pumpDef('pump', 2, 2, { U: 1 })]);
    expect(gate(state)).toBe(false);
  });
});

describe('a non-empty stack is reasoned about, not refused', () => {
  it('a sorcery-speed hand with the opponent\'s spell on the stack is a pass', () => {
    const state = board({ step: 'precombatMain', active: 'B' });
    giveHand(state, 'A', [BEAR]);
    putOnStack(state, 'B', BEAR);
    expectPromisedPass(state);
  });

  it('the caster\'s own priority round with its spell on the stack is a pass', () => {
    const state = board({ step: 'precombatMain', active: 'A' });
    giveHand(state, 'A', [BEAR]);
    putOnStack(state, 'A', BEAR);
    expectPromisedPass(state);
  });
});

describe('what the gate must still refuse', () => {
  it('a second land drop granted by a permanent', () => {
    const exploration: CardDefinition = { id: 'exploration', name: 'exploration', types: ['enchantment'], additionalLandPlays: 1 };
    const state = board({ step: 'precombatMain', active: 'A' });
    putOnBattlefield(state, 'A', [exploration]);
    giveHand(state, 'A', [ISLAND]);
    expect(generateLegalActions(state, DEFAULT_RULES).some((a) => a.kind === 'playLand')).toBe(true);
    expect(gate(state)).toBe(false);
  });

  it('a madness window', () => {
    const state = board({ step: 'precombatMain', active: 'B' });
    state.madnessWindow = { instanceId: 999 as never, controller: 'A' } as GameState['madnessWindow'];
    expect(gate(state)).toBe(false);
  });
});
