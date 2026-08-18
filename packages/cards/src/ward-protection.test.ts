/**
 * WARD and PROTECTION, end to end: real Oracle text → the compiler → a real game.
 *
 * Ward's contract: targeting an OPPONENT's warded permanent raises the
 * pay-or-counter question through the same optional-payment machinery Mana Leak
 * uses — the engine charges the mana, a player who cannot pay is never asked,
 * and a decline counters the spell (or removes the targeting ability from the
 * stack). Own-controller targeting never triggers it.
 *
 * Protection's contract at this level: the halves that need real primitives —
 * a targeted burn spell fizzling on a protected creature, an untargeted sweep
 * prevented per creature — behave as printed with the real registry, and the
 * grant template compiles to the continuous layer.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  GameAction,
  GameState,
  PlayerId,
} from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, dumpState, poolTotal } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import { explainUnsupported } from './compile/rules.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEED = 6161;
const DECK_SIZE = 40;

function makeCard(overrides: Partial<CompilableCard> & { name: string }): CompilableCard {
  return {
    id: `test:${overrides.name}`,
    manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: [], subtypes: [] },
    oracleText: '',
    power: null,
    toughness: null,
    keywords: [],
    ...overrides,
  };
}

/** A compiled 2/2 with `Ward {2}` — the definition the whole file plays with. */
const WARDED = compileCard(
  makeCard({
    name: 'Warded Bear',
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Bear'] },
    manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 1, C: 0, other: [] },
    power: 2,
    toughness: 2,
    oracleText: 'Ward {2}',
    keywords: ['Ward'],
  }),
).definition;

function poolCard(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const BOLT = poolCard('Lightning Bolt');
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

let syntheticId = 80_000;

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

/** A fresh game paused at A's precombat main with empty hands. */
function openGame(): { state: GameState; reg: Registry } {
  const reg = buildRegistry();
  const { state: created } = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: {
      A: { cards: Array.from({ length: DECK_SIZE }, () => MOUNTAIN) },
      B: { cards: Array.from({ length: DECK_SIZE }, () => MOUNTAIN) },
    },
  });
  let state = created;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  state.players.A.hand = [];
  state.players.B.hand = [];
  return { state, reg };
}

/**
 * A cast their Bolt at B's warded bear and both players passed, so the ward
 * trigger has resolved as far as it can: with `mana` covering {2} A is being
 * asked; with less the question was settled as an automatic decline.
 */
function wardGame(mana: number): { state: GameState; reg: Registry; bolt: CardInstance; bear: CardInstance } {
  const { state, reg } = openGame();
  const bolt = instance(BOLT, 'A', 'hand');
  state.players.A.hand = [bolt];
  const bear = instance(WARDED, 'B', 'battlefield');
  state.battlefield.push(bear);
  // {R} floats for the Bolt itself; `mana` more covers (or fails to cover) the ward.
  state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 1 + mana, G: 0, C: 0 };
  let next = act(state, { kind: 'castSpell', player: 'A', instanceId: bolt.instanceId, targets: [bear.instanceId] }, reg);
  next = pass(next, reg);
  next = pass(next, reg); // the ward trigger (top of stack) resolves and asks
  return { state: next, reg, bolt, bear };
}

describe('the compiler half', () => {
  it('compiles Ward {2} to the keyword the engine enforces', () => {
    expect(WARDED.keywords).toMatchObject({ ward: 2 });
  });

  it('compiles the protection grant template to the continuous layer', () => {
    const result = compileCard(
      makeCard({
        name: 'Ward Off Red',
        typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
        manaCost: { generic: 0, W: 1, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
        oracleText: 'Target creature gains protection from red until end of turn.',
      }),
    );
    expect(result.status).toBe('complete');
    expect(result.definition.effects).toEqual([
      {
        primitive: 'grantKeywordUntilEndOfTurn',
        params: { keywords: { protectionFrom: ['red'] }, targets: 'creature' },
      },
    ]);
  });

  it('no longer advertises ward/protection as a MISSING system', () => {
    expect(explainUnsupported('ward {2}')).toBe('a ward/protection template the compiler does not recognize yet');
    expect(explainUnsupported('protection from red')).toBe(
      'a ward/protection template the compiler does not recognize yet',
    );
  });
});

describe('ward in a real game — the spell case', () => {
  it('asks the targeting opponent to pay, and PAYING lets the spell resolve', () => {
    const { state, reg, bear } = wardGame(2);
    const choice = state.pendingChoice;
    expect(choice?.kind).toBe('payMana');
    expect(choice?.chooser).toBe('A');
    const poolBefore = poolTotal(state.players.A.manaPool);

    let next = act(
      state,
      {
        kind: 'answerChoice',
        player: 'A',
        choiceId: choice!.id,
        answer: { kind: 'payMana', pay: true } as ChoiceAnswer,
      },
      reg,
    );
    // The engine took the {2} as it accepted the answer.
    expect(poolTotal(next.players.A.manaPool)).toBe(poolBefore - 2);
    // The Bolt survived the ward and now resolves as printed.
    next = pass(next, reg);
    next = pass(next, reg);
    const bearAfter = next.battlefield.find((c) => c.instanceId === bear.instanceId);
    expect(bearAfter).toBeUndefined(); // 3 damage killed the 2/2 via SBAs
  });

  it('DECLINING counters the spell: it goes to the graveyard and the creature is untouched', () => {
    const { state, reg, bolt, bear } = wardGame(2);
    const choice = state.pendingChoice;
    expect(choice?.kind).toBe('payMana');

    const next = act(
      state,
      {
        kind: 'answerChoice',
        player: 'A',
        choiceId: choice!.id,
        answer: { kind: 'payMana', pay: false } as ChoiceAnswer,
      },
      reg,
    );
    expect(next.players.A.graveyard.some((c) => c.instanceId === bolt.instanceId)).toBe(true);
    expect(next.stack).toHaveLength(0);
    const bearAfter = next.battlefield.find((c) => c.instanceId === bear.instanceId);
    expect(bearAfter?.damageMarked).toBe(0);
  });

  it('a caster who CANNOT pay is never asked — the spell is countered automatically', () => {
    const { state, bolt, bear } = wardGame(0);
    expect(state.pendingChoice).toBeNull();
    expect(state.players.A.graveyard.some((c) => c.instanceId === bolt.instanceId)).toBe(true);
    const bearAfter = state.battlefield.find((c) => c.instanceId === bear.instanceId);
    expect(bearAfter?.damageMarked).toBe(0);
  });

  it('does NOT trigger when the warded permanent\'s own controller targets it', () => {
    const { state, reg } = openGame();
    // Hand the bear and the bolt to the SAME player.
    const bolt = instance(BOLT, 'A', 'hand');
    state.players.A.hand = [bolt];
    const bear = instance(WARDED, 'A', 'battlefield');
    state.battlefield.push(bear);
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };
    const next = act(
      state,
      { kind: 'castSpell', player: 'A', instanceId: bolt.instanceId, targets: [bear.instanceId] },
      reg,
    );
    // Only the Bolt is on the stack — no ward trigger above it.
    expect(next.stack).toHaveLength(1);
    expect(next.stack[0]?.kind).toBe('spell');
  });
});

describe('ward in a real game — the ability case', () => {
  /** A permanent whose free activated ability pings a target creature. */
  const PINGER: CardDefinition = {
    id: 'test:Pinger',
    name: 'Pinger',
    types: ['creature'],
    power: 1,
    toughness: 1,
    activated: [
      {
        cost: {},
        effects: [{ primitive: 'dealDamage', params: { amount: 1, targets: 'creature' } }],
        label: 'Ping',
      },
    ],
  };

  it('an activated ability aimed at a warded creature triggers ward; declining counters the ability', () => {
    const { state, reg } = openGame();
    const pinger = instance(PINGER, 'A', 'battlefield');
    state.battlefield.push(pinger);
    const bear = instance(WARDED, 'B', 'battlefield');
    state.battlefield.push(bear);
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 5, G: 0, C: 0 };

    let next = act(
      state,
      { kind: 'activateAbility', player: 'A', instanceId: pinger.instanceId, abilityIndex: 0, targets: [bear.instanceId] },
      reg,
    );
    expect(next.stack).toHaveLength(2); // the ability + the ward trigger above it
    next = pass(next, reg);
    next = pass(next, reg); // ward resolves and asks
    const choice = next.pendingChoice;
    expect(choice?.kind).toBe('payMana');
    next = act(
      next,
      {
        kind: 'answerChoice',
        player: 'A',
        choiceId: choice!.id,
        answer: { kind: 'payMana', pay: false } as ChoiceAnswer,
      },
      reg,
    );
    // The ability was countered: the stack is empty and the bear took nothing.
    expect(next.stack).toHaveLength(0);
    const bearAfter = next.battlefield.find((c) => c.instanceId === bear.instanceId);
    expect(bearAfter?.damageMarked).toBe(0);
  });
});

describe('protection in a real game', () => {
  const PRO_RED: CardDefinition = {
    id: 'test:ProRed',
    name: 'Pro Red Knight',
    types: ['creature'],
    power: 2,
    toughness: 2,
    cost: { W: 1 },
    keywords: { protectionFrom: ['red'] },
  };

  it('a resolved red burn spell FIZZLES on a protection-from-red creature', () => {
    const { state, reg } = openGame();
    const bolt = instance(BOLT, 'A', 'hand');
    state.players.A.hand = [bolt];
    const knight = instance(PRO_RED, 'B', 'battlefield');
    state.battlefield.push(knight);
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };
    // Bolt is "any target", which core deliberately does not police at cast —
    // the primitive's own re-check is what protects the creature at resolution.
    let next = act(state, { kind: 'castSpell', player: 'A', instanceId: bolt.instanceId, targets: [knight.instanceId] }, reg);
    next = pass(next, reg);
    next = pass(next, reg); // the Bolt resolves — onto a protected target
    const knightAfter = next.battlefield.find((c) => c.instanceId === knight.instanceId);
    expect(knightAfter?.damageMarked).toBe(0);
    expect(next.players.A.graveyard.some((c) => c.instanceId === bolt.instanceId)).toBe(true);
  });

  it('an untargeted red sweep is PREVENTED on the protected creature and dealt to the rest', () => {
    const { state, reg } = openGame();
    const sweep: CardDefinition = {
      id: 'test:Sweep',
      name: 'Red Sweep',
      types: ['sorcery'],
      cost: { R: 1 },
      effects: [{ primitive: 'dealDamageToEach', params: { amount: 2, creatures: true } }],
    };
    const spell = instance(sweep, 'A', 'hand');
    state.players.A.hand = [spell];
    const knight = instance(PRO_RED, 'B', 'battlefield');
    const bystander = instance(
      { id: 'test:Bear', name: 'Plain Bear', types: ['creature'], power: 2, toughness: 3, cost: { G: 2 } },
      'B',
      'battlefield',
    );
    state.battlefield.push(knight, bystander);
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };

    let next = act(state, { kind: 'castSpell', player: 'A', instanceId: spell.instanceId }, reg);
    let prevented = 0;
    // Resolve by passing; collect events from the applyAction results.
    for (let i = 0; i < 2; i++) {
      const result = applyAction(next, { kind: 'passPriority', player: next.priorityPlayer }, DEFAULT_RULES, reg);
      for (const e of result.events) if (e.type === 'damagePrevented') prevented += e.amount;
      next = result.state;
    }
    const knightAfter = next.battlefield.find((c) => c.instanceId === knight.instanceId);
    const bystanderAfter = next.battlefield.find((c) => c.instanceId === bystander.instanceId);
    expect(knightAfter?.damageMarked).toBe(0);
    expect(bystanderAfter?.damageMarked).toBe(2);
    expect(prevented).toBe(2);
  });
});
