/**
 * A REAL targeted trigger, from printed Oracle text to a resolved board.
 *
 * The compiler half and the engine half each look right on their own and can
 * still fail to meet: a trigger can compile with the effects but WITHOUT the
 * restriction that says what to aim it at, and it then resolves pointing at
 * nothing — a creature whose printed removal is silently blank. So this walks one
 * card the whole way: Oracle text → `TriggeredAbility.targets` → a question the
 * pilot answers → damage on the creature that was chosen.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  GameAction,
  GameState,
  InstanceId,
  PlayerId,
  SelectTargetsChoice,
} from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, dumpState } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEED = 909;
const DECK_SIZE = 40;
/** The fixture's printed damage — asserted on the board, so it is named once. */
const ETB_DAMAGE = 2;

/** Flametongue-shaped: an ETB that deals damage to a creature it must choose. */
const FLAMETONGUE: CardDefinition = compileCard({
  id: 'test:Flametongue Kavu',
  name: 'Flametongue Kavu',
  typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Kavu'] },
  manaCost: { generic: 3, W: 0, U: 0, B: 0, R: 1, G: 0, C: 0, other: [] },
  oracleText: 'When Flametongue Kavu enters, Flametongue Kavu deals 2 damage to target creature.',
  power: 4,
  toughness: 2,
  keywords: [],
} satisfies CompilableCard).definition;

function poolCard(name: string): CardDefinition {
  const card = CARD_POOL.find((c) => c.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const ISLAND = poolCard('Island');

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

/** A game at A's first main phase with both hands cleared. */
function gameAtMain(reg: Registry): GameState {
  const { state } = createGame({
    seed: SEED,
    startingPlayer: 'A',
    registry: reg,
    decks: {
      A: { cards: Array.from({ length: DECK_SIZE }, () => ISLAND) },
      B: { cards: Array.from({ length: DECK_SIZE }, () => ISLAND) },
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

describe('Flametongue Kavu, compiled from its printed text', () => {
  it('carries the restriction on the ABILITY, not only in its effects', () => {
    // The effects alone would resolve at nothing: it is the ability's `targets`
    // that makes the engine stop and aim it.
    expect(FLAMETONGUE.triggers).toHaveLength(1);
    expect(FLAMETONGUE.triggers![0]!.targets).toBe('creature');
  });

  it('asks which creature, then deals its damage to exactly that one', () => {
    const reg = buildRegistry(CARD_POOL);
    let state = gameAtMain(reg);
    const kavu = instance(FLAMETONGUE, 'A', 'hand');
    state.players.A.hand = [kavu];
    state.players.A.manaPool = { W: 0, U: 0, B: 0, R: 5, G: 0, C: 0 };
    const bear = instance(poolCard('Grizzly Bears'), 'B', 'battlefield');
    const wall = instance(poolCard('Wall of Omens'), 'B', 'battlefield');
    state.battlefield.push(bear, wall);

    state = act(state, { kind: 'castSpell', player: 'A', instanceId: kavu.instanceId }, reg);
    state = pass(state, reg);
    state = pass(state, reg); // the Kavu resolves, its ETB goes on the stack…

    const choice = state.pendingChoice as SelectTargetsChoice | null;
    expect(choice?.kind).toBe('selectTargets');
    expect(choice?.chooser).toBe('A');
    // Every creature on the board is a legal target, including the Kavu itself.
    expect(choice?.candidates.map((c) => c.name).sort()).toEqual([
      'Flametongue Kavu',
      'Grizzly Bears',
      'Wall of Omens',
    ]);

    state = answer(state, reg, { kind: 'selectTargets', targets: [wall.instanceId] });
    state = pass(state, reg);
    state = pass(state, reg);

    const damageOn = (id: InstanceId): number =>
      state.battlefield.find((c) => c.instanceId === id)?.damageMarked ?? 0;
    expect(damageOn(wall.instanceId)).toBe(ETB_DAMAGE);
    expect(damageOn(bear.instanceId)).toBe(0);
    expect(state.stack).toHaveLength(0);
  });
});
