/**
 * KAROO LANDS + ADDITIONAL LAND PLAYS — two of the corpus's most-repeated
 * missing clauses, closed together because they are both about the land drop.
 *
 * The karoo half ("when ~ enters, return a land you control to its owner's
 * hand") is a CHOICE, not a target: the printed line names no target, so the
 * permanent is picked as the trigger resolves — which is what lets it sit in a
 * trigger with no aiming step, and what makes bouncing the karoo ITSELF legal
 * (a real play when it is the only land). The additional-land half is one
 * number on the definition, read by ONE engine helper at both the offer and
 * the apply, so the menu can never offer a drop the engine then refuses.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  ChoiceAnswer,
  GameAction,
  GameState,
  PlayerId,
  SelectCardsChoice,
} from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, dumpState, generateLegalActions } from '@jonny-boi/core';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEED = 4400;
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

/** Dimir Aqueduct with its real printed text. */
const AQUEDUCT: CardDefinition = compileCard(
  makeCard({
    name: 'Dimir Aqueduct',
    typeLine: { supertypes: [], types: ['Land'], subtypes: [] },
    oracleText:
      'Dimir Aqueduct enters the battlefield tapped.\nWhen Dimir Aqueduct enters the battlefield, return a land you control to its owner’s hand.\n{T}: Add {U}{B}.',
  }),
).definition;

const EXPLORATION: CardDefinition = compileCard(
  makeCard({
    name: 'Exploration',
    typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
    oracleText: 'You may play an additional land on each of your turns.',
  }),
).definition;

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

let syntheticId = 95_000;

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

describe('a karoo land, compiled from its printed text and played', () => {
  it('compiles complete — tapped entry, the bounce trigger, and the two-mana tap', () => {
    expect(AQUEDUCT.entersTapped).toBe(true);
    expect(AQUEDUCT.triggers).toHaveLength(1);
    expect(AQUEDUCT.triggers?.[0]?.effects[0]?.primitive).toBe('returnChosenToHand');
    expect(AQUEDUCT.produces).toEqual(['U', 'B']);
  });

  it('asks which land to bounce — the karoo ITSELF is on the menu', () => {
    const reg = buildRegistry(CARD_POOL);
    let state = gameAtMain(reg);
    const island = instance(ISLAND, 'A', 'battlefield');
    state.battlefield.push(island);
    const karoo = instance(AQUEDUCT, 'A', 'hand');
    state.players.A.hand = [karoo];

    state = act(state, { kind: 'playLand', player: 'A', instanceId: karoo.instanceId }, reg);
    // The ETB trigger goes on the stack; both players pass so it resolves…
    state = pass(state, reg);
    state = pass(state, reg);

    const choice = state.pendingChoice as SelectCardsChoice | null;
    expect(choice?.kind).toBe('selectCards');
    expect(choice?.chooser).toBe('A');
    // Both lands — the printed "a land you control" includes the karoo.
    expect(choice?.candidates.map((c) => c.name).sort()).toEqual(['Dimir Aqueduct', 'Island']);
    expect(choice?.min).toBe(1);
    expect(choice?.max).toBe(1);
  });

  it('bounces the chosen land into its owner’s hand, and the karoo stays tapped', () => {
    const reg = buildRegistry(CARD_POOL);
    let state = gameAtMain(reg);
    const island = instance(ISLAND, 'A', 'battlefield');
    state.battlefield.push(island);
    const karoo = instance(AQUEDUCT, 'A', 'hand');
    state.players.A.hand = [karoo];

    state = act(state, { kind: 'playLand', player: 'A', instanceId: karoo.instanceId }, reg);
    state = pass(state, reg);
    state = pass(state, reg);
    state = answer(state, reg, { kind: 'selectCards', instanceIds: [island.instanceId] });

    expect(state.players.A.hand.map((c) => c.def.name)).toEqual(['Island']);
    const onField = state.battlefield.find((c) => c.instanceId === karoo.instanceId);
    expect(onField?.tapped).toBe(true);
    expect(state.stack).toHaveLength(0);
  });

  it('can bounce ITSELF — the choice is honoured, not second-guessed', () => {
    const reg = buildRegistry(CARD_POOL);
    let state = gameAtMain(reg);
    const karoo = instance(AQUEDUCT, 'A', 'hand');
    state.players.A.hand = [karoo];

    state = act(state, { kind: 'playLand', player: 'A', instanceId: karoo.instanceId }, reg);
    state = pass(state, reg);
    state = pass(state, reg);
    // The karoo is the only land, so the choice is trivial and the engine takes
    // it — the karoo returns to hand.
    expect(state.pendingChoice ?? null).toBeNull();
    expect(state.players.A.hand.map((c) => c.def.name)).toEqual(['Dimir Aqueduct']);
    expect(state.battlefield.find((c) => c.instanceId === karoo.instanceId)).toBeUndefined();
  });
});

describe('additional land plays', () => {
  it('compiles Exploration to one extra play (and the two-land wording to two)', () => {
    expect(EXPLORATION.additionalLandPlays).toBe(1);
    const azusa = compileCard(
      makeCard({
        name: 'Azusa-ish',
        typeLine: { supertypes: [], types: ['Enchantment'], subtypes: [] },
        oracleText: 'You may play two additional lands on each of your turns.',
      }),
    ).definition;
    expect(azusa.additionalLandPlays).toBe(2);
  });

  it('lets its controller play a second land — offered AND accepted', () => {
    const reg = buildRegistry(CARD_POOL);
    let state = gameAtMain(reg);
    state.battlefield.push(instance(EXPLORATION, 'A', 'battlefield'));
    const [one, two] = [instance(ISLAND, 'A', 'hand'), instance(ISLAND, 'A', 'hand')];
    state.players.A.hand = [one!, two!];

    state = act(state, { kind: 'playLand', player: 'A', instanceId: one!.instanceId }, reg);
    // The second drop is OFFERED…
    expect(generateLegalActions(state).some((a) => a.kind === 'playLand')).toBe(true);
    // …and ACCEPTED; a third is refused.
    state = act(state, { kind: 'playLand', player: 'A', instanceId: two!.instanceId }, reg);
    expect(generateLegalActions(state).some((a) => a.kind === 'playLand')).toBe(false);
  });

  it('grants NOTHING to the opponent — the printed line says "you"', () => {
    const reg = buildRegistry(CARD_POOL);
    let state = gameAtMain(reg);
    state.battlefield.push(instance(EXPLORATION, 'B', 'battlefield'));
    const [one, two] = [instance(ISLAND, 'A', 'hand'), instance(ISLAND, 'A', 'hand')];
    state.players.A.hand = [one!, two!];

    state = act(state, { kind: 'playLand', player: 'A', instanceId: one!.instanceId }, reg);
    expect(generateLegalActions(state).some((a) => a.kind === 'playLand')).toBe(false);
    void two;
  });
});
