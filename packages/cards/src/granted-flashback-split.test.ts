/**
 * A GRANTED FLASHBACK ON A SPLIT CARD — the offer and the apply must agree.
 *
 * Snapcaster Mage grants flashback to an instant or sorcery CARD in a graveyard.
 * A split card (CR 709) is one card with two halves, and casting it from the
 * graveyard resolves to a HALF — so the cast's definition is not the card's own
 * definition. `applyCastSpell` read the granted cost only when those two were the
 * same object, and fell back to the half's PRINTED flashback otherwise, which a
 * split half does not have.
 *
 * The result was a menu that lied: `generateLegalActions` offered the graveyard
 * cast (it checks affordability with `flashbackCostOf`, which finds the grant),
 * the pilot took it, and the engine refused with "that card has no flashback".
 * The full-pool soak reported it as its own invariant — "the engine never
 * rejects an action it offered" — at seed 1200969370, an `Assault // Battery`
 * that had already been cast as Assault and hit the yard.
 *
 * The fix is that both sides now read the same accessor. This pins it, because
 * "offer and apply agree" is exactly the kind of property that decays silently:
 * nothing crashes, the action is simply refused for ever.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, defaultAnswerFor, generateLegalActions } from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEED = 70941;

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((entry) => entry.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const FOREST = getByName('Forest');
const SPLIT = getByName('Assault // Battery');

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

/** Put the split card straight into A's graveyard, as a resolved half would. */
function splitInGraveyard(state: GameState): InstanceId {
  const id = state.nextInstanceId++;
  const owner: PlayerId = 'A';
  state.players[owner].graveyard.push({
    instanceId: id,
    def: SPLIT,
    controller: owner,
    owner,
    zone: 'graveyard',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return id;
}

describe('a flashback GRANT on a split card', () => {
  it('is offered and then accepted — the menu does not lie', () => {
    const reg = buildRegistry();
    const s = openBoard(reg);
    const split = splitInGraveyard(s);
    // The grant Snapcaster hands out: flashback for a cost, on this instance in
    // this zone. Written directly so the test pins the ENGINE rule rather than
    // Snapcaster's own targeting.
    s.cardGrants = [
      ...(s.cardGrants ?? []),
      {
        id: 1,
        targetInstanceId: split,
        zone: 'graveyard',
        flashback: { generic: 1, R: 1 },
        expiresAtEndOfTurn: true,
      } as NonNullable<GameState['cardGrants']>[number],
    ];

    const offered = generateLegalActions(s, DEFAULT_RULES).filter((a) => {
      const raw = a as unknown as Record<string, unknown>;
      return raw['kind'] === 'castSpell' && raw['instanceId'] === split && raw['fromZone'] === 'graveyard';
    });
    // Half the bug: the offer really is made. Without this the next assertion
    // would pass vacuously on a board that never offered anything.
    expect(offered.length, 'the granted flashback must be offered from the graveyard').toBeGreaterThan(0);

    // The other half: the engine must then ACCEPT what it offered. `act` turns
    // any rejection into a throw, so this line is the whole regression.
    const after = act(s, offered[0] as GameAction, reg);
    expect(
      after.stack.some((o) => o.instanceId === split),
      'the flashed-back half should be on the stack',
    ).toBe(true);
  });
});
