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
import { cardValueContext } from './card-value.js';
import { answerChoiceHeuristically } from './choices.js';
import { copySpellValue } from './effect-value.js';
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

/**
 * THE COPY CHAIN THAT COULD NOT END.
 *
 * Three full-pool soak games burned the 6,000-action cap on one shape, and this
 * is that shape reduced to a single position: a spell on the stack, a copy spell
 * aimed at it, and a copy of THAT copy spell resolving. The re-aim question then
 * offers both, and the pilot used to price them as cards — a Reverberate is
 * 8 + 2 per mana value = 12, a Lightning Bolt 10 — so it aimed the copy at the
 * Reverberate, which produced another copy of the Reverberate, which asked the
 * same question again. The board, the stack and both life totals were identical
 * across ~1,800 repetitions; nothing but the action cap stopped it.
 *
 * `soak.test.ts` pins the three real games. This pins the DECISION, because that
 * is where the bug was: the value of copying a spell has to be the value of what
 * the chain ENDS at, shrunk once per link, so the shorter route always wins.
 */
describe('the pilot does not aim a copy at the copy spell above its own target', () => {
  it('re-aims a copy of Reverberate at the Bolt, not at the Reverberate copying it', () => {
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

    // The exact stack the soak froze on, built by hand: a real spell, a copy
    // spell aimed at it, and a second copy spell aimed at THAT.
    const boltId = giveHand(s, 'A', getByName('Lightning Bolt'));
    const revOneId = giveHand(s, 'A', getByName('Reverberate'));
    const revTwoId = giveHand(s, 'A', getByName('Reverberate'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: boltId, targets: ['B'] }, reg);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: revOneId, targets: [boltId] }, reg);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: revTwoId, targets: [revOneId] }, reg);

    // Resolve the top Reverberate: it makes a copy of the one below and parks
    // the CR 707.10 re-aim question for it.
    s = act(s, { kind: 'passPriority', player: 'A' }, reg);
    s = act(s, { kind: 'passPriority', player: 'B' }, reg);
    const question = s.pendingChoice;
    expect(question?.kind, 'the re-aim question should be parked').toBe('selectTargets');

    // BOTH ROUTES REALLY WERE OFFERED. Without this the next assertion could
    // pass because the loop-making candidate was never on the menu, which is a
    // different pool, not a fixed pilot.
    const offered = question?.kind === 'selectTargets' ? question.candidates.map((c) => c.ref) : [];
    expect(offered, 'the Bolt must be on the menu').toContain(boltId);
    expect(offered, 'the copy spell must be on the menu — it is the legal play this test rejects').toContain(
      revOneId,
    );

    const action = answerChoiceHeuristically(s, question!, DEFAULT_HEURISTIC_WEIGHTS);
    // THE ASSERTION: the chain's END, not the link above it. Aiming at the
    // Reverberate produces one more copy of the Reverberate and the same
    // question; aiming at the Bolt produces the Bolt copy the chain was always
    // going to produce, a resolution sooner.
    expect(action.kind === 'answerChoice' ? action.answer : undefined).toEqual({
      kind: 'selectTargets',
      targets: [boltId],
    });
  });

  it('prices a copy of a copy spell STRICTLY below a copy of what it is aimed at', () => {
    // The ordering above is not an accident of candidate order: it is arithmetic,
    // and this is the arithmetic. A share of 1 (or a raw `cardValue`, which is
    // what shipped) makes the Reverberate the BETTER pick, because a Reverberate
    // costs more mana than a Bolt.
    const share = DEFAULT_HEURISTIC_WEIGHTS.copiedCopySpellValueShare;
    expect(share, 'a share of 1 or more cannot terminate a copy chain').toBeLessThan(1);
    expect(share, 'a share of 0 would make copying a copy spell a blunder, which it is not').toBeGreaterThan(0);
  });
});

/**
 * THE RULER ITSELF — `copySpellValue`, which both the cast decision and the
 * re-aim question read, so "what is copying this worth" has one answer.
 *
 * Pinned as three numbers rather than as an ordering, because the ordering is a
 * consequence of them and the numbers are what a future weight edit would move.
 */
describe('what copying a spell is worth follows the chain to its end', () => {
  /** Build the stack `[Lightning Bolt, Reverberate→Bolt]` and hand back both ids. */
  function stackedCopyChain(reg: Registry) {
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
    const revId = giveHand(s, 'A', getByName('Reverberate'));
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: boltId, targets: ['B'] }, reg);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: revId, targets: [boltId] }, reg);
    return { s, boltId, revId };
  }

  const valueOf = (s: GameState, id: InstanceId) =>
    copySpellValue(
      s,
      s.stack.find((o) => o.kind === 'spell' && o.instanceId === id) as never,
      DEFAULT_HEURISTIC_WEIGHTS,
      cardValueContext(s),
    );

  it('prices the END of the chain at the card, and the link above it strictly lower', () => {
    const reg = buildRegistry();
    const { s, boltId, revId } = stackedCopyChain(reg);
    const bolt = valueOf(s, boltId);
    const rev = valueOf(s, revId);
    expect(bolt, 'a Bolt is priced as the card it is').toBeGreaterThan(0);
    // The Reverberate copies the Bolt, so copying the Reverberate eventually
    // produces the same one Bolt copy — one resolution later, and only if the
    // Reverberate is still there when it happens.
    expect(rev).toBeCloseTo(bolt * DEFAULT_HEURISTIC_WEIGHTS.copiedCopySpellValueShare, 10);
    expect(rev, 'a longer route to the same copy must never win').toBeLessThan(bolt);
  });

  it('prices a chain that runs OFF the stack at nothing', () => {
    const reg = buildRegistry();
    const { s, revId } = stackedCopyChain(reg);
    // B counters the Bolt out from under the Reverberate. What is left on the
    // stack is a copy spell aimed at nothing: a copy of it would fizzle, and a
    // pilot that still priced it as a 2-mana card would spend a real card on it.
    let after = s;
    const cancelId = giveHand(after, 'B', getByName('Cancel'));
    after = act(after, { kind: 'passPriority', player: 'A' }, reg);
    after = act(after, { kind: 'castSpell', player: 'B', instanceId: cancelId, targets: [boltOf(after)] }, reg);
    after = act(after, { kind: 'passPriority', player: 'B' }, reg);
    after = act(after, { kind: 'passPriority', player: 'A' }, reg);
    expect(after.stack.map((o) => (o.kind === 'spell' ? o.card.def.name : o.kind))).toEqual(['Reverberate']);
    expect(valueOf(after, revId)).toBe(0);
  });

  /** The Bolt on the stack — read back rather than closed over, so the cast is real. */
  function boltOf(s: GameState): InstanceId {
    const bolt = s.stack.find((o) => o.kind === 'spell' && o.card.def.name === 'Lightning Bolt');
    if (!bolt) throw new Error('no Bolt on the stack');
    return bolt.instanceId;
  }
});
