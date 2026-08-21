/**
 * CR 707.10 IS A "MAY" — declining to re-aim a copy has to stay reachable.
 *
 * "You may choose new targets for the copy." While the copy's inherited target
 * is still legal that costs nothing to express: declining IS re-choosing the
 * same object, which is what a player does in paper, so the question can ask for
 * an exact count. But once the copied spell's own target has LEFT the stack it
 * is no longer offered as a candidate — and an exact-count question then has no
 * way to say "leave it alone". The copy is forced onto some other target.
 *
 * Forcing it is wrong on the rules, and it is not harmless: two copy spells are
 * each other's only legal targets, so a forced re-aim is what turns a pair of
 * them into a game that cannot end (see `sim/soak.test.ts`'s pinned copy-mirror
 * seeds). Declining ends that the way the rules already do — the copy keeps a
 * target that is gone and is countered on resolution (CR 608.2b).
 */

import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  GameAction,
  GameEvent,
  GameState,
  PlayerId,
} from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, defaultAnswerFor } from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEED = 7710;

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

function giveHand(state: GameState, player: PlayerId, def: CardDefinition): number {
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

/**
 * Build the position: a copy is about to be made of a Twincast whose OWN target
 * (a Lightning Bolt) has already been countered off the stack.
 *
 * Bolt → Twincast aimed at the Bolt → Cancel kills the Bolt → Reverberate aimed
 * at the now-targetless Twincast. When Reverberate resolves it copies the
 * Twincast, and the copy inherits an aim at a Bolt that is no longer there.
 */
function positionWithADeadInheritedAim(): { state: GameState; reg: Registry } {
  seen = [];
  const reg = buildRegistry();
  const { state } = createGame({
    seed: SEED,
    decks: {
      A: { cards: Array.from({ length: 60 }, () => FOREST) },
      B: { cards: Array.from({ length: 60 }, () => FOREST) },
    },
    registry: reg,
  });
  let s = advanceToMain(state, reg);
  s.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  s.players.B.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };

  const boltId = giveHand(s, 'A', getByName('Lightning Bolt'));
  const twincastId = giveHand(s, 'A', getByName('Twincast'));
  const reverberateId = giveHand(s, 'A', getByName('Reverberate'));
  const cancelId = giveHand(s, 'B', getByName('Cancel'));

  s = act(s, { kind: 'castSpell', player: 'A', instanceId: boltId, targets: ['B'] }, reg);
  s = act(s, { kind: 'castSpell', player: 'A', instanceId: twincastId, targets: [boltId] }, reg);
  // B counters the Bolt underneath, so the Twincast is left aiming at nothing.
  s = pass(s, reg); // A → B
  s = act(s, { kind: 'castSpell', player: 'B', instanceId: cancelId, targets: [boltId] }, reg);
  s = pass(s, reg); // B
  s = pass(s, reg); // A → Cancel resolves
  expect(s.stack.some((o) => o.instanceId === boltId), 'the Bolt should be countered off the stack').toBe(
    false,
  );
  expect(
    s.stack.some((o) => o.instanceId === twincastId),
    'the now-targetless Twincast must still be on the stack',
  ).toBe(true);

  // Now copy the targetless Twincast: the copy inherits its dead aim.
  s = act(s, { kind: 'castSpell', player: 'A', instanceId: reverberateId, targets: [twincastId] }, reg);
  let guard = 0;
  while (s.pendingChoice == null && !s.gameOver && guard++ < 10) s = pass(s, reg);
  return { state: s, reg };
}

describe('re-aiming a copy stays optional when the inherited target is gone', () => {
  it('offers declining (min 0) instead of forcing the copy onto another spell', () => {
    const { state } = positionWithADeadInheritedAim();
    const question = state.pendingChoice;
    expect(question?.kind, 'the re-aim question should be parked').toBe('selectTargets');
    // THE ASSERTION. With an exact count there is no legal way to answer "leave
    // it alone", and the only candidates are copy spells — which is the loop.
    expect(question?.min, 'CR 707.10 is a "may": declining must be answerable').toBe(0);
    expect(question?.max, 'never MORE targets than the copy already had').toBe(1);
  });

  it('a declined copy keeps its dead aim and is countered on resolution', () => {
    const { state, reg } = positionWithADeadInheritedAim();
    const question = state.pendingChoice!;
    const before = state.players.B.life;
    // Decline: the empty answer the previous test proved is legal.
    let s = act(
      state,
      {
        kind: 'answerChoice',
        player: question.chooser,
        choiceId: question.id,
        answer: { kind: 'selectTargets', targets: [] },
      },
      reg,
    );
    let guard = 0;
    while ((s.stack.length > 0 || s.pendingChoice != null) && !s.gameOver && guard++ < 40) s = pass(s, reg);

    // The copy did nothing: it was still aimed at a Bolt that had been
    // countered, so it fizzled rather than copying a copy spell.
    expect(s.players.B.life, 'a fizzled copy deals no damage').toBe(before);
    // And the game actually settled instead of spawning more copies.
    expect(s.stack, 'the stack must drain').toHaveLength(0);
    const copies = seen.filter((e) => e.type === 'spellCopied');
    expect(copies.length, 'exactly one copy was made — the declined one').toBe(1);
  });
});
