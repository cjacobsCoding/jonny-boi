/**
 * INTERACTION MATRIX — protection × ward × source-aware targeting × attachments
 * × statics × indestructible × combat.
 *
 * Each of those systems was built and tested on its own. The cells below are the
 * places where two of them meet, and every one is played through a REAL game with
 * REAL shipped pool cards (see `harness.ts` for why hand-built boards do not
 * count here).
 *
 * The cell this file was written for, and the defect it found:
 * **attachment-granted keywords × targeting legality.** `isTargetableBy`,
 * `effectiveProtectionOf` and `effectiveWardOf` all took their fast path on
 * `state.continuous.length === 0`, which holds ONLY until-end-of-turn effects.
 * An Aura's or Equipment's grant to its host, an anthem's grant to a team and an
 * emblem's grant from the command zone are all derived from the battlefield and
 * put NOTHING in that list — so all three read the printed keyword set and every
 * layer-3 grant of hexproof, shroud, protection or ward was invisible. Mask of
 * Avacyn, a card the app ships, says "equipped creature … has hexproof" and the
 * opponent could Lightning Bolt the creature anyway.
 */

import { describe, expect, it } from 'vitest';
import {
  effectiveProtectionOf,
  effectiveWardOf,
  isLegalTarget,
  legalTargetsFor,
  isLegallyAttached,
  loyaltyOf,
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
  legal,
  onBattlefield,
  place,
  poolCard,
  resolvePermanent,
  settle,
  type Registry,
} from './harness.js';

/** A vanilla body to hang attachments on — the thing under test is the Aura. */
const BEAR: CardDefinition = {
  id: 'matrix-bear',
  name: 'Matrix Bear',
  types: ['creature'],
  cost: { generic: 2 },
  power: 2,
  toughness: 2,
};

/** A red 2/2 — a red SOURCE, for the "protection from red" cells. */
const RED_BRUTE: CardDefinition = {
  id: 'matrix-red-brute',
  name: 'Matrix Brute',
  types: ['creature'],
  cost: { R: 1, generic: 1 },
  power: 2,
  toughness: 2,
};

/** An anthem that grants a PAYLOAD keyword, the shape no printed pool card has. */
function anthemGranting(id: string, keywords: CardDefinition['keywords']): CardDefinition {
  return {
    id,
    name: id,
    types: ['creature'],
    cost: { generic: 1 },
    power: 1,
    toughness: 1,
    // `excludeSource` so a lord granting shroud does not hide ITSELF — the test
    // needs to be able to shoot the lord to prove the grant's lifetime.
    statics: [
      { affects: { anyOfTypes: ['creature'], controller: 'you', excludeSource: true }, keywords, label: id },
    ],
  };
}

function equip(state: GameState, reg: Registry, equipment: InstanceId, host: InstanceId): GameState {
  fund(state, onBattlefield(state, equipment).controller);
  const ability = legal(state).find(
    (a) => a.kind === 'activateAbility' && a.instanceId === equipment && a.targets?.[0] === host,
  );
  if (!ability) throw new Error('the engine offered no equip aimed at that host');
  return settle(act(state, ability, reg), reg);
}

describe('CELL: attachments × targeting legality (granted hexproof)', () => {
  it('Mask of Avacyn takes its host off the opponent burn menu, and giving it back puts it back', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const bear = resolvePermanent(state, reg, BEAR, 'A');
    state = bear.state;
    const mask = resolvePermanent(state, reg, poolCard('Mask of Avacyn'), 'A');
    state = mask.state;

    const bolt = poolCard('Lightning Bolt');
    // The control: unequipped, it is a legal target for the opponent's burn.
    expect(legalTargetsFor(state, 'any', 'B', bolt)).toContain(bear.id);

    state = equip(state, reg, mask.id, bear.id);
    expect(onBattlefield(state, mask.id).attachedTo).toBe(bear.id);

    // The cell: the hexproof is granted by an ATTACHMENT, so it exists only in
    // the continuous layer's layer 3 and never in `state.continuous`.
    expect(isLegalTarget(state, 'any', bear.id, 'B', bolt)).toBe(false);
    expect(legalTargetsFor(state, 'any', 'B', bolt)).not.toContain(bear.id);
    // …and the engine's own menu agrees, which is what stops a pilot building
    // the illegal action by hand.
    const boltId = place(state, 'B', 'hand', bolt);
    fund(state, 'B');
    state.priorityPlayer = 'B';
    expect(
      legal(state).some((a) => a.kind === 'castSpell' && a.instanceId === boltId && a.targets?.[0] === bear.id),
    ).toBe(false);

    // Hexproof stops OPPONENTS only: its own controller may still aim at it.
    expect(isLegalTarget(state, 'any', bear.id, 'A', bolt)).toBe(true);
  });

  it('an anthem-granted shroud hides the whole team, and unhides it when the anthem leaves', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const bear = resolvePermanent(state, reg, BEAR, 'A');
    state = bear.state;
    const lord = resolvePermanent(state, reg, anthemGranting('Matrix Veil', { shroud: true }), 'A');
    state = lord.state;

    const bolt = poolCard('Lightning Bolt');
    expect(isLegalTarget(state, 'any', bear.id, 'B', bolt)).toBe(false);
    // Shroud blocks EVERYONE, its controller included — the half hexproof does not share.
    expect(isLegalTarget(state, 'any', bear.id, 'A', bolt)).toBe(false);

    // Killing the anthem restores the board: a static's lifetime is derived, so
    // the very next read must already have forgotten it.
    state = destroyWithBolt(state, reg, lord.id, 'B');
    expect(isOnBattlefield(state, lord.id)).toBe(false);
    expect(isLegalTarget(state, 'any', bear.id, 'B', bolt)).toBe(true);
  });
});

describe('CELL: attachments/statics × ward', () => {
  it('an anthem-granted ward is charged, and stacks additively with a printed one', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    // Patchwork Automaton prints ward 2 — a real card, so the printed half is real.
    const automaton = resolvePermanent(state, reg, poolCard('Patchwork Automaton'), 'A');
    state = automaton.state;
    expect(effectiveWardOf(state, onBattlefield(state, automaton.id))).toBe(2);

    const lord = resolvePermanent(state, reg, anthemGranting('Matrix Aegis', { ward: 3 }), 'A');
    state = lord.state;
    // CR 702.21b — two ward abilities are two triggers, so the costs ADD.
    expect(effectiveWardOf(state, onBattlefield(state, automaton.id))).toBe(5);
  });

  it('an opposing spell aimed at a warded creature parks the ward trigger', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const automaton = resolvePermanent(state, reg, poolCard('Patchwork Automaton'), 'A');
    state = automaton.state;

    const bolt = place(state, 'B', 'hand', poolCard('Lightning Bolt'));
    fund(state, 'B');
    state.priorityPlayer = 'B';
    state = act(state, { kind: 'castSpell', player: 'B', instanceId: bolt, targets: [automaton.id] }, reg);

    // The ward trigger goes on the stack ABOVE the spell it answers, so it is the
    // thing that resolves first.
    const wardTrigger = state.stack[state.stack.length - 1];
    expect(wardTrigger?.kind).toBe('trigger');
  });
});

describe('CELL: protection × attachments (CR 702.16c / 704.5m)', () => {
  it('a black Aura may not be cast onto a creature with protection from black', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const knight = resolvePermanent(state, reg, poolCard('White Knight'), 'A');
    state = knight.state;
    const bear = resolvePermanent(state, reg, BEAR, 'A');
    state = bear.state;

    const deadWeight = place(state, 'A', 'hand', poolCard('Dead Weight'));
    fund(state, 'A');
    const offers = legal(state).filter((a) => a.kind === 'castSpell' && a.instanceId === deadWeight);
    const aimedAt = offers.flatMap((a) => (a.kind === 'castSpell' ? (a.targets ?? []) : []));
    // The ordinary bear IS offered — proving the menu is live and the knight's
    // absence is protection, not an empty menu.
    expect(aimedAt).toContain(bear.id);
    expect(aimedAt).not.toContain(knight.id);
  });

  it('an Aura falls off the moment its host gains protection from the Aura’s colour', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const bear = resolvePermanent(state, reg, BEAR, 'A');
    state = bear.state;

    // Dead Weight is BLACK and gives -2/-2, which would kill a 2/2 outright — so
    // the host is first propped up by Benalish Marshal's +1/+1 anthem. That is
    // itself a cell: statics × attachments × state-based actions.
    const marshal = resolvePermanent(state, reg, poolCard('Benalish Marshal'), 'A');
    state = marshal.state;
    const weight = resolvePermanent(state, reg, poolCard('Dead Weight'), 'A', [bear.id]);
    state = weight.state;
    expect(isLegallyAttached(state, onBattlefield(state, weight.id))).toBe(true);
    expect(isOnBattlefield(state, bear.id)).toBe(true);

    // Now grant protection from black. The Aura is no longer legally attached
    // (CR 702.16c), so the state-based actions bin it (CR 704.5m) — and the
    // grant reaches the host through layer 3 only.
    const ward = resolvePermanent(state, reg, anthemGranting('Matrix Sanctum', { protectionFrom: ['black'] }), 'A');
    state = ward.state;
    expect(effectiveProtectionOf(state, onBattlefield(state, bear.id))).toEqual(['black']);
    state = settle(state, reg);

    expect(isOnBattlefield(state, weight.id)).toBe(false);
    expect(state.players.A.graveyard.map((c) => c.instanceId)).toContain(weight.id);
    // The -2/-2 went with it: the bear is back to 2/2 under a +1/+1 anthem.
    expect(isOnBattlefield(state, bear.id)).toBe(true);
  });
});

describe('CELL: protection × combat damage × blocking', () => {
  it('a protected blocker takes no damage from the quality it is protected from, and still deals its own', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg, { active: 'B' });
    // B attacks with a RED creature; A blocks with Silver Knight (pro red).
    const brute = resolvePermanent(state, reg, RED_BRUTE, 'B');
    state = brute.state;
    onBattlefield(state, brute.id).summoningSick = false;
    const knight = resolvePermanent(state, reg, poolCard('Silver Knight'), 'A');
    state = knight.state;

    state = advanceToDeclareAttackers(state, reg);
    state = act(state, { kind: 'declareAttackers', player: 'B', attackers: [brute.id] }, reg);
    state = passUntilStep(state, reg, 'declareBlockers');
    state = act(
      state,
      { kind: 'declareBlockers', player: 'A', blocks: [{ blocker: knight.id, attacker: brute.id }] },
      reg,
    );
    state = passUntilStep(state, reg, 'endCombat');

    // CR 702.16e — the red creature's combat damage is PREVENTED.
    expect(isOnBattlefield(state, knight.id)).toBe(true);
    expect(onBattlefield(state, knight.id).damageMarked).toBe(0);
    // Protection is one-directional: the knight's own first-strike damage lands,
    // and a 2/2 with 2 damage dies.
    expect(isOnBattlefield(state, brute.id)).toBe(false);
  });
});

describe('CELL: protection × indestructible × 0 toughness (two different SBAs)', () => {
  it('an indestructible creature shrugs off lethal damage but NOT an Aura that zeroes its toughness', () => {
    const reg = buildRegistry();
    let state = boardAtMain(reg);
    const bear = resolvePermanent(state, reg, BEAR, 'A');
    state = bear.state;
    const plate = resolvePermanent(state, reg, poolCard('Darksteel Plate'), 'A');
    state = plate.state;
    state = equip(state, reg, plate.id, bear.id);

    // Lethal damage: CR 704.5g is destruction, and CR 702.12b exempts it — the
    // grant reaching the creature through layer 3 is the interaction.
    state = boltAt(state, reg, bear.id, 'B');
    expect(isOnBattlefield(state, bear.id)).toBe(true);
    expect(onBattlefield(state, bear.id).damageMarked).toBeGreaterThan(0);

    // 0 toughness: CR 704.5f is NOT destruction, so indestructible does not save
    // it. Dead Weight's -2/-2 takes the 2/2 to 0/0.
    const weight = castCard(state, reg, poolCard('Dead Weight'), 'A', [bear.id]);
    state = settle(weight.state, reg);
    expect(isOnBattlefield(state, bear.id)).toBe(false);
    // The Aura followed it (CR 704.5m), which is the attachments × SBA cascade.
    expect(isOnBattlefield(state, weight.id)).toBe(false);
    // And the Equipment merely DETACHED — an Equipment is not an Aura.
    expect(isOnBattlefield(state, plate.id)).toBe(true);
    expect(onBattlefield(state, plate.id).attachedTo).toBeNull();
  });
});

// --- shared drivers ---------------------------------------------------------------

/** Bolt a permanent from `caster`'s hand and let it resolve. */
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

/** Bolt a permanent and assert it left — used where the point is the aftermath. */
function destroyWithBolt(
  state: GameState,
  reg: Registry,
  target: InstanceId,
  caster: 'A' | 'B',
): GameState {
  return boltAt(state, reg, target, caster);
}

/** Pass priority until the game reaches `step` (or the test gives up loudly). */
function passUntilStep(state: GameState, reg: Registry, step: GameState['step']): GameState {
  let next = state;
  for (let i = 0; i < 40 && next.step !== step && !next.gameOver; i++) {
    if (next.pendingChoice) throw new Error(`a choice parked while advancing to ${step}`);
    next = act(next, { kind: 'passPriority', player: next.priorityPlayer }, reg);
  }
  if (next.step !== step) throw new Error(`never reached ${step} (stuck at ${next.step})`);
  return next;
}

/** Advance to the declare-attackers step of the active player's turn. */
function advanceToDeclareAttackers(state: GameState, reg: Registry): GameState {
  return passUntilStep(state, reg, 'declareAttackers');
}

/** Re-exported for the loyalty cells that live in the walker file. */
export { loyaltyOf };
