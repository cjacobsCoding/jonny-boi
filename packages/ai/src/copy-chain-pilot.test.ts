/**
 * THE COPY MIRROR — why a copy spell must not be priced at its face value.
 *
 * Two copy spells on the stack are each other's legal targets, so "copy target
 * instant or sorcery" can always be pointed at another copy. Pricing that at the
 * copied CARD's value (a Twincast is an expensive card, so copying one looks
 * expensive-good) makes the mirror beat the real spell underneath it every time —
 * and a copy of a copy just makes another copy. Neither original ever reaches the
 * top of the stack.
 *
 * That is not a theoretical hazard: three full-pool soak games burned the
 * 6,000-action cap on it, ~1,850 copies deep, and they are pinned in
 * `sim/soak.test.ts`. This file pins the PRICING those games depend on, in
 * milliseconds instead of seconds, so a regression says *why* it broke rather
 * than only that some seed stopped ending.
 *
 * The rule being pinned: a copy is worth what the copy will actually DELIVER.
 * A copy of a copy spell delivers whatever sits at the end of its chain, one
 * resolution later — never the copy spell's own face value.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameState, InstanceId, PlayerId } from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES } from '@jonny-boi/core';
import { buildRegistry, CARD_POOL } from '@jonny-boi/cards';
import { answerChoiceHeuristically, cardValue, cardValueContext } from './choices.js';
import { resolutionValueContext, valueOfEffects } from './effect-value.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';

type Registry = ReturnType<typeof buildRegistry>;

const SEED = 90210;

function getByName(name: string): CardDefinition {
  const card = CARD_POOL.find((entry) => entry.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

const FOREST = getByName('Forest');
/** The effect ref for "copy target instant or sorcery" — what a copy spell runs. */
const COPY_EFFECT = getByName('Twincast').effects.find((e) => e.primitive === 'copySpell');

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

/** A board with mana for both seats, parked in A's main phase. */
function openBoard(reg: Registry): GameState {
  const { state } = createGame({
    seed: SEED,
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

describe('a copy is priced by what it delivers, not by the card it copies', () => {
  it('values copying a Twincast-pointed-at-a-Bolt as a BOLT, not as a Twincast', () => {
    // The whole defect in one assertion. Twincast is a pricier card than
    // Lightning Bolt, so face-value pricing rates the mirror ABOVE the real
    // spell; chain pricing rates it just below (one wasted resolution).
    const reg = buildRegistry();
    let s = openBoard(reg);
    const boltId = giveHand(s, 'A', getByName('Lightning Bolt'));
    const mirrorId = giveHand(s, 'A', getByName('Twincast'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: boltId, targets: ['B'] }, reg);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: mirrorId, targets: [boltId] }, reg);

    const context = resolutionValueContext(s, 'A', DEFAULT_HEURISTIC_WEIGHTS, cardValueContext(s));
    const valueOfCopying = (target: InstanceId): number =>
      valueOfEffects([COPY_EFFECT!], { ...context, targets: [target] });

    const bolt = valueOfCopying(boltId);
    const mirror = valueOfCopying(mirrorId);
    const twincastFaceValue = cardValue(
      s.players.A.hand.find((c) => c.instanceId === mirrorId) ??
        (s.stack.find((o) => o.kind === 'spell' && o.instanceId === mirrorId) as { card: CardInstance }).card,
      DEFAULT_HEURISTIC_WEIGHTS,
      context.cards,
    );

    // Copying the mirror delivers a Bolt eventually, so it is priced near the
    // Bolt — and nowhere near a Twincast's own face value.
    expect(mirror).toBeLessThan(bolt);
    expect(mirror).toBeGreaterThan(0);
    expect(
      mirror,
      'a copy of a copy spell must not inherit the copy spell\'s face value',
    ).toBeLessThan(twincastFaceValue);
  });

  it('prefers the real spell over the mirror REGARDLESS of which is offered first', () => {
    // This is the job `modeCopyChainPenalty` does. Without it the two score
    // EQUAL (the chain delivers exactly the Bolt), the tie falls to whichever
    // candidate the engine happens to list first, and the loop comes back the
    // day that ordering changes. Asserting a strict inequality is what makes the
    // preference independent of candidate order.
    const reg = buildRegistry();
    let s = openBoard(reg);
    const boltId = giveHand(s, 'A', getByName('Lightning Bolt'));
    const mirrorId = giveHand(s, 'A', getByName('Twincast'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: boltId, targets: ['B'] }, reg);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: mirrorId, targets: [boltId] }, reg);

    const context = resolutionValueContext(s, 'A', DEFAULT_HEURISTIC_WEIGHTS, cardValueContext(s));
    const bolt = valueOfEffects([COPY_EFFECT!], { ...context, targets: [boltId] });
    const mirror = valueOfEffects([COPY_EFFECT!], { ...context, targets: [mirrorId] });
    // Strictly greater, not merely "equal to the configured gap" — with the
    // penalty at zero that comparison is 0 === 0 and passes while the loop is
    // wide open again.
    expect(bolt).toBeGreaterThan(mirror);
    expect(bolt - mirror).toBe(DEFAULT_HEURISTIC_WEIGHTS.modeCopyChainPenalty);
  });

  it('prices a copy whose chain leads nowhere at zero', () => {
    // A copy spell on the stack aimed at something that has already left it
    // delivers nothing — it is countered on resolution (CR 608.2b).
    const reg = buildRegistry();
    let s = openBoard(reg);
    const mirrorId = giveHand(s, 'A', getByName('Twincast'));
    const boltId = giveHand(s, 'A', getByName('Lightning Bolt'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: boltId, targets: ['B'] }, reg);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: mirrorId, targets: [boltId] }, reg);
    // Drop the Bolt out from under the mirror: now the mirror copies nothing.
    s = { ...s, stack: s.stack.filter((o) => o.instanceId !== boltId) };

    const context = resolutionValueContext(s, 'A', DEFAULT_HEURISTIC_WEIGHTS, cardValueContext(s));
    expect(valueOfEffects([COPY_EFFECT!], { ...context, targets: [mirrorId] })).toBe(0);
  });
});

describe('the pilot answers the mirror correctly', () => {
  it('aims a copy at the real spell instead of at the copy spell beside it', () => {
    // End to end through the actual question the soak games looped on: a copy is
    // being aimed, and both a real spell and a copy spell are legal targets.
    const reg = buildRegistry();
    let s = openBoard(reg);
    const boltId = giveHand(s, 'A', getByName('Lightning Bolt'));
    const innerId = giveHand(s, 'A', getByName('Twincast'));
    const outerId = giveHand(s, 'A', getByName('Reverberate'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: boltId, targets: ['B'] }, reg);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: innerId, targets: [boltId] }, reg);
    // Reverberate copies the Twincast; the copy it makes may then be re-aimed —
    // at the Twincast (the mirror, which loops) or at the Bolt (which does something).
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: outerId, targets: [innerId] }, reg);
    s = act(s, { kind: 'passPriority', player: 'A' }, reg);
    s = act(s, { kind: 'passPriority', player: 'B' }, reg);

    const question = s.pendingChoice;
    expect(question?.kind, 'the re-aim question should be parked').toBe('selectTargets');
    const offered = question?.kind === 'selectTargets' ? question.candidates.map((c) => c.ref) : [];
    // Both really were on the menu — otherwise the assertion below is vacuous.
    expect(offered).toContain(boltId);
    expect(offered).toContain(innerId);

    const action = answerChoiceHeuristically(s, question!, DEFAULT_HEURISTIC_WEIGHTS);
    expect(action.kind === 'answerChoice' ? action.answer : undefined).toEqual({
      kind: 'selectTargets',
      targets: [boltId],
    });
  });
});
