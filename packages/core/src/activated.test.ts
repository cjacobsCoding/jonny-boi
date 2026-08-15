/**
 * Activated abilities in the engine: offering them, paying their cost, and
 * resolving them off the stack.
 *
 * The invariant that matters most is that the COST IS REAL. An ability whose
 * cost is offered but not charged plays strictly better than the printed card,
 * and every A/B verdict involving that card is then wrong in the card's favour.
 */

import { describe, expect, it } from 'vitest';
import { applyAction, createGame, generateLegalActions } from './engine.js';
import { createEffectRegistry } from './effects.js';
import type { CardDefinition } from './card.js';
import type { EffectRegistry } from './effects.js';
import type { GameAction, GameState } from './index.js';

/** A plain land that taps for one red. */
const MOUNTAIN: CardDefinition = {
  id: 'mountain',
  name: 'Mountain',
  types: ['land'],
  subtypes: ['mountain'],
  produces: ['R'],
};

/**
 * A fetchland, exactly as printed: tap, pay 1 life, sacrifice it, then put a
 * Mountain from your library onto the battlefield.
 */
const FETCHLAND: CardDefinition = {
  id: 'fetch',
  name: 'Test Mesa',
  types: ['land'],
  activated: [
    {
      cost: { tap: true, life: 1, sacrificeSelf: true },
      effects: [{ primitive: 'fetchMountain' }],
      label: '{T}, Pay 1 life, Sacrifice ~: Search your library for a Mountain',
    },
  ],
};

/** A registry whose one primitive moves a Mountain from library to battlefield. */
function fetchRegistry(): EffectRegistry {
  const registry = createEffectRegistry();
  registry.register('fetchMountain', (ctx) => {
    const player = ctx.state.players[ctx.controller];
    const index = player.library.findIndex((c) => c.def.id === MOUNTAIN.id);
    if (index < 0) return;
    const [found] = player.library.splice(index, 1);
    found!.zone = 'battlefield';
    found!.controller = ctx.controller;
    ctx.state.battlefield.push(found!);
  });
  return registry;
}

/** Start a game with the fetchland already on the battlefield, untapped. */
function gameWithFetchland(): { state: GameState; registry: EffectRegistry; fetchId: number } {
  const registry = fetchRegistry();
  const library = [FETCHLAND, ...Array.from({ length: 40 }, () => MOUNTAIN)];
  const created = createGame({
    seed: 3,
    startingPlayer: 'A',
    registry,
    decks: { A: { cards: library }, B: { cards: library } },
  });
  const state = created.state;

  // Put a fetchland onto A's battlefield directly, untapped and not sick.
  const instance = state.players.A.library.find((c) => c.def.id === FETCHLAND.id)!;
  state.players.A.library = state.players.A.library.filter((c) => c !== instance);
  instance.zone = 'battlefield';
  instance.summoningSick = false;
  state.battlefield.push(instance);

  return { state, registry, fetchId: instance.instanceId };
}

/** Resolve everything on the stack by passing priority from both seats. */
function resolveStack(state: GameState, registry: EffectRegistry): GameState {
  let current = state;
  for (let i = 0; i < 8 && current.stack.length > 0; i++) {
    const pass: GameAction = { kind: 'passPriority', player: current.priorityPlayer };
    current = applyAction(current, pass, undefined, registry).state;
  }
  return current;
}

describe('activated abilities', () => {
  it('offers the ability to the controller', () => {
    const { state, fetchId } = gameWithFetchland();
    const actions = generateLegalActions(state);
    const activate = actions.find(
      (a) => a.kind === 'activateAbility' && a.instanceId === fetchId,
    );
    expect(activate).toBeDefined();
  });

  it('charges the whole cost: taps, pays life, and sacrifices the land', () => {
    const { state, registry, fetchId } = gameWithFetchland();
    const lifeBefore = state.players.A.life;

    const after = applyAction(
      state,
      { kind: 'activateAbility', player: 'A', instanceId: fetchId, abilityIndex: 0 },
      undefined,
      registry,
    ).state;

    expect(after.players.A.life, 'the life payment is real').toBe(lifeBefore - 1);
    expect(
      after.battlefield.some((c) => c.instanceId === fetchId),
      'the sacrifice is real — the land left the battlefield',
    ).toBe(false);
    expect(
      after.players.A.graveyard.some((c) => c.instanceId === fetchId),
      'the sacrificed land is in the graveyard',
    ).toBe(true);
    expect(after.stack, 'the ability is on the stack').toHaveLength(1);
  });

  it('resolves the ability and actually fetches the land', () => {
    const { state, registry, fetchId } = gameWithFetchland();
    const activated = applyAction(
      state,
      { kind: 'activateAbility', player: 'A', instanceId: fetchId, abilityIndex: 0 },
      undefined,
      registry,
    ).state;

    const resolved = resolveStack(activated, registry);
    expect(resolved.stack).toHaveLength(0);
    expect(
      resolved.battlefield.filter((c) => c.controller === 'A' && c.def.id === MOUNTAIN.id),
    ).toHaveLength(1);
  });

  it('refuses to activate when the life cost would kill you', () => {
    const { state, registry, fetchId } = gameWithFetchland();
    state.players.A.life = 1; // paying 1 would leave 0

    const result = applyAction(
      state,
      { kind: 'activateAbility', player: 'A', instanceId: fetchId, abilityIndex: 0 },
      undefined,
      registry,
    );
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(true);
    // And it is not even offered, so a pilot never sees an unplayable action.
    expect(
      generateLegalActions(state).some((a) => a.kind === 'activateAbility'),
    ).toBe(false);
  });

  it('refuses a second activation once the permanent is tapped', () => {
    const { state, registry, fetchId } = gameWithFetchland();
    const activate: GameAction = {
      kind: 'activateAbility',
      player: 'A',
      instanceId: fetchId,
      abilityIndex: 0,
    };
    const after = applyAction(state, activate, undefined, registry).state;
    const again = applyAction(after, activate, undefined, registry);
    expect(again.events.some((e) => e.type === 'actionRejected')).toBe(true);
  });

  it('rejects an opponent activating your permanent', () => {
    const { state, registry, fetchId } = gameWithFetchland();
    const result = applyAction(
      state,
      { kind: 'activateAbility', player: 'B', instanceId: fetchId, abilityIndex: 0 },
      undefined,
      registry,
    );
    expect(result.events.some((e) => e.type === 'actionRejected')).toBe(true);
  });
});
