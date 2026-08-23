/**
 * RESTORATION ANGEL — and the word "non-Angel", which is the whole card.
 *
 * "When this creature enters, you may exile target non-Angel creature you
 * control, then return that card to the battlefield under your control."
 *
 * The exclusion is not flavour. Restoration Angel is itself a creature you
 * control, so a blink that could name it would re-trigger its own enters ability,
 * which would blink it again, for ever. That is the same shape as the copy mirror
 * (DESIGN §3.33) that burned the 6,000-action cap in three soak games, and it is
 * why the card gets its own target restriction instead of borrowing
 * `creatureYouControl`.
 *
 * So the assertions are: the Angel is NOT offered as a target for its own
 * trigger, another Angel is not either, and an ordinary creature still is —
 * because a guard that switched the card off entirely would pass the first two.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, defaultAnswerFor, legalTargetsFor } from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEED = 31337;

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((entry) => entry.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const FOREST = getByName('Forest');
const RESTO = getByName('Restoration Angel');

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

function pass(state: GameState, reg: Registry): GameState {
  const question = state.pendingChoice;
  if (question) {
    return act(
      state,
      { kind: 'answerChoice', player: question.chooser, choiceId: question.id, answer: defaultAnswerFor(question) },
      reg,
    );
  }
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const id = state.nextInstanceId++;
  state.battlefield.push({
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

function openBoard(reg: Registry): GameState {
  const { state } = createGame({
    seed: SEED,
    decks: {
      A: { cards: Array.from({ length: 60 }, () => FOREST) },
      B: { cards: Array.from({ length: 60 }, () => FOREST) },
    },
    registry: reg,
  });
  let s = state;
  let guard = 0;
  while (s.step !== 'precombatMain' && !s.gameOver && guard++ < 400) s = pass(s, reg);
  s.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  s.players.B.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  return s;
}

describe('Restoration Angel', () => {
  it('compiles as printed: flash, flying, and an Angel', () => {
    expect(RESTO.keywords?.flash, 'flash is what makes it an ambush blocker').toBe(true);
    expect(RESTO.keywords?.flying).toBe(true);
    // It must carry the subtype, or the "non-Angel" restriction cannot exclude it.
    expect(RESTO.subtypes?.map((s) => s.toLowerCase())).toContain('angel');
  });

  it('cannot target ITSELF — the infinite-blink guard', () => {
    const reg = buildRegistry();
    const s = openBoard(reg);
    const angel = place(s, RESTO, 'A');
    const targets = legalTargetsFor(s, 'nonAngelCreatureYouControl', 'A', RESTO);
    expect(targets, 'the Angel must not be a legal target for its own blink').not.toContain(angel);
  });

  it('cannot target ANOTHER Angel either — "non-Angel", not "another creature"', () => {
    const reg = buildRegistry();
    const s = openBoard(reg);
    place(s, RESTO, 'A');
    const other = place(s, getByName('Angel of Mercy'), 'A');
    const targets = legalTargetsFor(s, 'nonAngelCreatureYouControl', 'A', RESTO);
    expect(targets, 'Angel of Mercy is an Angel; the printed line excludes it').not.toContain(other);
  });

  it('DOES target an ordinary creature — the card still works', () => {
    const reg = buildRegistry();
    const s = openBoard(reg);
    place(s, RESTO, 'A');
    const wall = place(s, getByName('Wall of Omens'), 'A');
    const targets = legalTargetsFor(s, 'nonAngelCreatureYouControl', 'A', RESTO);
    expect(targets, 'a non-Angel creature you control is exactly what it wants').toContain(wall);
  });

  it("does not offer an OPPONENT's creature", () => {
    const reg = buildRegistry();
    const s = openBoard(reg);
    place(s, RESTO, 'A');
    const theirs = place(s, getByName('Wall of Omens'), 'B');
    const targets = legalTargetsFor(s, 'nonAngelCreatureYouControl', 'A', RESTO);
    expect(targets, '"you control" means yours').not.toContain(theirs);
  });
});
