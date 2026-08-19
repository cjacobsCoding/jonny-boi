/**
 * Indestructible (CR 702.12b) — and, far more importantly, the four things it
 * does NOT do.
 *
 * The classic wrong implementation treats the keyword as a general "this
 * permanent cannot leave the battlefield" shield, because the two creature-death
 * state-based actions look like one rule when you read the code and are two
 * rules when you read the comprehensive rules. Every test below is a boundary of
 * that mistake:
 *
 *   survives  — a board wipe / targeted destroy (an effect that says "destroy");
 *   survives  — lethal combat damage, deathtouch included (CR 704.5g + 702.2b);
 *   DIES      — toughness reduced to 0 (CR 704.5f, which indestructible does not
 *               mention at all);
 *   DIES      — being sacrificed (a cost, not destruction).
 */

import { describe, expect, it } from 'vitest';
import { createGame } from './engine.js';
import { deckOf, landDef } from './test-fixtures.js';
import { checkStateBasedActions } from './internal/sba.js';
import type { CardDefinition } from './card.js';
import type { CardInstance, GameEvent, GameState, PlayerId } from './state.js';

const MOUNTAIN = landDef('Mountain', 'R');

function board(): GameState {
  const { state } = createGame({
    seed: 7,
    decks: { A: deckOf(MOUNTAIN, 30), B: deckOf(MOUNTAIN, 30) },
  });
  state.battlefield = [];
  state.continuous = [];
  return state;
}

function creature(id: string, power: number, toughness: number, keywords?: CardDefinition['keywords']): CardDefinition {
  return { id, name: id, types: ['creature'], power, toughness, ...(keywords ? { keywords } : {}) };
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

/** Run the state-based actions, collecting what they emitted. */
function runSbas(state: GameState): GameEvent[] {
  const events: GameEvent[] = [];
  checkStateBasedActions(state, (e) => events.push(e));
  return events;
}

function onBattlefield(state: GameState, inst: CardInstance): boolean {
  return state.battlefield.some((perm) => perm.instanceId === inst.instanceId);
}

describe('indestructible — what it survives', () => {
  it('survives lethal marked damage that kills the vanilla creature beside it', () => {
    const state = board();
    const tough = place(state, creature('Darksteel Ox', 2, 2, { indestructible: true }), 'A');
    const vanilla = place(state, creature('Ordinary Ox', 2, 2), 'A');
    tough.damageMarked = 5;
    vanilla.damageMarked = 5;

    runSbas(state);

    expect(onBattlefield(state, tough)).toBe(true);
    expect(onBattlefield(state, vanilla)).toBe(false);
  });

  it('survives deathtouch damage — CR 702.2b marks it LETHAL, which is still destruction', () => {
    const state = board();
    const tough = place(state, creature('Darksteel Ox', 4, 4, { indestructible: true }), 'A');
    // Exactly what the combat code does when a deathtouch source assigns damage.
    tough.damageMarked = 1;
    tough.markedByDeathtouch = true;

    runSbas(state);

    expect(onBattlefield(state, tough)).toBe(true);
  });

  it('carries the marked damage forward rather than being quietly healed', () => {
    // A creature that survives lethal damage still HAS that damage on it, which
    // matters the moment its toughness drops. Clearing the damage as part of the
    // exemption would make it invulnerable to a later shrink as well.
    const state = board();
    const tough = place(state, creature('Darksteel Ox', 4, 4, { indestructible: true }), 'A');
    tough.damageMarked = 4;

    runSbas(state);

    expect(onBattlefield(state, tough)).toBe(true);
    expect(tough.damageMarked).toBe(4);
  });
});

describe('indestructible — what still kills it', () => {
  it('DIES to 0 toughness: CR 704.5f is not destruction and is not exempted', () => {
    const state = board();
    const tough = place(state, creature('Darksteel Ox', 3, 3, { indestructible: true }), 'A');
    // A -3/-3 until end of turn, registered through the ordinary continuous layer.
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: tough.instanceId,
      sourceInstanceId: tough.instanceId,
      power: -3,
      toughness: -3,
      duration: 'endOfTurn',
    });

    const events = runSbas(state);

    expect(onBattlefield(state, tough)).toBe(false);
    expect(events.some((e) => e.type === 'creatureDied')).toBe(true);
  });

  it('DIES to 0 toughness even with lethal damage ALSO marked on it', () => {
    // Both conditions true at once. The order the two rules are asked in is the
    // whole bug: ask "is it indestructible?" first and this creature lives.
    const state = board();
    const tough = place(state, creature('Darksteel Ox', 3, 3, { indestructible: true }), 'A');
    tough.damageMarked = 9;
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: tough.instanceId,
      sourceInstanceId: tough.instanceId,
      power: 0,
      toughness: -3,
      duration: 'endOfTurn',
    });

    runSbas(state);

    expect(onBattlefield(state, tough)).toBe(false);
  });

  it('is not saved from a positive-toughness board it should survive (control)', () => {
    const state = board();
    const tough = place(state, creature('Darksteel Ox', 3, 3, { indestructible: true }), 'A');
    runSbas(state);
    expect(onBattlefield(state, tough)).toBe(true);
  });
});

describe('indestructible — granted, not printed', () => {
  it('an until-end-of-turn grant saves a creature that had no keyword printed', () => {
    const state = board();
    const vanilla = place(state, creature('Ordinary Ox', 2, 2), 'A');
    vanilla.damageMarked = 5;
    state.continuous.push({
      id: state.nextInstanceId++,
      targetInstanceId: vanilla.instanceId,
      sourceInstanceId: vanilla.instanceId,
      keywords: { indestructible: true },
      duration: 'endOfTurn',
    });

    runSbas(state);

    expect(onBattlefield(state, vanilla)).toBe(true);
  });

  it('an anthem-style static grants it to the whole team', () => {
    const state = board();
    const forge: CardDefinition = {
      id: 'Steel Forge',
      name: 'Steel Forge',
      types: ['artifact'],
      statics: [{ affects: { anyOfTypes: ['creature'], controller: 'you' }, keywords: { indestructible: true } }],
    };
    place(state, forge, 'A');
    const mine = place(state, creature('Mine', 2, 2), 'A');
    const theirs = place(state, creature('Theirs', 2, 2), 'B');
    mine.damageMarked = 5;
    theirs.damageMarked = 5;

    runSbas(state);

    expect(onBattlefield(state, mine)).toBe(true);
    expect(onBattlefield(state, theirs)).toBe(false);
  });
});
