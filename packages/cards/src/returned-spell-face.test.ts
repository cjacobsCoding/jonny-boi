/**
 * A SPELL RETURNED TO HAND IS A NEW OBJECT (CR 400.7) — including which face it is.
 *
 * "…then return it to its owner's hand" (Narset's Reversal) takes a spell off the
 * stack and puts the CARD in a hand. A card in hand is front-face-up: a modal DFC
 * cast as its back half does not stay a back half once it stops being a spell,
 * and a back face cannot be cast from hand at all (CR 712.8b).
 *
 * `returnSpellToHand` used to push the instance straight into the hand array with
 * three hand-rolled lines and no reset, so the card arrived still wearing the
 * face it had been cast as. The full-pool soak found what that costs: the pilot
 * saw a castable card, the engine refused it ("the back face of a double-faced
 * card cannot be cast"), and the pair repeated the same rejected action **82
 * times in one game** — failing both "every action a pilot submits came from
 * generateLegalActions" and "the engine never rejects an action it offered",
 * while the card sat in hand as a permanent dead draw. DESIGN §3.34.
 *
 * The seed that found it is deliberately NOT the regression: it is keyed to a
 * generated matchup, and the very next pool change re-deals it. This builds the
 * position directly instead, so it holds whatever the pool does.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, GameAction, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES, defaultAnswerFor } from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEED = 71208;

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((entry) => entry.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const FOREST = getByName('Forest');

/** The back half of a modal DFC: a real spell, castable from hand. */
const BACK_HALF: CardDefinition = {
  id: 'mdfc-back-half',
  name: 'Blow Off Steam',
  types: ['instant'],
  cost: { R: 1 },
  isBackFace: true,
  effects: [{ primitive: 'dealDamage', params: { amount: 2, targets: 'any' } }],
};

/** The card as it sits in hand: front-face-up, with a castable second half. */
const MDFC: CardDefinition = {
  id: 'mdfc-front-half',
  name: 'Steam Vents Adept',
  types: ['creature'],
  cost: { generic: 1, R: 1 },
  power: 2,
  toughness: 2,
  backFace: BACK_HALF,
  backFaceCastable: true,
};

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

describe('a spell returned to hand by Narset’s Reversal', () => {
  it('comes back FRONT-face-up, so it can be cast again', () => {
    const reg = buildRegistry();
    let s = openBoard(reg);
    const mdfc = giveHand(s, 'A', MDFC);
    const reversal = giveHand(s, 'A', getByName("Narset's Reversal"));

    // Cast the BACK half, then bounce it with Narset's Reversal.
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: mdfc, targets: ['B'], face: 'back' }, reg);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: reversal, targets: [mdfc] }, reg);
    let guard = 0;
    while ((s.stack.length > 0 || s.pendingChoice != null) && !s.gameOver && guard++ < 40) s = pass(s, reg);

    const inHand = s.players.A.hand.find((c) => c.instanceId === mdfc);
    expect(inHand, 'the bounced card should be in hand').toBeDefined();
    // THE ASSERTION. A back face in hand is a card that can never be cast again
    // (CR 712.8b) — a permanent dead draw, and an action the pilot keeps
    // proposing and the engine keeps refusing.
    expect(
      inHand?.def.isBackFace,
      'a card in hand is front-face-up (CR 712.8a) — it must not keep the face it was cast as',
    ).not.toBe(true);
    expect(inHand?.def.name, 'it is the front face by name too').toBe('Steam Vents Adept');
  });

  it('is castable again once it is back — the real cost of the bug', () => {
    // The bug was not cosmetic bookkeeping: it made the card unplayable for the
    // rest of the game. Casting it again is the property that actually matters.
    const reg = buildRegistry();
    let s = openBoard(reg);
    const mdfc = giveHand(s, 'A', MDFC);
    const reversal = giveHand(s, 'A', getByName("Narset's Reversal"));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: mdfc, targets: ['B'], face: 'back' }, reg);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: reversal, targets: [mdfc] }, reg);
    let guard = 0;
    while ((s.stack.length > 0 || s.pendingChoice != null) && !s.gameOver && guard++ < 40) s = pass(s, reg);

    s.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
    // No throw = the engine accepted it. `act` turns any rejection into one.
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: mdfc, targets: [] }, reg);
    expect(s.stack.some((o) => o.instanceId === mdfc), 'the front half is on the stack').toBe(true);
  });
});
