/**
 * "DISCARD A CARD" AS AN ACTIVATION COST, COMPILED AND PLAYED (DESIGN §3.172) —
 * Patrol Hound, Vampire Hounds, Frenetic Ogre, Tireless Tribe, from their
 * printed text. The compile half pins the closed noun table and the refusals;
 * the played half runs Patrol Hound through the real engine: the offer names a
 * card in hand, the card is in the graveyard before the ability resolves, and
 * the Hound has first strike afterwards.
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
const SEED = 41172;
const NO_MANA = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] } as const;

function creature(name: string, manaCost: Partial<typeof NO_MANA>, oracleText: string): CompilableCard {
  return {
    id: `test:${name}`,
    name,
    manaCost: { ...NO_MANA, ...manaCost },
    typeLine: { supertypes: [], types: ['Creature'], subtypes: ['Test'] },
    power: 2,
    toughness: 2,
    keywords: [],
    oracleText,
  } as CompilableCard;
}

const complete = (card: CompilableCard): CardDefinition => {
  const result = compileCard(card);
  expect(result.status, `${card.name} missing: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
};
const reported = (card: CompilableCard, line: RegExp) => {
  const result = compileCard(card);
  expect(result.status, `${card.name} compiled whole — it should have reported`).not.toBe('complete');
  expect(result.missing.map((m) => m.text).join('\n')).toMatch(line);
};

/** Patrol Hound — real printed text (corpus 2026-09-19). */
const HOUND_CARD = creature('Patrol Hound', { generic: 1, W: 1 }, 'Discard a card: Patrol Hound gains first strike until end of turn.');

describe('§3.172 — the discard cost, compiled', () => {
  it('Patrol Hound: "Discard a card:" is a one-card discard with no filter, and the body is the self grant', () => {
    const def = complete(HOUND_CARD);
    expect(def.activated).toHaveLength(1);
    expect(def.activated![0]!.cost).toEqual({ discard: { count: 1 } });
    expect(def.activated![0]!.effects).toEqual([
      { primitive: 'grantKeywordUntilEndOfTurn', params: { keywords: { firstStrike: true } } },
    ]);
  });

  it('Vampire Hounds: "a creature card" is the creature filter the sacrifice cost also reads', () => {
    const def = complete(
      creature('Vampire Hounds', { generic: 1, B: 1 }, 'Discard a creature card: Vampire Hounds gets +2/+2 until end of turn.'),
    );
    expect(def.activated![0]!.cost).toEqual({ discard: { count: 1, filter: { anyOfTypes: ['creature'] } } });
  });

  it('Frenetic Ogre: "{R}, Discard a card at random:" keeps the mana and marks the draw random', () => {
    const def = complete(
      creature('Frenetic Ogre', { generic: 3, R: 2 }, '{R}, Discard a card at random: Frenetic Ogre gets +3/+0 until end of turn.'),
    );
    expect(def.activated![0]!.cost).toEqual({ mana: { R: 1 }, discard: { count: 1, random: true } });
  });

  it('refuses what the table does not hold: two cards, your hand, a historic card, and a sacrifice beside a discard', () => {
    reported(
      creature('Two Cards', { generic: 2 }, 'Discard two cards: Two Cards gets +2/+2 until end of turn.'),
      /^discard two cards:/i,
    );
    reported(
      creature('Null Brooch', { generic: 4 }, '{2}, {T}, Discard your hand: Null Brooch gets +1/+1 until end of turn.'),
      /discard your hand/i,
    );
    reported(
      creature('Sanctum Spirit', { generic: 3, W: 1 }, 'Discard a historic card: Sanctum Spirit gains indestructible until end of turn.'),
      /discard a historic card/i,
    );
    reported(
      creature('Both Costs', { generic: 2 }, '{1}, Discard a card, Sacrifice a creature: Both Costs gets +2/+2 until end of turn.'),
      /discard a card, sacrifice a creature/i,
    );
  });
});

// --- played ------------------------------------------------------------------

function fromPool(name: string): CardDefinition {
  const found = CARD_POOL.find((entry) => entry.name === name);
  if (!found) throw new Error(`pool missing ${name}`);
  return found;
}

const BEAR: CardDefinition = { id: 'bear', name: 'Test Bear', types: ['creature'], power: 2, toughness: 2 };

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected') as { reason?: string } | undefined;
  if (rejected) throw new Error(`unexpected rejection: ${rejected.reason ?? '?'}`);
  return result.state;
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
          { kind: 'answerChoice', player: question.chooser, choiceId: question.id, answer: defaultAnswerFor(question) } as GameAction,
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
    decks: { A: { cards: Array.from({ length: 60 }, () => forest) }, B: { cards: Array.from({ length: 60 }, () => forest) } },
    registry: reg,
  });
  let s = state;
  let guard = 0;
  while ((s.step !== 'precombatMain' || s.priorityPlayer !== 'A' || s.stack.length > 0 || s.pendingChoice) && guard++ < 600) {
    s = settle(s, reg);
    if (s.stack.length === 0 && s.pendingChoice == null) s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
  }
  return s;
}

function put(state: GameState, def: CardDefinition, controller: PlayerId, zone: 'battlefield' | 'hand'): InstanceId {
  const id = state.nextInstanceId++;
  const instance = {
    instanceId: id,
    def,
    controller,
    owner: controller,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  } as never;
  if (zone === 'hand') (state.players[controller].hand as unknown[]).push(instance);
  else (state.battlefield as unknown[]).push(instance);
  return id;
}

const onBoard = (state: GameState, id: InstanceId) => state.battlefield.find((c) => c.instanceId === id);

describe('§3.172 — Patrol Hound, played', () => {
  it('offers one activation per card in hand, discards the named card as the cost, and has first strike after', () => {
    const reg = buildRegistry();
    const HOUND = complete(HOUND_CARD);
    let s = toMain(reg);
    const hound = put(s, HOUND, 'A', 'battlefield');
    const handBefore = s.players.A.hand.length;
    const bear = put(s, BEAR, 'A', 'hand');

    const offered = generateLegalActions(s).filter(
      (a): a is Extract<GameAction, { kind: 'activateAbility' }> => a.kind === 'activateAbility' && a.instanceId === hound,
    );
    expect(offered, 'one offer per card in hand (the seven-card hand plus the Bear)').toHaveLength(handBefore + 1);
    const withBear = offered.find((a) => a.costInstanceIds?.[0] === bear)!;
    expect(withBear).toBeDefined();

    s = act(s, withBear, reg);
    expect(s.stack, 'the ability is on the stack').toHaveLength(1);
    expect(s.players.A.hand.some((c) => c.instanceId === bear), 'the Bear left the hand as the cost was paid').toBe(false);
    expect(s.players.A.graveyard.some((c) => c.instanceId === bear)).toBe(true);
    expect(s.pendingChoice, 'nothing is asked — the payer rode the action').toBeNull();

    s = settle(s, reg);
    const index = indexContinuous(s);
    expect(effectiveKeywords(onBoard(s, hound)!, index.get(hound) ?? undefined).firstStrike).toBe(true);
    expect(s.players.A.hand).toHaveLength(handBefore);
  });
});
