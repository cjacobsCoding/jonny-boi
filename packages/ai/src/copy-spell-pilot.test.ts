/**
 * THE PILOT AND THE COPY (CR 707.10) — "you may choose new targets for the copy".
 *
 * The aiming moment this system adds is asked from inside a RESOLUTION, which is
 * a place `answerSelectTargets` had never been asked from. With nothing to price
 * there, every candidate scores zero and the pilot degrades to the FIRST offered
 * one — and for a copy of a Lightning Bolt that is very often its own face. So
 * the failure this file guards is not "the pilot plays it slightly worse": it is
 * "the pilot burns itself with a spell it copied on purpose".
 *
 * The mechanism worth understanding: the COPY is not on the stack when the
 * question is asked (`copySpell` builds it locally and pushes only once every
 * question is answered, because a parked question re-runs the whole ref). What
 * IS on the stack is the spell being copied, named by the resolving spell's own
 * target — and that is what the pilot reads.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES } from '@jonny-boi/core';
import { buildRegistry, CARD_POOL } from '@jonny-boi/cards';
import { answerChoiceHeuristically } from './choices.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEED = 4401;

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((entry) => entry.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const FOREST = getByName('Forest');

function act(state: GameState, action: Parameters<typeof applyAction>[1], reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

function advanceToMain(state: GameState, reg: Registry): GameState {
  let s = state;
  let guard = 0;
  while (s.step !== 'precombatMain' && !s.gameOver && guard++ < 400) {
    const question = s.pendingChoice;
    s = question
      ? act(
          s,
          {
            kind: 'answerChoice',
            player: question.chooser,
            choiceId: question.id,
            answer: { kind: 'selectCards', instanceIds: [] },
          },
          reg,
        )
      : act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
  }
  return s;
}

function giveHand(state: GameState, player: PlayerId, def: CardDefinition): InstanceId {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller: player,
    owner: player,
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.players[player].hand.push(inst);
  return inst.instanceId;
}

describe('the pilot aims a spell copy at the OPPONENT', () => {
  it('re-aims a copy of an opposing Bolt away from its own face', () => {
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

    // A (the active player) casts the Bolt at B; then A copies it. The pilot
    // seated at A is the one answering, and the aim it inherits already points
    // at B — so to make the test mean something, the copy inherits an aim at
    // A's OWN face and the pilot must move it.
    const boltId = giveHand(s, 'A', getByName('Lightning Bolt'));
    const revId = giveHand(s, 'A', getByName('Reverberate'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: boltId, targets: ['A'] }, reg);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: revId, targets: [boltId] }, reg);

    // Resolve Reverberate; it parks the re-aim question.
    s = act(s, { kind: 'passPriority', player: 'A' }, reg);
    s = act(s, { kind: 'passPriority', player: 'B' }, reg);
    const question = s.pendingChoice;
    expect(question?.kind, 'the re-aim question should be parked').toBe('selectTargets');
    expect(question?.chooser).toBe('A');

    const action = answerChoiceHeuristically(s, question!, DEFAULT_HEURISTIC_WEIGHTS);
    // THE ASSERTION: the pilot moved the copy off its own face. A pilot that
    // scored every candidate zero would have taken whichever the engine happened
    // to list first, and the engine lists players in seat order — so 'A'.
    expect(action.kind).toBe('answerChoice');
    expect(action.kind === 'answerChoice' ? action.answer : undefined).toEqual({
      kind: 'selectTargets',
      targets: ['B'],
    });

    // …and it is not a coincidence of ordering: 'A' really was offered.
    expect(question?.kind === 'selectTargets' ? question.candidates.map((c) => c.ref) : []).toContain('A');
  });
});
