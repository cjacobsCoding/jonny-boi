/**
 * INTERACTION MATRIX - transforming DFCs x counters x attachments x damage x the
 * legend rule x triggers x zone changes.
 *
 * CR 712.8 is the whole file: **transforming is NOT a zone change.** A new
 * object would lose its counters, drop its Auras, forget its damage and untap;
 * a transformed permanent keeps every one of them and fires no ETB or dies
 * trigger. Every system that keys on a permanent's identity therefore meets
 * transform, and every one of them can get it wrong in the same direction at
 * once - which is why they are tested together on ONE permanent rather than
 * four times over.
 *
 * The other half is that `CardInstance.def` IS the active face, so the ACTIVE
 * face's name, types, P/T, keywords, triggers and legendary flag are what every
 * consumer reads. A rule that cached the printed face would keep the front's
 * answer forever, and the legend rule is where that shows up first.
 *
 * Delver of Secrets is the real shipped DFC; the legendary back face has no
 * printed representative in the pool, so that one card is authored.
 */

import { describe, expect, it } from 'vitest';
import {
  effectivePower,
  faceUpOf,
  indexContinuous,
  NO_MOD,
  PLUS_ONE_COUNTER,
  transformPermanent,
  type CardDefinition,
  type GameEvent,
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
  legal,
  onBattlefield,
  place,
  poolCard,
  putOnTop,
  rejectionOf,
  resolvePermanent,
  settle,
  type Registry,
} from './harness.js';

/** A legendary DFC - no printed one compiles into the pool, so it is authored. */
const LEGENDARY_DFC: CardDefinition = {
  id: 'matrix-legend-dfc',
  name: 'Matrix Squire',
  types: ['creature'],
  cost: { generic: 1 },
  power: 1,
  toughness: 1,
  backFace: {
    id: 'matrix-legend-dfc#back',
    name: 'Matrix Champion',
    isBackFace: true,
    legendary: true,
    types: ['creature'],
    power: 3,
    toughness: 3,
    keywords: { flying: true },
  },
};

/** A creature that counts entries onto the battlefield - the ETB-trigger probe. */
const WATCHER: CardDefinition = {
  id: 'matrix-watcher',
  name: 'Matrix Watcher',
  types: ['creature'],
  cost: { generic: 2 },
  power: 1,
  toughness: 3,
  triggers: [
    {
      condition: { on: 'permanentEnters', who: 'any' },
      effects: [{ primitive: 'addCounters', params: { amount: 1, self: true } }],
      label: 'Whenever a permanent enters, put a +1/+1 counter on this',
    },
  ],
};

/** "Put N +1/+1 counters on target creature" - the real registered primitive. */
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

function powerOf(state: GameState, id: InstanceId): number {
  return effectivePower(onBattlefield(state, id), indexContinuous(state).get(id) ?? NO_MOD);
}

describe('CELL: transform x counters x attachments x damage x tapped state (CR 712.8)', () => {
  it('a flip carries EVERYTHING across, because it is not a zone change', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const delver = resolvePermanent(state, reg, poolCard('Delver of Secrets'), 'A');
    state = delver.state;

    // Load the permanent up: a counter, an Equipment, marked damage, and tapped.
    state = castCard(state, reg, counterSpell('matrix-flip-counter', 2), 'A', [delver.id]).state;
    const splitter = resolvePermanent(state, reg, poolCard('Bonesplitter'), 'A');
    state = splitter.state;
    state = equip(state, reg, splitter.id, delver.id);
    onBattlefield(state, delver.id).damageMarked = 1;
    onBattlefield(state, delver.id).tapped = true;

    // 1 printed + 2 counters + 2 from the Equipment.
    expect(powerOf(state, delver.id)).toBe(5);

    const events: GameEvent[] = [];
    transformPermanent(state, delver.id, (e) => events.push(e));

    const flipped = onBattlefield(state, delver.id);
    expect(flipped.def.name).toBe('Insectile Aberration');
    expect(faceUpOf(flipped)).toBe('back');
    // Everything survived: counters, the Equipment, the damage, the tap.
    expect(flipped.counters[PLUS_ONE_COUNTER]).toBe(2);
    expect(onBattlefield(state, splitter.id).attachedTo).toBe(delver.id);
    expect(flipped.damageMarked).toBe(1);
    expect(flipped.tapped).toBe(true);
    // 3 printed on the back + 2 counters + 2 Equipment.
    expect(powerOf(state, delver.id)).toBe(7);

    // NO zone change is emitted, which is what stops an ETB/dies trigger firing.
    expect(events.map((e) => e.type)).toEqual(['transformed']);
  });

  it('an ETB watcher does NOT fire when a permanent transforms', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const watcher = resolvePermanent(state, reg, WATCHER, 'A');
    state = watcher.state;
    const delver = resolvePermanent(state, reg, poolCard('Delver of Secrets'), 'A');
    state = settle(delver.state, reg);
    // The Delver's own ENTRY did fire it - the control that proves the watcher works.
    const afterEntry = onBattlefield(state, watcher.id).counters[PLUS_ONE_COUNTER] ?? 0;
    expect(afterEntry).toBeGreaterThan(0);

    transformPermanent(state, delver.id, () => {});
    state = settle(state, reg);
    expect(onBattlefield(state, watcher.id).counters[PLUS_ONE_COUNTER] ?? 0).toBe(afterEntry);
  });

  it('the ACTIVE face is what triggers: a flipped Delver stops watching its own upkeep', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const delver = resolvePermanent(state, reg, poolCard('Delver of Secrets'), 'A');
    state = delver.state;
    expect(onBattlefield(state, delver.id).def.triggers).toHaveLength(1);

    transformPermanent(state, delver.id, () => {});
    // The back face prints no trigger at all, so the collector must stop finding
    // one - it re-reads the ACTIVE face's list rather than the printed card's.
    expect(onBattlefield(state, delver.id).def.triggers ?? []).toHaveLength(0);
  });
});

describe('CELL: transform x the upkeep trigger, end to end in a real game', () => {
  it('Delver flips on its own upkeep when the revealed top card is an instant', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const delver = resolvePermanent(state, reg, poolCard('Delver of Secrets'), 'A');
    state = delver.state;

    // Play round to A's NEXT upkeep, with an instant waiting on top.
    state = passUntilOwnUpkeep(state, reg, 'A');
    putOnTop(state, 'A', poolCard('Lightning Bolt'));
    state = settle(state, reg);

    // The look/reveal is ONE min:0 max:1 question - revealing is choosing.
    expect(state.pendingChoice?.kind).toBe('selectCards');
    const candidates = (state.pendingChoice as { candidates: readonly { instanceId: InstanceId }[] })
      .candidates;
    expect(candidates).toHaveLength(1);
    state = act(
      state,
      {
        kind: 'answerChoice',
        player: 'A',
        choiceId: state.pendingChoice!.id,
        answer: { kind: 'selectCards', instanceIds: [candidates[0]!.instanceId] },
      },
      reg,
    );
    state = settle(state, reg);

    expect(onBattlefield(state, delver.id).def.name).toBe('Insectile Aberration');
  });
});

describe('CELL: transform x the legend rule x leaving the battlefield', () => {
  it('the legend rule reads the ACTIVE face’s name, so a flip can create the duplicate', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const a = resolvePermanent(state, reg, LEGENDARY_DFC, 'A');
    state = a.state;
    const b = resolvePermanent(state, reg, LEGENDARY_DFC, 'A');
    state = b.state;
    // Two FRONT faces, neither legendary: no rule applies.
    expect(state.pendingChoice ?? null).toBeNull();

    // One flip: still one legendary "Matrix Champion", so still nothing.
    transformPermanent(state, a.id, () => {});
    state = settle(passOnce(state, reg), reg);
    expect(state.pendingChoice ?? null).toBeNull();
    expect(isOnBattlefield(state, a.id)).toBe(true);
    expect(isOnBattlefield(state, b.id)).toBe(true);

    // The SECOND flip creates two legendary permanents with the same name. The
    // rule is a state-based action, so it needs an SBA check to notice - which
    // the next resolution provides.
    transformPermanent(state, b.id, () => {});
    state = castCard(state, reg, poolCard('Shock'), 'A', ['B']).state;
    expect(state.pendingChoice?.context).toBe('legendRule');
    state = act(
      state,
      {
        kind: 'answerChoice',
        player: 'A',
        choiceId: state.pendingChoice!.id,
        answer: { kind: 'selectCards', instanceIds: [a.id] },
      },
      reg,
    );
    expect(isOnBattlefield(state, a.id)).toBe(true);
    expect(isOnBattlefield(state, b.id)).toBe(false);

    // CR 712.8a - a permanent that leaves for a hidden zone turns front-face up,
    // so the card in the graveyard is the SQUIRE, not the Champion.
    const buried = state.players.A.graveyard.find((c) => c.instanceId === b.id);
    expect(buried?.def.name).toBe('Matrix Squire');
  });

  it('a back face is never castable (CR 712.8b) - not offered, AND refused when built by hand', () => {
    const reg = buildRegistry();
    const state = boardAtMain(reg);
    const backOnly = { ...LEGENDARY_DFC.backFace } as CardDefinition;
    const back = place(state, 'A', 'hand', backOnly);
    // A control in the same hand, so "nothing is castable" cannot pass this.
    const front = place(state, 'A', 'hand', LEGENDARY_DFC);
    fund(state, 'A');

    const offers = legal(state).filter((a) => a.kind === 'castSpell');
    expect(offers.map((a) => (a as { instanceId: InstanceId }).instanceId)).toContain(front);
    expect(offers.map((a) => (a as { instanceId: InstanceId }).instanceId)).not.toContain(back);

    // The menu is only half of it: a pilot or a UI that builds the action itself
    // must be refused too, or the guard is decoration.
    expect(rejectionOf(state, { kind: 'castSpell', player: 'A', instanceId: back }, reg)).toBeDefined();
    expect(rejectionOf(state, { kind: 'castSpell', player: 'A', instanceId: front }, reg)).toBeUndefined();
  });
});

// --- shared drivers ---------------------------------------------------------------

function equip(state: GameState, reg: Registry, equipment: InstanceId, host: InstanceId): GameState {
  fund(state, onBattlefield(state, equipment).controller);
  const ability = legal(state).find(
    (a) => a.kind === 'activateAbility' && a.instanceId === equipment && a.targets?.[0] === host,
  );
  if (!ability) throw new Error('the engine offered no equip aimed at that host');
  return settle(act(state, ability, reg), reg);
}

function passOnce(state: GameState, reg: Registry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

/** How many priority passes a full round of the turn machine can need. */
const ROUND_TRIP_PASS_LIMIT = 200;

/** Advance until `player` is the active player in their own upkeep step. */
function passUntilOwnUpkeep(state: GameState, reg: Registry, player: 'A' | 'B'): GameState {
  let next = state;
  for (let i = 0; i < ROUND_TRIP_PASS_LIMIT; i++) {
    if (next.gameOver) throw new Error('the game ended before the upkeep arrived');
    if (next.pendingChoice) throw new Error('a choice parked while advancing to upkeep');
    if (next.activePlayer === player && next.step === 'upkeep' && next.turnNumber > state.turnNumber) {
      return next;
    }
    next = passOnce(next, reg);
  }
  throw new Error('never reached the upkeep');
}
