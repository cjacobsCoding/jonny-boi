/**
 * BLINK, PLAYED — Cloudshift and Conjurer's Closet in real seeded games.
 *
 * The archetype's entire claim is CR 400.7: what comes back is a NEW OBJECT. So
 * the assertion that matters is not "the creature is still on the battlefield"
 * (it would be that if blink did nothing at all) — it is that the creature's
 * enters-the-battlefield trigger fired a SECOND time. A blink that quietly
 * no-oped would pass every other check in this file.
 *
 * The other half of "new object" is the part players lose: counters, damage and
 * summoning-sickness reset. Those are asserted too, because a blink that
 * preserved them would be a strictly better card than the one printed — and the
 * pilot would then value it off a lie.
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  GameAction,
  GameEvent,
  GameState,
  InstanceId,
  PlayerId,
} from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, defaultAnswerFor } from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEEDS = { cloudshift: 5101, closet: 5102, counters: 5103 } as const;

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((entry) => entry.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const FOREST = getByName('Forest');

let seen: GameEvent[] = [];

function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  seen.push(...result.events);
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

function advanceToMain(state: GameState, reg: Registry): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== 'precombatMain' && !s.gameOver && guard++ < 400) s = pass(s, reg);
  return s;
}

function giveHand(state: GameState, player: PlayerId, def: CardDefinition): InstanceId {
  const id = state.nextInstanceId++;
  state.players[player].hand.push({
    instanceId: id,
    def,
    controller: player,
    owner: player,
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return id;
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

function openBoard(seed: number, reg: Registry): GameState {
  seen = [];
  const { state } = createGame({
    seed,
    decks: {
      A: { cards: Array.from({ length: 60 }, () => FOREST) },
      B: { cards: Array.from({ length: 60 }, () => FOREST) },
    },
    registry: reg,
  });
  const s = advanceToMain(state, reg);
  s.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  s.players.B.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  return s;
}

/** How many cards `player` has drawn so far, counted from the event log. */
function drawsBy(player: PlayerId, state: GameState): number {
  const owned = new Set(
    [...state.players[player].hand, ...state.battlefield.filter((c) => c.controller === player)].map(
      (c) => c.instanceId,
    ),
  );
  return seen.filter((e) => e.type === 'drawCard' && (e as { player: PlayerId }).player === player && owned.size >= 0)
    .length;
}

describe('Cloudshift — the one-shot blink', () => {
  it('re-fires the blinked creature’s enters trigger (the whole point)', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.cloudshift, reg);
    // Wall of Omens: "When this creature enters, draw a card." Put it on the
    // battlefield WITHOUT casting it, so the only draw we can attribute to it is
    // the one the blink causes.
    const wall = place(s, getByName('Wall of Omens'), 'A');
    const before = drawsBy('A', s);

    const shift = giveHand(s, 'A', getByName('Cloudshift'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: shift, targets: [wall] }, reg);
    let guard = 0;
    while ((s.stack.length > 0 || s.pendingChoice != null) && !s.gameOver && guard++ < 40) s = pass(s, reg);

    expect(drawsBy('A', s), 'the blink must re-trigger Wall of Omens').toBe(before + 1);

    // The wall is back on the battlefield, and it is a NEW object: a fresh
    // instance id would be wrong (the card keeps its identity), but its
    // battlefield state must have been reset.
    const returned = s.battlefield.find((c) => c.def.name === 'Wall of Omens');
    expect(returned, 'the wall came back').toBeDefined();
    expect(returned?.summoningSick, 'a returned creature is summoning sick (CR 302.6)').toBe(true);
  });

  it('resets counters and damage — what comes back is a new object', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.counters, reg);
    const wall = place(s, getByName('Wall of Omens'), 'A');
    const target = s.battlefield.find((c) => c.instanceId === wall)!;
    target.counters = { p1p1: 3 };
    target.damageMarked = 1;
    target.tapped = true;

    const shift = giveHand(s, 'A', getByName('Cloudshift'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: shift, targets: [wall] }, reg);
    let guard = 0;
    while ((s.stack.length > 0 || s.pendingChoice != null) && !s.gameOver && guard++ < 40) s = pass(s, reg);

    const returned = s.battlefield.find((c) => c.def.name === 'Wall of Omens');
    expect(returned?.counters ?? {}, 'counters do not come back with it').toEqual({});
    expect(returned?.damageMarked, 'marked damage is gone').toBe(0);
    expect(returned?.tapped, 'it returns untapped').toBe(false);
  });

  it('a blinked TOKEN ceases to exist (CR 111.7) rather than returning', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.cloudshift + 1, reg);
    // A token is a permanent that is not a card, so exiling it ends it — there is
    // nothing left in exile for the return half to find.
    // `isToken` lives on the DEFINITION (that is what `ceaseToExistIfToken`
    // reads), so the token is a permanent whose def is marked, exactly as
    // `makeToken` builds one.
    const tokenDef: CardDefinition = { ...getByName('Wall of Omens'), isToken: true };
    const tokenId = place(s, tokenDef, 'A');

    const shift = giveHand(s, 'A', getByName('Cloudshift'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: shift, targets: [tokenId] }, reg);
    let guard = 0;
    while ((s.stack.length > 0 || s.pendingChoice != null) && !s.gameOver && guard++ < 40) s = pass(s, reg);

    expect(
      s.battlefield.some((c) => c.instanceId === tokenId),
      'a blinked token does not come back',
    ).toBe(false);
  });
});

describe("Conjurer's Closet — the repeatable engine", () => {
  it('offers the blink at your end step and re-fires the trigger when taken', () => {
    const reg = buildRegistry();
    let s = openBoard(SEEDS.closet, reg);
    place(s, getByName("Conjurer's Closet"), 'A');
    place(s, getByName('Wall of Omens'), 'A');
    const before = drawsBy('A', s);

    // Walk to A's end step; the Closet's trigger goes on the stack there.
    let guard = 0;
    while (s.step !== 'end' && !s.gameOver && guard++ < 60) s = pass(s, reg);
    // Settle the trigger, taking every "you may" (defaultAnswerFor declines, so
    // the yes is given explicitly — that IS the decision the card asks for).
    guard = 0;
    while ((s.stack.length > 0 || s.pendingChoice != null) && !s.gameOver && guard++ < 40) {
      const q = s.pendingChoice;
      if (q && q.kind === 'confirm') {
        s = act(
          s,
          { kind: 'answerChoice', player: q.chooser, choiceId: q.id, answer: { kind: 'confirm', yes: true } },
          reg,
        );
        continue;
      }
      s = pass(s, reg);
    }

    expect(drawsBy('A', s), "the Closet's end-step blink re-triggers the wall").toBe(before + 1);
  });
});
