/**
 * INTERACTION MATRIX - modal casting x per-mode targeting x countering x the
 * cast-time cost questions ({X}, kicker, buyback) x protection.
 *
 * The seam under test is "every decision a caster makes while ANNOUNCING a
 * spell". All of these questions ride the same stack object and are answered
 * through the same `answerChoice` action, so the pairings are where one
 * question's answer can be written into another's slot.
 *
 * The sharpest edge, named by the system's own author: a modal spell resolves
 * into `ResolutionFrame.effects` plus a PARALLEL `effectTargets` array. The two
 * are spliced in lockstep; splice one without the other and every LATER mode's
 * target shifts by one - silently, with both modes still happening and both
 * still pointing at something legal-looking.
 *
 * Cards: Cryptic Command (choose two, four modes, three of them aimed
 * differently), Boros Charm (choose one), Counterspell, Lightning Bolt,
 * Silver Knight (protection from red).
 */

import { describe, expect, it } from 'vitest';
import {
  choosableModes,
  modalSpecOf,
  modeCountsFor,
  type CardDefinition,
  type GameAction,
  type GameState,
  type InstanceId,
} from '@jonny-boi/core';
import { buildRegistry } from '../pool.js';
import {
  act,
  boardAtMain,
  fund,
  isOnBattlefield,
  legal,
  onBattlefield,
  place,
  poolCard,
  resolvePermanent,
  settle,
  type Registry,
} from './harness.js';

const BEAR: CardDefinition = {
  id: 'matrix-modal-bear',
  name: 'Matrix Modal Bear',
  types: ['creature'],
  cost: { generic: 2 },
  power: 2,
  toughness: 2,
};

/** A red 2/2 - a red SOURCE for the protection cell. */
const RED_BRUTE: CardDefinition = {
  id: 'matrix-modal-red',
  name: 'Matrix Modal Brute',
  types: ['creature'],
  cost: { R: 1, generic: 1 },
  power: 2,
  toughness: 2,
};

/** Answer whatever cast-time question is parked, with the given answer body. */
function answerCast(
  state: GameState,
  reg: Registry,
  body: Extract<GameAction, { kind: 'answerChoice' }>['answer'],
): GameState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error('no cast-time question is parked');
  return act(state, { kind: 'answerChoice', player: choice.chooser, choiceId: choice.id, answer: body }, reg);
}

describe('CELL: modal casting x per-mode targets (the PARALLEL array)', () => {
  it('two modes aimed at two DIFFERENT objects both hit their own target', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    // A's board: one creature to bounce. B's board: one creature the tap mode hits.
    const mine = resolvePermanent(state, reg, BEAR, 'A');
    state = mine.state;
    const theirs = resolvePermanent(state, reg, BEAR, 'B');
    state = theirs.state;
    onBattlefield(state, theirs.id).tapped = false;

    const cryptic = place(state, 'A', 'hand', poolCard('Cryptic Command'));
    fund(state, 'A');
    state.priorityPlayer = 'A';
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: cryptic }, reg);

    // The modes are announced AT CAST (CR 601.2b), before anybody may respond.
    expect(state.pendingChoice?.kind).toBe('chooseModes');
    state = answerCast(state, reg, { kind: 'chooseModes', modeIds: ['bounce', 'draw'] });

    // ...then each chosen mode is AIMED at cast (CR 601.2c). Only the bounce mode
    // takes a target, so exactly one aiming question is asked.
    expect(state.pendingChoice?.kind).toBe('selectTargets');
    state = answerCast(state, reg, { kind: 'selectTargets', targets: [theirs.id] });
    expect(state.pendingChoice ?? null).toBeNull();

    const handBefore = state.players.A.hand.length;
    state = settle(state, reg);

    // The bounce hit THEIR creature, and the draw drew - the parallel array kept
    // the aim with its own mode.
    expect(isOnBattlefield(state, theirs.id)).toBe(false);
    expect(isOnBattlefield(state, mine.id)).toBe(true);
    expect(state.players.A.hand.length).toBeGreaterThan(handBefore);
  });

  it('a mode with no legal target is not on the menu, and a spell that can announce nothing is uncastable', () => {
    const reg = buildRegistry();
    const state = boardAtMain(reg);

    // Empty stack, empty board: "counter target spell" has no legal target, so
    // it is not offered - MTG's own rule, and what stops a dead button.
    const modes = choosableModes(state, poolCard('Cryptic Command'), 'A').map((m) => m.id);
    expect(modes).not.toContain('counter');
    // The other three are choosable (bounce needs a permanent... and there is
    // none, so it too drops out - which is exactly the point of asking).
    expect(modes).toContain('draw');
    expect(modes).toContain('tapAll');
    expect(modes).not.toContain('bounce');

    // The COUNT is board-relative too: with only two announceable modes a
    // "choose two" spell still asks for two, and never for more than the board
    // can supply.
    const counts = modeCountsFor(state, poolCard('Cryptic Command'), 'A');
    expect(counts?.min).toBe(2);
    expect(counts?.max).toBe(2);
    expect(counts?.choosable.map((m) => m.id)).toEqual(['tapAll', 'draw']);
  });

  it('a spell is a legal target for its OWN counter mode - declining is the pilot job, not the engine job', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const bolt = place(state, 'B', 'hand', poolCard('Lightning Bolt'));
    fund(state, 'B');
    state.priorityPlayer = 'B';
    state = act(state, { kind: 'castSpell', player: 'B', instanceId: bolt, targets: ['A'] }, reg);

    // With a real spell on the stack the counter mode becomes announceable.
    const modes = choosableModes(state, poolCard('Cryptic Command'), 'A').map((m) => m.id);
    expect(modes).toContain('counter');

    const cryptic = place(state, 'A', 'hand', poolCard('Cryptic Command'));
    fund(state, 'A');
    state.priorityPlayer = 'A';
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: cryptic }, reg);
    state = answerCast(state, reg, { kind: 'chooseModes', modeIds: ['counter', 'draw'] });
    state = answerCast(state, reg, { kind: 'selectTargets', targets: [bolt] });

    const lifeBefore = state.players.A.life;
    state = settle(state, reg);
    expect(state.players.A.life).toBe(lifeBefore);
    expect(state.players.B.graveyard.map((c) => c.instanceId)).toContain(bolt);
  });
});

describe('CELL: modal casting x protection (source-aware targeting)', () => {
  it('a mode may not be aimed at a permanent protected from the SPELL colour', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    // Boros Charm is {R}{W}, so it is a red source. Silver Knight has protection
    // from red, and the charm's third mode targets a creature.
    const knight = resolvePermanent(state, reg, poolCard('Silver Knight'), 'A');
    state = knight.state;
    const bear = resolvePermanent(state, reg, BEAR, 'A');
    state = bear.state;
    // A SECOND legal target, deliberately: with exactly one the engine aims the
    // mode itself and no question is parked, which would make this test unable
    // to look at the menu at all.
    const other = resolvePermanent(state, reg, RED_BRUTE, 'B');
    state = other.state;

    const charm = place(state, 'A', 'hand', poolCard('Boros Charm'));
    fund(state, 'A');
    state.priorityPlayer = 'A';
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: charm }, reg);
    state = answerCast(state, reg, { kind: 'chooseModes', modeIds: ['mode3'] });

    expect(state.pendingChoice?.kind).toBe('selectTargets');
    const choice = state.pendingChoice as { candidates: readonly { ref: InstanceId | 'A' | 'B' }[] };
    const ids = choice.candidates.map((o) => o.ref);
    // The plain bear is offered; the protected knight is not - protection blocks
    // its own controller too, which is the half hexproof does not share.
    expect(ids).toContain(bear.id);
    expect(ids).not.toContain(knight.id);
  });
});

describe('CELL: {X} x targeting x countering', () => {
  it('the {X} question is asked at cast, the value rides the stack, and a counter throws it all away', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const bear = resolvePermanent(state, reg, RED_BRUTE, 'B');
    state = bear.state;

    const burn = place(state, 'A', 'hand', poolCard('Blaze'));
    fund(state, 'A');
    state.priorityPlayer = 'A';
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: burn, targets: [bear.id] }, reg);
    expect(state.pendingChoice?.kind).toBe('chooseNumber');
    state = answerCast(state, reg, { kind: 'chooseNumber', value: 2 });

    // The X value is on the STACK OBJECT, which is what lets the resolution read
    // it after the question is long gone.
    const spell = state.stack.find((o) => o.instanceId === burn);
    expect((spell as { xValue?: number }).xValue).toBe(2);

    state = settle(state, reg);
    expect(isOnBattlefield(state, bear.id)).toBe(false);
  });

  it('an {X} spell that is COUNTERED deals nothing, and the mana is still gone', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const bear = resolvePermanent(state, reg, RED_BRUTE, 'B');
    state = bear.state;

    const burn = place(state, 'A', 'hand', poolCard('Blaze'));
    fund(state, 'A');
    state.priorityPlayer = 'A';
    state = act(state, { kind: 'castSpell', player: 'A', instanceId: burn, targets: [bear.id] }, reg);
    state = answerCast(state, reg, { kind: 'chooseNumber', value: 3 });

    const counter = place(state, 'B', 'hand', poolCard('Counterspell'));
    fund(state, 'B');
    state.priorityPlayer = 'B';
    state = act(state, { kind: 'castSpell', player: 'B', instanceId: counter, targets: [burn] }, reg);
    state = settle(state, reg);

    expect(isOnBattlefield(state, bear.id)).toBe(true);
    expect(onBattlefield(state, bear.id).damageMarked).toBe(0);
    expect(state.players.A.graveyard.map((c) => c.instanceId)).toContain(burn);
  });
});

describe('CELL: modal casting x the legal-action menu', () => {
  it('the engine offers a modal cast with NO pre-chosen target, because the modes are asked first', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const bear = resolvePermanent(state, reg, BEAR, 'B');
    state = bear.state;
    const cryptic = place(state, 'A', 'hand', poolCard('Cryptic Command'));
    fund(state, 'A');
    state.priorityPlayer = 'A';

    const offers = legal(state).filter((a) => a.kind === 'castSpell' && a.instanceId === cryptic);
    // ONE offer, not one per target: a modal spell's targets belong to its modes,
    // and enumerating them here would ask the question in the wrong order.
    expect(offers).toHaveLength(1);
    expect((offers[0] as Extract<GameAction, { kind: 'castSpell' }>).targets).toBeUndefined();
    expect(modalSpecOf(poolCard('Cryptic Command'))).toBeDefined();
  });
});

