/**
 * Flash, hexproof and shroud — three keywords that are NOT combat flags.
 *
 * They matter because each one changes what is *legal*, not what happens in
 * damage: flash changes when a card may be cast, hexproof and shroud change what
 * a spell may point at. A keyword the engine stores but never reads is a card
 * that lies about itself, so these assert the rules are actually enforced.
 */

import { describe, expect, it } from 'vitest';
import { castTiming } from './card.js';
import type { CardDefinition } from './card.js';
import { isLegalTarget, legalTargetsFor } from './targeting.js';
import type { CardInstance, GameState, InstanceId, PlayerId } from './state.js';
import { createGame } from './engine.js';
import { deckOf, landDef } from './test-fixtures.js';

const SEED = 909;

/** A creature definition with optional keywords. */
function creature(id: string, keywords?: CardDefinition['keywords']): CardDefinition {
  return {
    id,
    name: id,
    types: ['creature'],
    power: 2,
    toughness: 2,
    ...(keywords ? { keywords } : {}),
  };
}

function board(): GameState {
  const { state } = createGame({
    seed: SEED,
    decks: { A: deckOf(landDef('Mountain', 'R'), 30), B: deckOf(landDef('Mountain', 'R'), 30) },
  });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  return state;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
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
  return instance.instanceId;
}

describe('flash is a timing rule', () => {
  it('makes a creature instant-speed', () => {
    expect(castTiming(creature('Flashy', { flash: true }))).toBe('instant');
  });

  it('leaves an ordinary creature at sorcery speed', () => {
    expect(castTiming(creature('Plain'))).toBe('sorcery');
  });

  it('does not override an explicit timing already on the card', () => {
    const def: CardDefinition = { ...creature('Odd', { flash: true }), timing: 'sorcery' };
    expect(castTiming(def)).toBe('sorcery');
  });
});

describe('hexproof — protected from opponents only', () => {
  it("blocks an opponent's spell", () => {
    const state = board();
    const target = place(state, creature('Hexy', { hexproof: true }), 'B');
    expect(isLegalTarget(state, 'creature', target, 'A')).toBe(false);
  });

  it('still lets its OWN controller target it', () => {
    const state = board();
    const target = place(state, creature('Hexy', { hexproof: true }), 'B');
    expect(isLegalTarget(state, 'creature', target, 'B')).toBe(true);
  });

  it('is untargetable when the caster is unknown', () => {
    // Guessing the other way would let an opponent's spell through a protection
    // the card really has.
    const state = board();
    const target = place(state, creature('Hexy', { hexproof: true }), 'B');
    expect(isLegalTarget(state, 'creature', target)).toBe(false);
  });

  it('is left out of the offered target menu for an opponent', () => {
    const state = board();
    const hexy = place(state, creature('Hexy', { hexproof: true }), 'B');
    const plain = place(state, creature('Plain'), 'B');

    const offered = legalTargetsFor(state, 'creature', 'A');
    expect(offered).toContain(plain);
    expect(offered).not.toContain(hexy);
  });
});

describe('shroud — protected from everyone', () => {
  it('blocks even its own controller', () => {
    const state = board();
    const target = place(state, creature('Shrouded', { shroud: true }), 'B');
    expect(isLegalTarget(state, 'creature', target, 'B')).toBe(false);
    expect(isLegalTarget(state, 'creature', target, 'A')).toBe(false);
  });
});

describe('an ordinary creature is unaffected', () => {
  it('remains targetable by both seats', () => {
    const state = board();
    const target = place(state, creature('Plain'), 'B');
    expect(isLegalTarget(state, 'creature', target, 'A')).toBe(true);
    expect(isLegalTarget(state, 'creature', target, 'B')).toBe(true);
  });
});
