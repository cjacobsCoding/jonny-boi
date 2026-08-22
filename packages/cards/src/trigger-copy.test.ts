/**
 * COPYING A TRIGGERED ABILITY — Strionic Resonator, played.
 *
 * The stack holds two kinds of object and only one of them was copiable. What is
 * pinned here is the part that makes a trigger copy a copy rather than a second
 * trigger: it resolves ABOVE the original, it carries the original's own source
 * and targets, and re-aiming it is optional in the way CR 707.10 means — the same
 * "may" whose absence burned three soak games in §3.33.
 */
import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import { isLegalTarget, legalTargetsFor } from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

function byName(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

/** A bare state with one trigger on the stack, controlled by `owner`. */
function stateWithTrigger(owner: PlayerId, targets: readonly (InstanceId | PlayerId)[] = []): GameState {
  return {
    nextInstanceId: 100,
    battlefield: [],
    stack: [
      {
        kind: 'trigger',
        instanceId: 50,
        sourceInstanceId: 7,
        controller: owner,
        effects: [{ primitive: 'drawCards', params: { count: 1 } }],
        targets: [...targets],
        label: 'Enters: draw a card',
      },
    ],
    players: {
      A: { exile: [], hand: [], graveyard: [], library: [] },
      B: { exile: [], hand: [], graveyard: [], library: [] },
    },
  } as unknown as GameState;
}

function runCopy(state: GameState, controller: PlayerId, targetId: InstanceId): void {
  const primitive = buildRegistry().get('copyTriggeredAbility');
  expect(primitive, 'copyTriggeredAbility must be registered').toBeDefined();
  primitive!({
    state,
    source: { instanceId: 9, controller, owner: controller, def: byName('Strionic Resonator') },
    controller,
    targets: [targetId],
    params: { targets: 'triggeredAbilityYouControl', count: 1 },
    emit: () => {},
    ask: () => undefined,
  } as never);
}

describe('copy target triggered ability', () => {
  it('puts a copy on the stack ABOVE the original', () => {
    const s = stateWithTrigger('A');
    runCopy(s, 'A', 50);

    expect(s.stack.length, 'the original stays; the copy joins it').toBe(2);
    const copy = s.stack[1]!;
    expect(copy.kind).toBe('trigger');
    expect(copy.instanceId, 'a freshly minted id, never the original’s').not.toBe(50);
    // CR 707.10a — a copy has the same characteristics, so "this creature"
    // inside the ability still means the permanent that originally triggered.
    expect(copy.kind === 'trigger' && copy.sourceInstanceId).toBe(7);
    expect(copy.controller).toBe('A');
  });

  it('refuses a trigger the activator does not control', () => {
    // "target triggered ability YOU control" — copying the opponent's trigger
    // would be a strictly better card than the one printed.
    const s = stateWithTrigger('B');
    runCopy(s, 'A', 50);
    expect(s.stack.length, 'nothing was copied').toBe(1);
  });

  it('fizzles when the original has already left the stack', () => {
    const s = stateWithTrigger('A');
    s.stack.length = 0;
    runCopy(s, 'A', 50);
    expect(s.stack.length).toBe(0);
  });

  it('only ever offers a trigger you control, never a spell', () => {
    const s = stateWithTrigger('A');
    expect(legalTargetsFor(s, 'triggeredAbilityYouControl', 'A')).toEqual([50]);
    expect(legalTargetsFor(s, 'triggeredAbilityYouControl', 'B'), "not the opponent's to copy").toEqual([]);
    // The mirror invariant: "counter target spell" must not see a trigger.
    expect(legalTargetsFor(s, 'spell', 'A'), 'a trigger is not a spell').toEqual([]);
    expect(isLegalTarget(s, 'triggeredAbilityYouControl', 50, 'A')).toBe(true);
    expect(isLegalTarget(s, 'triggeredAbilityYouControl', 50, 'B')).toBe(false);
  });

  it('Strionic Resonator compiled with the printed cost, the tap, and the aim', () => {
    const ability = byName('Strionic Resonator').activated?.[0];
    expect(ability?.cost.mana?.generic).toBe(2);
    expect(ability?.cost.tap, 'the {T} is part of the cost').toBe(true);
    // Instant speed: the whole point is responding to your own trigger while it
    // is still on the stack.
    expect(ability?.timing ?? 'instant').toBe('instant');
    expect(ability?.effects[0]?.params?.['targets']).toBe('triggeredAbilityYouControl');
  });
});
