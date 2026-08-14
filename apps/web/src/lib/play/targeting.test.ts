/**
 * The UI's targeting inference must agree with what the ENGINE will accept.
 *
 * Core enforces a card's declared `targets` restriction at cast time, so a UI that
 * offered a wider set would walk the player into a rejected cast — click the only
 * target the UI shows, get refused, with no way forward. These tests pin the
 * agreement for the cards that made the restriction necessary.
 */
import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '@jonny-boi/core';
import { needsTarget, targetRequirement } from './targeting.js';

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
});
