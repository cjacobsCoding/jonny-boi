/**
 * INTERACTION MATRIX - characteristic-defining P/T x counters x anthems x
 * until-end-of-turn pumps x indestructible x the state-based actions.
 *
 * This is the CR 613 layer-order block. Each of these systems was built and
 * tested alone, and each alone produces a plausible number; the only way to catch
 * a layering mistake is to put THREE of them on ONE creature and read the total.
 *
 * The specific trap this file is aimed at: a characteristic-defining base
 * (`AggregatedMod.basePower`, CR 613.3 layer 7a) REPLACES the printed box, while
 * counters (7d) and pumps (7c) ADD to whatever the base turned out to be. Fold
 * them in the wrong order - or read a bare `effectivePower(inst)` with no
 * aggregate at all - and a Tarmogoyf with a counter under an anthem reads 0, 1 or
 * some other number that looks like a real creature.
 *
 * Every board here is a real game and every permanent is cast through the engine:
 * a hand-built `CardInstance` carries its own `counters: {}` and so cannot expose
 * the shared-frozen-record class of bug (`harness.ts` module header).
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateFor,
  effectivePower,
  effectiveToughness,
  indexContinuous,
  MINUS_ONE_COUNTER,
  NO_MOD,
  PLUS_ONE_COUNTER,
  type CardDefinition,
  type GameState,
  type InstanceId,
} from '@jonny-boi/core';
import { buildRegistry } from '../pool.js';
import {
  act,
  boardAtMain,
  castCard,
  fund,
  isOnBattlefield,
  onBattlefield,
  place,
  poolCard,
  resolvePermanent,
  settle,
  type Registry,
} from './harness.js';

/** A 2/2 body, cast through the engine wherever a plain creature is wanted. */
const BEAR: CardDefinition = {
  id: 'matrix-layers-bear',
  name: 'Matrix Layers Bear',
  types: ['creature'],
  cost: { generic: 2 },
  power: 2,
  toughness: 2,
};

/** "Put N +1/+1 counters on target creature" - the REAL registered primitive. */
function counterSpell(id: string, amount: number): CardDefinition {
  return {
    id,
    name: id,
    types: ['sorcery'],
    timing: 'sorcery',
    cost: { generic: 1 },
    effects: [{ primitive: 'addCounters', params: { amount, targets: 'creature' } }],
  };
}

/** The effective P/T of a permanent, read the way every RULES path reads it. */
function statsOf(state: GameState, id: InstanceId): { power: number; toughness: number } {
  const inst = onBattlefield(state, id);
  const mod = indexContinuous(state).get(id) ?? NO_MOD;
  return { power: effectivePower(inst, mod), toughness: effectiveToughness(inst, mod) };
}

describe('CELL: characteristic-defining P/T x counters x anthem x until-EOT pump (CR 613)', () => {
  it('Tarmogoyf under all four layers reads the sum, in the printed order', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);

    // Layer 7a: the star box counts CARD TYPES among all graveyards. Two types
    // in, so the printed body is 2/3 before anything else touches it.
    place(state, 'A', 'graveyard', poolCard('Lightning Bolt')); // instant
    place(state, 'B', 'graveyard', poolCard('Island')); // land - and the OTHER graveyard
    const goyf = resolvePermanent(state, reg, poolCard('Tarmogoyf'), 'A');
    state = goyf.state;
    expect(statsOf(state, goyf.id)).toEqual({ power: 2, toughness: 3 });

    // + layer 7d: a +1/+1 counter, put on by a real spell resolving. That SORCERY
    // is itself a card and it lands in the graveyard, so the formula base grows to
    // 3 in the same breath. This is the cell, not a nuisance: a base frozen at
    // cast time, or cached anywhere, would report 4/5 here.
    state = castCard(state, reg, counterSpell('matrix-plus-two', 2), 'A', [goyf.id]).state;
    expect(onBattlefield(state, goyf.id).counters[PLUS_ONE_COUNTER]).toBe(2);
    expect(statsOf(state, goyf.id)).toEqual({ power: 5, toughness: 6 });

    // + layer 7c (static): Benalish Marshal gives OTHER creatures you control
    // +1/+1. It is a PERMANENT, so no new card type reaches a graveyard.
    const marshal = resolvePermanent(state, reg, poolCard('Benalish Marshal'), 'A');
    state = marshal.state;
    expect(statsOf(state, goyf.id)).toEqual({ power: 6, toughness: 7 });

    // + layer 7c (until end of turn): Giant Growth, an instant - a type already
    // counted, so this really is +3/+3 and nothing else.
    state = castCard(state, reg, poolCard('Giant Growth'), 'A', [goyf.id]).state;
    expect(statsOf(state, goyf.id)).toEqual({ power: 9, toughness: 10 });

    // ...and the base is still a FORMULA, not a frozen number: a fourth card type
    // reaching a graveyard grows the whole stack by one.
    place(state, 'A', 'graveyard', BEAR); // creature - the fourth type
    expect(statsOf(state, goyf.id)).toEqual({ power: 10, toughness: 11 });
  });

  it('the bare accessor answers 0 for a star box - which is why every rules path passes an aggregate', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    place(state, 'A', 'graveyard', poolCard('Lightning Bolt'));
    const goyf = resolvePermanent(state, reg, poolCard('Tarmogoyf'), 'A');
    state = goyf.state;

    // The documented limit of the no-argument call, pinned so nobody "fixes" the
    // accessor instead of the caller: with no aggregate there is no formula value.
    expect(effectivePower(onBattlefield(state, goyf.id))).toBe(0);
    // With the single-instance aggregate it is right, and it agrees with the bulk
    // index - the two accessors reporting different numbers for the same board is
    // a bug this repo has already shipped once (emblem anthems).
    const single = aggregateFor(state, goyf.id);
    expect(effectivePower(onBattlefield(state, goyf.id), single)).toBe(1);
    expect(statsOf(state, goyf.id).power).toBe(1);
  });

  it('a star box that SHRINKS below its damage is dead before anybody gets priority (CR 704.3)', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    place(state, 'A', 'graveyard', poolCard('Lightning Bolt'));
    place(state, 'A', 'graveyard', poolCard('Island'));
    place(state, 'A', 'graveyard', BEAR);
    const goyf = resolvePermanent(state, reg, poolCard('Tarmogoyf'), 'A');
    state = goyf.state;
    expect(statsOf(state, goyf.id)).toEqual({ power: 3, toughness: 4 });

    // Three damage is not lethal to a 3/4 ...
    state = boltAt(state, reg, goyf.id, 'B');
    expect(isOnBattlefield(state, goyf.id)).toBe(true);
    expect(onBattlefield(state, goyf.id).damageMarked).toBe(3);

    // ...until the graveyards shrink. A card LEAVING a graveyard takes a card type
    // away, and CR 704.3 says the game checks state-based actions whenever a
    // player WOULD RECEIVE PRIORITY - so the now-2/3 body with 3 damage marked on
    // it must be in a graveyard before anybody acts again.
    const grave = state.players.A.graveyard;
    state.players.A.graveyard = grave.filter((c) => c.def.id !== BEAR.id);
    expect(statsOf(state, goyf.id)).toEqual({ power: 2, toughness: 3 });
    state = passOnce(state, reg);

    // ⚑ This cell was a recorded GAP: `onPassPriority` never called
    // `checkStateBasedActions`, so a board that became illegal without a
    // RESOLUTION behind it stayed illegal and this creature stood there with
    // lethal damage on it until something else happened to run the check.
    //
    // `onPassPriority` now runs the check (behind the cheap
    // `stateBasedActionsPossible` gate), which is what CR 704.3 asks for: the
    // game looks whenever a player WOULD receive priority, however the board got
    // into that state. Note the shrink here is caused by writing on the
    // graveyard directly — no cast, no resolution, no mutation site — which is
    // precisely why only the boundary can catch it.
    expect(isOnBattlefield(state, goyf.id)).toBe(false);
    expect(state.players.A.graveyard.some((c) => c.instanceId === goyf.id)).toBe(true);
  });
});

describe('CELL: +1/+1 counters x -1/-1 counters (CR 704.5q annihilation)', () => {
  it('the two kinds annihilate in pairs on an ENGINE-created permanent', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const bear = resolvePermanent(state, reg, BEAR, 'A');
    state = bear.state;

    state = castCard(state, reg, counterSpell('matrix-plus-three', 3), 'A', [bear.id]).state;
    expect(onBattlefield(state, bear.id).counters[PLUS_ONE_COUNTER]).toBe(3);

    state = castCard(state, reg, counterSpell('matrix-minus-two', -2), 'A', [bear.id]).state;
    const counters = onBattlefield(state, bear.id).counters;
    // Not "net +1 stored as +1/+1 = 1": ONE +1/+1 counter and NO -1/-1 counters,
    // so "does it have a -1/-1 counter on it?" answers honestly.
    expect(counters[PLUS_ONE_COUNTER]).toBe(1);
    expect(counters[MINUS_ONE_COUNTER] ?? 0).toBe(0);
    expect(statsOf(state, bear.id)).toEqual({ power: 3, toughness: 3 });
  });

  it('annihilates counters that arrived by a route the counters primitive never touched', () => {
    // ⚑ This cell was a GAP PIN — "annihilation is done by the counters
    // PRIMITIVE, not by a state-based action" — and it is now a positive test.
    // CR 704.5q IS a state-based action, so it lives in the SBA pass
    // (`internal/sba.ts`), where it applies to counters however they arrived
    // rather than only to the ones `putCountersOn` put there. The primitive no
    // longer annihilates at all; there is one implementation of the rule.
    //
    // The second route below is the one persist actually takes (it returns a
    // creature carrying a -1/-1 counter without going through `addCounters`),
    // and the one any future -1/-1 ETB replacement or proliferate will take.
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const bear = resolvePermanent(state, reg, BEAR, 'A');
    state = bear.state;
    state = castCard(state, reg, counterSpell('matrix-plus-one-a', 1), 'A', [bear.id]).state;

    // A second route: counters written straight onto the instance, as persist and
    // any future replacement effect or non-`addCounters` primitive does.
    const inst = onBattlefield(state, bear.id);
    inst.counters = { ...inst.counters, [MINUS_ONE_COUNTER]: 1 };
    state = settle(passOnce(state, reg), reg);

    // The pair is GONE, so "does it have a -1/-1 counter on it?" — persist's own
    // printed condition — answers honestly. The net P/T never moved, which is
    // exactly why this hid for so long.
    expect(onBattlefield(state, bear.id).counters[PLUS_ONE_COUNTER] ?? 0).toBe(0);
    expect(onBattlefield(state, bear.id).counters[MINUS_ONE_COUNTER] ?? 0).toBe(0);
    expect(statsOf(state, bear.id)).toEqual({ power: 2, toughness: 2 });
  });
});

describe('CELL: indestructible x counters x anthems x the two death SBAs', () => {
  it('an indestructible creature survives lethal damage but dies to counters that zero its toughness', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    // Zetalpa is a real printed indestructible 4/8 (and legendary, which the
    // legend-rule file leans on separately).
    const zetalpa = resolvePermanent(state, reg, poolCard('Zetalpa, Primal Dawn'), 'A');
    state = zetalpa.state;

    // CR 704.5g - lethal marked damage is DESTRUCTION, and 702.12b exempts it.
    for (let i = 0; i < 3; i++) state = boltAt(state, reg, zetalpa.id, 'B');
    expect(onBattlefield(state, zetalpa.id).damageMarked).toBe(9);
    expect(isOnBattlefield(state, zetalpa.id)).toBe(true);

    // CR 704.5f - toughness 0 is NOT destruction, so the keyword says nothing
    // about it. Eight -1/-1 counters take an 8-toughness body to zero.
    state = castCard(state, reg, counterSpell('matrix-minus-eight', -8), 'A', [zetalpa.id]).state;
    state = settle(state, reg);
    expect(isOnBattlefield(state, zetalpa.id)).toBe(false);
  });

  it('an anthem propping a creature up is a derived lifetime: killing the lord kills the team', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const bear = resolvePermanent(state, reg, BEAR, 'A');
    state = bear.state;
    const marshal = resolvePermanent(state, reg, poolCard('Benalish Marshal'), 'A');
    state = marshal.state;
    expect(statsOf(state, bear.id)).toEqual({ power: 3, toughness: 3 });

    // Two damage is survivable at 3 toughness ...
    state = shockAt(state, reg, bear.id, 'B');
    expect(isOnBattlefield(state, bear.id)).toBe(true);
    expect(onBattlefield(state, bear.id).damageMarked).toBe(2);

    // ... and lethal the instant the anthem leaves, with the damage still marked.
    // Nothing EXPIRES here: the static's lifetime is derived from the battlefield,
    // so the SBA pass at the end of the Marshal's own removal spell already reads
    // 2 toughness. (This cell works precisely because the anthem dies DURING a
    // resolution - contrast the `sba-on-priority` GAP above.)
    state = boltAt(state, reg, marshal.id, 'B');
    expect(isOnBattlefield(state, marshal.id)).toBe(false);
    expect(isOnBattlefield(state, bear.id)).toBe(false);
  });
});

// --- shared drivers ---------------------------------------------------------------

/** Lightning Bolt from `caster`'s hand at a permanent, resolved. */
function boltAt(state: GameState, reg: Registry, target: InstanceId, caster: 'A' | 'B'): GameState {
  const bolt = place(state, caster, 'hand', poolCard('Lightning Bolt'));
  fund(state, caster);
  const before = state.priorityPlayer;
  state.priorityPlayer = caster;
  let next = act(state, { kind: 'castSpell', player: caster, instanceId: bolt, targets: [target] }, reg);
  next = settle(next, reg);
  if (!next.pendingChoice) next.priorityPlayer = before;
  return next;
}

/** Shock (2 damage) from `caster`'s hand at a permanent, resolved. */
function shockAt(state: GameState, reg: Registry, target: InstanceId, caster: 'A' | 'B'): GameState {
  const shock = place(state, caster, 'hand', poolCard('Shock'));
  fund(state, caster);
  const before = state.priorityPlayer;
  state.priorityPlayer = caster;
  let next = act(state, { kind: 'castSpell', player: caster, instanceId: shock, targets: [target] }, reg);
  next = settle(next, reg);
  if (!next.pendingChoice) next.priorityPlayer = before;
  return next;
}

/** One priority pass - the moment CR 704.3 says state-based actions are checked. */
function passOnce(state: GameState, reg: Registry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}
