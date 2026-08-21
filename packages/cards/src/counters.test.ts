/**
 * COUNTERS — the two standard kinds, as real state.
 *
 * `-1/-1` used to be stored as a NEGATIVE `+1/+1`, because the stat layer read
 * exactly one key. The arithmetic came out right, which is what made it survive:
 * nothing could ask "does this have a -1/-1 counter on it?", and a permanent
 * given both kinds never annihilated them (CR 704.5q) because a single signed
 * number pre-collapsed the pair.
 *
 * These pin that both kinds exist independently, that they still produce the
 * right P/T, and that they annihilate — plus the three printed templates the
 * compiler could not previously reach at all (targeted -1/-1, counters on ~
 * itself, and "enters with counters").
 */
import { describe, expect, it } from 'vitest';
import {
  checkStateBasedActions,
  createGame,
  effectivePower,
  effectiveToughness,
  MINUS_ONE_COUNTER,
  PLUS_ONE_COUNTER,
  type CardDefinition,
  type CardInstance,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import { buildRegistry, loadCardPool } from './pool.js';
import { compileCard } from './compile/index.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

/** A 2/2 on the battlefield we can put counters on. */
function bear(state: GameState): CardInstance {
  const def: CardDefinition = { id: 'Bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2 };
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller: 'A',
    owner: 'A',
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.battlefield.push(inst);
  return inst;
}

function freshState(): GameState {
  const forest = pool.getByName('Forest')!;
  return createGame({
    seed: 3,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => forest) },
      B: { cards: Array.from({ length: 40 }, () => forest) },
    },
    registry,
  }).state;
}

/** Run one primitive against a target, the way a resolving spell would. */
function applyPrimitive(
  state: GameState,
  source: CardInstance,
  primitive: string,
  params: Record<string, unknown>,
  targets: readonly number[] = [],
): void {
  const fn = registry.get(primitive);
  if (!fn) throw new Error(`no primitive "${primitive}"`);
  fn({
    state,
    source,
    controller: 'A' as PlayerId,
    params,
    targets: [...targets],
    emit: () => {},
    addContinuousEffect: () => {},
  } as never);
}

describe('the two standard counter kinds are real, independent state', () => {
  it('a +1/+1 counter raises power and toughness', () => {
    const state = freshState();
    const creature = bear(state);
    applyPrimitive(state, creature, 'addCounters', { amount: 2, self: true });

    expect(creature.counters[PLUS_ONE_COUNTER]).toBe(2);
    expect(effectivePower(creature)).toBe(4);
    expect(effectiveToughness(creature)).toBe(4);
  });

  it('a -1/-1 counter is stored as its OWN kind, not a negative +1/+1', () => {
    const state = freshState();
    const creature = bear(state);
    applyPrimitive(state, creature, 'addCounters', { amount: -1, self: true });

    // The regression: this used to read `{'+1/+1': -1}`, so nothing could ask
    // whether the creature had a -1/-1 counter on it.
    expect(creature.counters[MINUS_ONE_COUNTER]).toBe(1);
    expect(creature.counters[PLUS_ONE_COUNTER] ?? 0).toBe(0);
    expect(effectivePower(creature)).toBe(1);
    expect(effectiveToughness(creature)).toBe(1);
  });

  it('the two kinds ANNIHILATE in pairs (CR 704.5q) — as a STATE-BASED ACTION', () => {
    const state = freshState();
    const creature = bear(state);
    applyPrimitive(state, creature, 'addCounters', { amount: 3, self: true });
    applyPrimitive(state, creature, 'addCounters', { amount: -2, self: true });

    // Both kinds sit there until the game looks. CR 704.5q is a state-based
    // action, not part of putting a counter on something — which is why the
    // annihilation moved OUT of the counters primitive and into the SBA pass:
    // there it reaches every route a counter can arrive by, not just this one.
    expect(creature.counters[PLUS_ONE_COUNTER]).toBe(3);
    expect(creature.counters[MINUS_ONE_COUNTER]).toBe(2);

    checkStateBasedActions(state, () => {});

    // One +1/+1 survives; no -1/-1 remains sitting alongside it.
    expect(creature.counters[PLUS_ONE_COUNTER]).toBe(1);
    expect(creature.counters[MINUS_ONE_COUNTER]).toBe(0);
    expect(effectivePower(creature)).toBe(3);
  });

  it('annihilates counters that arrived by a route the primitive never touched', () => {
    // The whole reason CR 704.5q belongs to the state-based actions. This
    // permanent is handed both kinds directly — as persist, a token created
    // with counters, or any future producer would — and the rule still applies.
    const state = freshState();
    const creature = bear(state);
    creature.counters = { [PLUS_ONE_COUNTER]: 5, [MINUS_ONE_COUNTER]: 2 };

    checkStateBasedActions(state, () => {});

    expect(creature.counters[PLUS_ONE_COUNTER]).toBe(3);
    expect(creature.counters[MINUS_ONE_COUNTER]).toBe(0);
    // The arithmetic never moved — a 2/2 at +3 net before and after.
    expect(effectivePower(creature)).toBe(5);
  });

  it('counters accumulate across several applications', () => {
    const state = freshState();
    const creature = bear(state);
    applyPrimitive(state, creature, 'addCounters', { amount: 1, self: true });
    applyPrimitive(state, creature, 'addCounters', { amount: 1, self: true });
    expect(effectivePower(creature)).toBe(4);
  });
});

describe('printed counter templates the compiler can now reach', () => {
  /** Compile a card from its printed text alone. */
  function compileText(name: string, oracleText: string, type = 'Instant') {
    return compileCard({
      id: name,
      name,
      manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
      cmc: 1,
      typeLine: { supertypes: [], types: [type], subtypes: [] },
      rawTypeLine: type,
      oracleText,
      power: type === 'Creature' ? 2 : null,
      toughness: type === 'Creature' ? 2 : null,
      colors: [],
      colorIdentity: [],
      keywords: [],
      set: 'tst',
      collectorNumber: '1',
      rarity: 'common',
      imageUris: {},
      localImages: {},
      isDoubleFaced: false,
      faces: [],
    } as never);
  }

  it('compiles "Put a -1/-1 counter on target creature"', () => {
    const result = compileText('Shrink', 'Put a -1/-1 counter on target creature.');
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const ref = result.definition.effects?.[0];
    expect(ref?.primitive).toBe('addCounters');
    expect(ref?.params?.amount).toBe(-1);
  });

  it('compiles "Put two -1/-1 counters on target creature"', () => {
    const result = compileText('Disfigure', 'Put two -1/-1 counters on target creature.');
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    expect(result.definition.effects?.[0]?.params?.amount).toBe(-2);
  });

  it('compiles the SELF form as a trigger payload (no target)', () => {
    const result = compileText('Grower', 'Whenever ~ attacks, put a +1/+1 counter on ~.', 'Creature');
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    const ref = result.definition.triggers?.[0]?.effects[0];
    expect(ref?.primitive).toBe('addCounters');
    expect(ref?.params?.self).toBe(true);
  });

  it('compiles "enters with N +1/+1 counters" into the permanent’s ETB script', () => {
    const result = compileText('Arriver', '~ enters the battlefield with two +1/+1 counters on it.', 'Creature');
    expect(result.status, JSON.stringify(result.missing)).toBe('complete');
    // For a PERMANENT, `definition.effects` is the enters-the-battlefield script
    // — no separate trigger is needed, so the counters land there.
    const ref = result.definition.effects?.[0];
    expect(ref?.primitive).toBe('addCounters');
    expect(ref?.params?.amount).toBe(2);
    expect(ref?.params?.self).toBe(true);
  });

  it('still refuses a counter kind the stat layer does not read', () => {
    // A charge counter would be stored and read by nothing — a card that looks
    // implemented and does nothing. It must keep reporting as unsupported.
    const result = compileText('Charger', 'Put a charge counter on ~.', 'Instant');
    expect(result.status).toBe('incomplete');
  });
});


