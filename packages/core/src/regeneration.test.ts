/**
 * REGENERATION (CR 701.15) — "The next time this permanent would be destroyed
 * this turn, instead tap it, remove it from combat, and remove all damage."
 *
 * A shield, not a keyword: it is raised by an ability and SPENT by whatever
 * tries to destroy the permanent afterwards. What this pins is that the
 * replacement is ONE rule — the state-based lethal-damage death and a targeted
 * "destroy" both consult the same helper, because a shield that saved a
 * creature from a wrath but not from a Murder would be two rules wearing one
 * name.
 */

import { describe, expect, it } from 'vitest';
import { checkStateBasedActions, consumeRegenerationShield, type CardDefinition, type CardInstance, type GameState } from './index.js';

function bear(): CardDefinition {
  return { id: 'bear', name: 'Regenerating Bear', types: ['creature'], power: 2, toughness: 2 };
}

function boardWith(shields: number | undefined, damage: number): { state: GameState; creature: CardInstance } {
  const creature = {
    instanceId: 5,
    def: bear(),
    controller: 'A',
    owner: 'A',
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: damage,
    markedByDeathtouch: false,
    counters: {},
    ...(shields === undefined ? {} : { regenerationShields: shields }),
  } as unknown as CardInstance;
  const state = {
    battlefield: [creature],
    stack: [],
    continuous: [],
    combat: { attackers: [creature.instanceId], blocks: {}, attackersDeclared: true },
    players: {
      A: { life: 20, hand: [], library: [], graveyard: [], exile: [], command: [], hasLost: false },
      B: { life: 20, hand: [], library: [], graveyard: [], exile: [], command: [], hasLost: false },
    },
    nextInstanceId: 50,
    turnNumber: 1,
    step: 'combatDamage',
    activePlayer: 'A',
    priorityPlayer: 'A',
    gameOver: false,
  } as unknown as GameState;
  return { state, creature };
}

describe('a regeneration shield replaces a lethal-damage death', () => {
  it('taps the creature, clears its damage, removes it from combat, and spends ONE shield', () => {
    const { state, creature } = boardWith(2, 2);
    checkStateBasedActions(state, () => {});
    expect(state.battlefield.some((c) => c.instanceId === creature.instanceId)).toBe(true);
    expect(creature.tapped).toBe(true);
    expect(creature.damageMarked).toBe(0);
    expect(creature.regenerationShields).toBe(1);
    expect(state.combat?.removedFromCombat ?? []).toContain(creature.instanceId);
  });

  it('an UNSHIELDED creature still dies — the shield is the whole difference', () => {
    const { state, creature } = boardWith(undefined, 2);
    checkStateBasedActions(state, () => {});
    expect(state.battlefield.some((c) => c.instanceId === creature.instanceId)).toBe(false);
  });

  it('shields STACK: two activations survive two destructions', () => {
    const { state, creature } = boardWith(2, 2);
    checkStateBasedActions(state, () => {});
    expect(creature.regenerationShields).toBe(1);
    // A second lethal hit, same turn.
    creature.damageMarked = 2;
    checkStateBasedActions(state, () => {});
    expect(state.battlefield.some((c) => c.instanceId === creature.instanceId)).toBe(true);
    expect(creature.regenerationShields).toBe(0);
    // The third kills it — the shields are spent.
    creature.damageMarked = 2;
    checkStateBasedActions(state, () => {});
    expect(state.battlefield.some((c) => c.instanceId === creature.instanceId)).toBe(false);
  });

  it('the same helper answers a DESTROY, so one shield covers both routes', () => {
    const { state, creature } = boardWith(1, 0);
    expect(consumeRegenerationShield(state, creature, () => {})).toBe(true);
    expect(creature.regenerationShields).toBe(0);
    expect(consumeRegenerationShield(state, creature, () => {})).toBe(false);
  });
});
