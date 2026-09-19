/**
 * THE SELF KEYWORD GRANT, PLAYED (DESIGN §3.171) — Unyielding Krumar's "{1}{W}:
 * Unyielding Krumar gains first strike until end of turn" and Stream Hopper's
 * "{U/R}: Stream Hopper gains flying until end of turn", compiled from their
 * printed text and run through the real engine:
 *  - the activation is offered, the mana is charged, and after resolution the
 *    creature HAS the keyword — read through the same continuous layer combat
 *    reads — with no target ever asked for;
 *  - the grant is gone on the controller's next turn (cleanup expiry);
 *  - a hybrid activation cost is payable with EITHER colour, and with neither
 *    it is not offered.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  defaultAnswerFor,
  effectiveKeywords,
  generateLegalActions,
  indexContinuous,
} from '@jonny-boi/core';
import { compileCard } from './compile/index.js';
import type { CompilableCard } from './compile/index.js';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;
const SEED = 41171;
const NO_MANA = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] } as const;

function fromPool(name: string): CardDefinition {
  const found = CARD_POOL.find((entry) => entry.name === name);
  if (!found) throw new Error(`pool missing ${name}`);
  return found;
}

function printed(name: string, manaCost: Partial<typeof NO_MANA>, oracleText: string): CardDefinition {
  const result = compileCard({
    id: `test:${name}`,
    name,
    manaCost: { ...NO_MANA, ...manaCost },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Test'] },
    power: 2,
    toughness: 2,
    keywords: [],
    oracleText,
  } as CompilableCard);
  if (result.status !== 'complete') throw new Error(`${name}: ${JSON.stringify(result.missing)}`);
  return result.definition;
}

/** Unyielding Krumar — real printed text (corpus 2026-09-19). */
const KRUMAR = printed(
  'Unyielding Krumar',
  { generic: 3, B: 1 },
  '{1}{W}: Unyielding Krumar gains first strike until end of turn.',
);
/** Stream Hopper — real printed text. */
const HOPPER = printed('Stream Hopper', { generic: 1, U: 1 }, '{U/R}: Stream Hopper gains flying until end of turn.');

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected') as
    | { reason?: string }
    | undefined;
  if (rejected) throw new Error(`unexpected rejection: ${rejected.reason ?? '?'}`);
  return result.state;
}

function rejection(state: GameState, action: GameAction, reg: Registry): string | undefined {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  return (result.events.find((e) => e.type === 'actionRejected') as { reason?: string } | undefined)
    ?.reason;
}

type Question = NonNullable<GameState['pendingChoice']>;

function settle(state: GameState, reg: Registry): GameState {
  let s = state;
  let guard = 0;
  while ((s.stack.length > 0 || s.pendingChoice != null) && guard++ < 80) {
    const question: Question | null | undefined = s.pendingChoice;
    s = question
      ? act(
          s,
          {
            kind: 'answerChoice',
            player: question.chooser,
            choiceId: question.id,
            answer: defaultAnswerFor(question),
          } as GameAction,
          reg,
        )
      : act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
  }
  return s;
}

function toMain(reg: Registry): GameState {
  const forest = fromPool('Forest');
  const { state } = createGame({
    seed: SEED,
    decks: {
      A: { cards: Array.from({ length: 60 }, () => forest) },
      B: { cards: Array.from({ length: 60 }, () => forest) },
    },
    registry: reg,
  });
  let s = state;
  let guard = 0;
  while (
    (s.step !== 'precombatMain' ||
      s.priorityPlayer !== 'A' ||
      s.stack.length > 0 ||
      s.pendingChoice) &&
    guard++ < 600
  ) {
    s = settle(s, reg);
    if (s.stack.length === 0 && s.pendingChoice == null)
      s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
  }
  return s;
}

/** Pass priority until it is the given player's next turn (the once-each-turn test's walk). */
function toNextTurnOf(state: GameState, reg: Registry, player: PlayerId): GameState {
  const startTurn = state.turnNumber;
  let s = state;
  for (let guard = 0; guard < 400; guard++) {
    if (
      s.turnNumber > startTurn &&
      s.activePlayer === player &&
      s.step === 'precombatMain' &&
      s.stack.length === 0
    )
      return s;
    const legal = generateLegalActions(s);
    const next = legal.find((a) => a.kind === 'passPriority') ?? legal[0];
    if (!next) throw new Error('no legal action');
    s = applyAction(s, next, DEFAULT_RULES, reg).state;
  }
  throw new Error('never reached the next turn');
}

function put(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  (state.battlefield as unknown[]).push({
    instanceId: id,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  });
  return id;
}

const onBoard = (state: GameState, id: InstanceId) =>
  state.battlefield.find((c) => c.instanceId === id);

function keywordsOf(state: GameState, id: InstanceId) {
  const index = indexContinuous(state);
  return effectiveKeywords(onBoard(state, id)!, index.get(id) ?? undefined);
}

const activationsOffered = (state: GameState, id: InstanceId) =>
  generateLegalActions(state).filter(
    (a) => a.kind === 'activateAbility' && a.instanceId === id,
  ).length;

describe('Unyielding Krumar — "{1}{W}: ~ gains first strike until end of turn"', () => {
  it('is offered, charges the mana, grants the keyword with no target asked, and expires next turn', () => {
    const reg = buildRegistry();
    let s = toMain(reg);
    const krumar = put(s, KRUMAR, 'A');
    s.players.A.manaPool = { W: 1, U: 0, B: 0, R: 0, G: 1, C: 0 };

    expect(keywordsOf(s, krumar).firstStrike, 'printed without first strike').toBeFalsy();
    expect(activationsOffered(s, krumar)).toBe(1);

    s = act(s, { kind: 'activateAbility', player: 'A', instanceId: krumar, abilityIndex: 0 }, reg);
    expect(s.players.A.manaPool.W, 'the {W} was charged').toBe(0);
    expect(s.players.A.manaPool.G, 'the generic {1} took the green').toBe(0);
    expect(s.pendingChoice, 'a self grant never asks for a target').toBeNull();
    expect(s.stack).toHaveLength(1);

    s = settle(s, reg);
    expect(keywordsOf(s, krumar).firstStrike).toBe(true);

    // Nothing to pay with now, so the menu is empty — and the grant is still
    // there for the rest of this turn.
    expect(activationsOffered(s, krumar)).toBe(0);

    s = toNextTurnOf(s, reg, 'A');
    expect(onBoard(s, krumar), 'still on the battlefield').toBeDefined();
    expect(keywordsOf(s, krumar).firstStrike, 'an until-end-of-turn grant is gone by the next turn').toBeFalsy();
  });
});

describe('Stream Hopper — "{U/R}: ~ gains flying until end of turn" (hybrid activation cost)', () => {
  it('is payable with red alone, with blue alone, and not offered with neither', () => {
    const reg = buildRegistry();
    const base = toMain(reg);
    const hopper = put(base, HOPPER, 'A');
    const activate: GameAction = {
      kind: 'activateAbility',
      player: 'A',
      instanceId: hopper,
      abilityIndex: 0,
    };

    // Red only.
    base.players.A.manaPool = { W: 0, U: 0, B: 0, R: 1, G: 0, C: 0 };
    expect(activationsOffered(base, hopper)).toBe(1);
    let s = act(base, activate, reg);
    expect(s.players.A.manaPool.R).toBe(0);
    s = settle(s, reg);
    expect(keywordsOf(s, hopper).flying).toBe(true);

    // Blue only.
    base.players.A.manaPool = { W: 0, U: 1, B: 0, R: 0, G: 0, C: 0 };
    expect(activationsOffered(base, hopper)).toBe(1);
    s = act(base, activate, reg);
    expect(s.players.A.manaPool.U).toBe(0);

    // Green only: the hybrid symbol names neither colour.
    base.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 1, C: 0 };
    expect(activationsOffered(base, hopper)).toBe(0);
    expect(rejection(base, activate, reg)).toBeDefined();
  });
});
