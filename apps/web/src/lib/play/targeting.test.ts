/**
 * The UI's targeting inference must agree with what the ENGINE will accept.
 *
 * Core enforces a card's declared `targets` restriction at cast time, so a UI that
 * offered a wider set would walk the player into a rejected cast — click the only
 * target the UI shows, get refused, with no way forward. These tests pin the
 * agreement for the cards that made the restriction necessary.
 */
import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, PlayerId } from '@jonny-boi/core';
import { legalTargets, needsTarget, targetRequirement, type TargetableView } from './targeting.js';

/** A burn spell whose damage is narrowed by the reserved `targets` param. */
function burn(id: string, targets?: string): CardDefinition {
  return {
    id,
    name: id,
    types: ['instant'],
    cost: { R: 1 },
    effects: [{ primitive: 'dealDamage', params: targets ? { amount: 3, targets } : { amount: 3 } }],
  };
}

describe('targetRequirement honours a declared restriction', () => {
  it('Lightning-Bolt-shaped damage with no restriction stays "any"', () => {
    expect(targetRequirement(burn('bolt'))).toEqual({ count: 1, kind: 'any' });
  });

  it('Lava-Spike-shaped damage is player-only (the UI must not offer a creature)', () => {
    expect(targetRequirement(burn('lava-spike', 'player'))).toEqual({ count: 1, kind: 'player' });
  });

  it('Flame-Slash-shaped damage is creature-only (the UI must not offer a face)', () => {
    expect(targetRequirement(burn('flame-slash', 'creature'))).toEqual({ count: 1, kind: 'creature' });
  });

  it('an explicit "any" restriction is still any', () => {
    expect(targetRequirement(burn('shock', 'any'))).toEqual({ count: 1, kind: 'any' });
  });

  it('a nonsense restriction falls back to the primitive default rather than throwing', () => {
    expect(targetRequirement(burn('weird', 'banana'))).toEqual({ count: 1, kind: 'any' });
  });

  it('all of these still need a target', () => {
    for (const t of [undefined, 'player', 'creature', 'any']) {
      expect(needsTarget(burn('x', t))).toBe(true);
    }
  });

  it('the compound planeswalker restrictions are honoured, not flattened', () => {
    expect(targetRequirement(burn('spike', 'playerOrPlaneswalker'))).toEqual({
      count: 1,
      kind: 'playerOrPlaneswalker',
    });
    expect(targetRequirement(burn('slash', 'creatureOrPlaneswalker'))).toEqual({
      count: 1,
      kind: 'creatureOrPlaneswalker',
    });
  });
});

// --- planeswalkers as legal targets ---------------------------------------------

const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };

/** A minimal battlefield instance for target enumeration (pure data, no engine). */
function permanent(instanceId: number, def: CardDefinition, controller: PlayerId): CardInstance {
  return {
    instanceId,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  };
}

const BEAR: CardDefinition = { id: 'bear', name: 'Bear', types: ['creature'], power: 2, toughness: 2 };
const WALKER: CardDefinition = { id: 'lili', name: 'Liliana', types: ['planeswalker'], loyalty: 3 };

function board(): TargetableView {
  return { battlefield: [permanent(1, BEAR, 'A'), permanent(2, WALKER, 'B')], stack: [] };
}

describe('legalTargets includes planeswalkers where core says they are legal', () => {
  it('"any target" offers the creature, BOTH players, and the walker', () => {
    const options = legalTargets({ count: 1, kind: 'any' }, board(), NAMES);
    expect(options).toContainEqual({ kind: 'creature', instanceId: 1, name: 'Bear', controller: 'A' });
    expect(options).toContainEqual({ kind: 'planeswalker', instanceId: 2, name: 'Liliana', controller: 'B' });
    expect(options.filter((o) => o.kind === 'player')).toHaveLength(2);
  });

  it('"target creature" never offers a walker', () => {
    const options = legalTargets({ count: 1, kind: 'creature' }, board(), NAMES);
    expect(options.some((o) => o.kind === 'planeswalker')).toBe(false);
    expect(options).toHaveLength(1);
  });

  it('"player or planeswalker" offers the players and the walker, never the creature', () => {
    const options = legalTargets({ count: 1, kind: 'playerOrPlaneswalker' }, board(), NAMES);
    expect(options.some((o) => o.kind === 'creature')).toBe(false);
    expect(options).toContainEqual({ kind: 'planeswalker', instanceId: 2, name: 'Liliana', controller: 'B' });
    expect(options.filter((o) => o.kind === 'player')).toHaveLength(2);
  });

  it('"creature or planeswalker" offers both permanents, never a face', () => {
    const options = legalTargets({ count: 1, kind: 'creatureOrPlaneswalker' }, board(), NAMES);
    expect(options.some((o) => o.kind === 'player')).toBe(false);
    expect(options.map((o) => (o.kind === 'player' ? o.player : o.instanceId)).sort()).toEqual([1, 2]);
  });
});
