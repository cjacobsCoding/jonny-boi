/**
 * {X} COSTS AND KICKER, from printed Oracle text to a resolved board.
 *
 * The compiler half (an `xCost`/`kicker` on the definition, `chosenX` /
 * `base`/`kicked` params on the effects) and the engine half (the cast-time
 * question, the charge, the value riding the resolution) each pass their own
 * tests and could still fail to meet — a compiled Blaze whose damage param the
 * primitives cannot read would burn for zero forever, silently. So this walks
 * real printed cards the whole way: Oracle text → cast → the question → the
 * payment → the resolved board.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  ChooseNumberChoice,
  GameAction,
  GameState,
  PayManaChoice,
  PlayerId,
} from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, dumpState } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEED = 1207;
const DECK_SIZE = 40;

/** Blaze, as printed: "{X}{R} · Blaze deals X damage to any target." */
const BLAZE: CardDefinition = compileCard({
  id: 'test:Blaze',
  name: 'Blaze',
  typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
  manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: ['X'] },
  oracleText: 'Blaze deals X damage to any target.',
  power: null,
  toughness: null,
  keywords: [],
} satisfies CompilableCard).definition;

/** Mind Spring, as printed: "{X}{U}{U} · Draw X cards." */
const MIND_SPRING_RESULT = compileCard({
  id: 'test:Mind Spring',
  name: 'Mind Spring',
  typeLine: { supertypes: [], types: ['Sorcery'], subtypes: [] },
  manaCost: { generic: 0, W: 0, U: 2, B: 0, R: 0, G: 0, C: 0, other: ['X'] },
  oracleText: 'Draw X cards.',
  power: null,
  toughness: null,
  keywords: [],
} satisfies CompilableCard);

/** Burst Lightning, as printed (kicked damage switches 2 → 4). */
const BURST_LIGHTNING: CardDefinition = compileCard({
  id: 'test:Burst Lightning',
  name: 'Burst Lightning',
  typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
  manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
  oracleText:
    'Kicker {4} (You may pay an additional {4} as you cast this spell.)\nBurst Lightning deals 2 damage to any target. If this spell was kicked, it deals 4 damage to that target instead.',
  power: null,
  toughness: null,
  keywords: ['Kicker'],
} satisfies CompilableCard).definition;

function poolCard(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const MOUNTAIN = poolCard('Mountain');

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}\n${dumpState(state)}`);
  return result.state;
}

function pass(state: GameState, reg: Registry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

let syntheticId = 90_000;

function instance(def: CardDefinition, player: PlayerId, zone: CardInstance['zone']): CardInstance {
  return {
    instanceId: syntheticId++,
    def,
    controller: player,
    owner: player,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
}

/** A game at A's first main phase with both hands cleared. */
function gameAtMain(reg: Registry): GameState {
  const { state } = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: {
      A: { cards: Array.from({ length: DECK_SIZE }, () => MOUNTAIN) },
      B: { cards: Array.from({ length: DECK_SIZE }, () => MOUNTAIN) },
    },
  });
  let s = state;
  let guard = 0;
  while (s.step !== 'precombatMain' && !s.gameOver && !s.pendingChoice && guard++ < 50) s = pass(s, reg);
  s.players.A.hand = [];
  s.players.B.hand = [];
  return s;
}

function answer(state: GameState, reg: Registry, value: ChoiceAnswer): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error(`no choice pending:\n${dumpState(state)}`);
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: value }, reg);
}

/** Put `count` untapped Mountains onto A's battlefield. */
function giveMountains(state: GameState, count: number): void {
  for (let i = 0; i < count; i++) state.battlefield.push(instance(MOUNTAIN, 'A', 'battlefield'));
}

describe('Blaze, compiled from its printed text', () => {
  it('compiled complete, with the X in the cost and the damage reading it', () => {
    expect(BLAZE.xCost).toBe(1);
    expect(BLAZE.cost).toEqual({ R: 1 });
    expect(BLAZE.effects).toEqual([{ primitive: 'dealDamage', params: { amount: { chosenX: true } } }]);
  });

  it('casts for X = 3: three extra Mountains pay for it and the face takes 3', () => {
    const reg = buildRegistry(CARD_POOL);
    let state = gameAtMain(reg);
    const blaze = instance(BLAZE, 'A', 'hand');
    state.players.A.hand = [blaze];
    // {R} floating for the base cost; four Mountains on the board for X.
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };
    giveMountains(state, 4);

    state = act(state, { kind: 'castSpell', player: 'A', instanceId: blaze.instanceId, targets: ['B'] }, reg);
    const choice = state.pendingChoice as ChooseNumberChoice;
    expect(choice.kind).toBe('chooseNumber');
    expect(choice.max).toBe(4);

    state = answer(state, reg, { kind: 'chooseNumber', value: 3 });
    state = pass(state, reg);
    state = pass(state, reg); // resolves

    expect(state.players.B.life).toBe(DEFAULT_RULES.startingLife - 3);
    expect(state.players.A.graveyard.map((c) => c.def.name)).toContain('Blaze');
    // Exactly three of the four Mountains were taken for X.
    expect(state.battlefield.filter((c) => c.controller === 'A' && !c.tapped)).toHaveLength(1);
  });

  it('casts for X = 0: a legal cast that deals nothing and taps nothing', () => {
    const reg = buildRegistry(CARD_POOL);
    let state = gameAtMain(reg);
    const blaze = instance(BLAZE, 'A', 'hand');
    state.players.A.hand = [blaze];
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };
    giveMountains(state, 2);

    state = act(state, { kind: 'castSpell', player: 'A', instanceId: blaze.instanceId, targets: ['B'] }, reg);
    state = answer(state, reg, { kind: 'chooseNumber', value: 0 });
    state = pass(state, reg);
    state = pass(state, reg);

    expect(state.players.B.life).toBe(DEFAULT_RULES.startingLife);
    expect(state.battlefield.filter((c) => c.controller === 'A' && !c.tapped)).toHaveLength(2);
  });
});

describe('Mind Spring, compiled from its printed text', () => {
  it('compiled complete and draws exactly the X that was paid for', () => {
    expect(MIND_SPRING_RESULT.status, JSON.stringify(MIND_SPRING_RESULT.missing)).toBe('complete');
    const def = MIND_SPRING_RESULT.definition;
    expect(def.xCost).toBe(1);
    expect(def.cost).toEqual({ U: 2 });

    const reg = buildRegistry(CARD_POOL);
    let state = gameAtMain(reg);
    const spring = instance(def, 'A', 'hand');
    state.players.A.hand = [spring];
    state.players.A.manaPool = { W: 0, U: 2, B: 0, R: 0, G: 0, C: 0 };
    giveMountains(state, 2);

    state = act(state, { kind: 'castSpell', player: 'A', instanceId: spring.instanceId }, reg);
    state = answer(state, reg, { kind: 'chooseNumber', value: 2 });
    state = pass(state, reg);
    state = pass(state, reg);

    expect(state.players.A.hand).toHaveLength(2); // drew X = 2
  });
});

describe('Burst Lightning, compiled from its printed text', () => {
  function castBurst(mountains: number): { state: GameState; reg: Registry } {
    const reg = buildRegistry(CARD_POOL);
    let state = gameAtMain(reg);
    const burst = instance(BURST_LIGHTNING, 'A', 'hand');
    state.players.A.hand = [burst];
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };
    giveMountains(state, mountains);
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: burst.instanceId, targets: ['B'] }, reg);
    return { state, reg };
  }

  it('kicked: pays {4} and deals 4', () => {
    const { state, reg } = castBurst(4);
    const choice = state.pendingChoice as PayManaChoice;
    expect(choice.kind).toBe('payMana');
    expect(choice.cost).toEqual({ generic: 4 });
    expect(choice.affordable).toBe(true);

    let done = answer(state, reg, { kind: 'payMana', pay: true });
    done = pass(done, reg);
    done = pass(done, reg);
    expect(done.players.B.life).toBe(DEFAULT_RULES.startingLife - 4);
  });

  it('unkicked by choice: deals 2 and taps nothing extra', () => {
    const { state, reg } = castBurst(4);
    let done = answer(state, reg, { kind: 'payMana', pay: false });
    done = pass(done, reg);
    done = pass(done, reg);
    expect(done.players.B.life).toBe(DEFAULT_RULES.startingLife - 2);
    expect(done.battlefield.filter((c) => c.controller === 'A' && !c.tapped)).toHaveLength(4);
  });

  it('unkicked by poverty: with {4} unaffordable the question is never asked', () => {
    const { state, reg } = castBurst(2);
    expect(state.pendingChoice ?? null).toBeNull();
    let done = pass(state, reg);
    done = pass(done, reg);
    expect(done.players.B.life).toBe(DEFAULT_RULES.startingLife - 2);
  });
});
