/**
 * Blocking restrictions beyond the evasion keywords.
 *
 * Menace is the interesting one, and the reason it needed engine work rather
 * than a keyword flag: it is a constraint on the block DECLARATION, not on any
 * single attacker/blocker pair. Each blocker individually *can* block a
 * menacing creature — what the rule forbids is exactly one of them doing it. A
 * per-pair check cannot express that, so a naive implementation lets a single
 * blocker through and the keyword does nothing.
 */

import { describe, expect, it } from 'vitest';
import { canBlock, illegalBlockDeclaration } from './internal/combat.js';
import { indexContinuous } from './internal/continuous.js';
import { createGame } from './engine.js';
import { deckOf, landDef } from './test-fixtures.js';
import type { CardDefinition } from './card.js';
import type { CardInstance, GameState, PlayerId } from './state.js';

function creature(id: string, keywords?: CardDefinition['keywords']): CardDefinition {
  return { id, name: id, types: ['creature'], power: 2, toughness: 2, ...(keywords ? { keywords } : {}) };
}

function board(): GameState {
  const { state } = createGame({
    seed: 11,
    decks: { A: deckOf(landDef('Mountain', 'R'), 30), B: deckOf(landDef('Mountain', 'R'), 30) },
  });
  state.battlefield = [];
  state.continuous = [];
  return state;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const instance: CardInstance = {
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
  };
  state.battlefield.push(instance);
  return instance;
}

describe("can't be blocked", () => {
  it('refuses every blocker', () => {
    const state = board();
    const attacker = place(state, creature('Slippery', { unblockable: true }), 'A');
    const blocker = place(state, creature('Wall'), 'B');
    expect(canBlock(attacker, blocker, indexContinuous(state))).toBe(false);
  });

  it('beats reach and flying, which it subsumes', () => {
    const state = board();
    const attacker = place(state, creature('Slippery', { unblockable: true }), 'A');
    const flyer = place(state, creature('Flyer', { flying: true, reach: true }), 'B');
    expect(canBlock(attacker, flyer, indexContinuous(state))).toBe(false);
  });
});

describe('menace', () => {
  it('rejects a declaration where exactly one creature blocks it', () => {
    const state = board();
    const attacker = place(state, creature('Menacer', { menace: true }), 'A');
    const blocker = place(state, creature('Lone'), 'B');

    const problem = illegalBlockDeclaration(
      [attacker],
      [{ blocker: blocker.instanceId, attacker: attacker.instanceId }],
      indexContinuous(state),
    );
    expect(problem).toBeDefined();
    expect(problem).toContain('menace');
  });

  it('allows two blockers', () => {
    const state = board();
    const attacker = place(state, creature('Menacer', { menace: true }), 'A');
    const one = place(state, creature('One'), 'B');
    const two = place(state, creature('Two'), 'B');

    expect(
      illegalBlockDeclaration(
        [attacker],
        [
          { blocker: one.instanceId, attacker: attacker.instanceId },
          { blocker: two.instanceId, attacker: attacker.instanceId },
        ],
        indexContinuous(state),
      ),
    ).toBeUndefined();
  });

  it('allows going UNBLOCKED — menace forbids one blocker, not zero', () => {
    const state = board();
    const attacker = place(state, creature('Menacer', { menace: true }), 'A');
    expect(illegalBlockDeclaration([attacker], [], indexContinuous(state))).toBeUndefined();
  });

  it('does not constrain a creature without it', () => {
    const state = board();
    const plain = place(state, creature('Plain'), 'A');
    const blocker = place(state, creature('Lone'), 'B');
    expect(
      illegalBlockDeclaration(
        [plain],
        [{ blocker: blocker.instanceId, attacker: plain.instanceId }],
        indexContinuous(state),
      ),
    ).toBeUndefined();
  });

  it('judges each attacker separately in a multi-attacker declaration', () => {
    const state = board();
    const menacer = place(state, creature('Menacer', { menace: true }), 'A');
    const plain = place(state, creature('Plain'), 'A');
    const one = place(state, creature('One'), 'B');
    const two = place(state, creature('Two'), 'B');

    // The plain attacker is legally blocked by one; the menacer by one is not.
    const problem = illegalBlockDeclaration(
      [menacer, plain],
      [
        { blocker: one.instanceId, attacker: plain.instanceId },
        { blocker: two.instanceId, attacker: menacer.instanceId },
      ],
      indexContinuous(state),
    );
    expect(problem).toBeDefined();
    expect(problem).toContain('Menacer');
  });
});
