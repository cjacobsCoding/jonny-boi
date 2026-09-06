/**
 * §3.131 — the pure event→visual-effect table. Pins the viewer-relative life
 * flash, the tile-vs-face split for damage, and the coalescing that keeps a
 * board wipe from strobing while still showing a poof per creature.
 */
import { describe, expect, it } from 'vitest';
import type { GameEvent, PlayerId } from '@jonny-boi/core';
import { deriveVfxCues, type VfxCue } from './vfx-cues.js';

const VIEWER: PlayerId = 'A';

function vfx(events: readonly GameEvent[], viewer: PlayerId = VIEWER, reducedMotion = false): VfxCue[] {
  return [...deriveVfxCues(events, { reducedMotion, startIndex: 0, viewer })];
}

describe('deriveVfxCues — the table', () => {
  it('your life swing flashes the screen; the sign picks the tone', () => {
    expect(vfx([{ type: 'lifeChanged', player: 'A', delta: 5, to: 25 }])).toMatchObject([
      { kind: 'flash', tone: 'gain', at: { where: 'screen' } },
    ]);
    expect(vfx([{ type: 'lifeChanged', player: 'A', delta: -4, to: 16 }])).toMatchObject([
      { kind: 'flash', tone: 'loss' },
    ]);
  });

  it("the OPPONENT's life change does not flash your screen", () => {
    expect(vfx([{ type: 'lifeChanged', player: 'B', delta: -4, to: 16 }])).toEqual([]);
    expect(vfx([{ type: 'lifeChanged', player: 'A', delta: 0, to: 20 }])).toEqual([]);
  });

  it('a cast flares at its caster’s board; a token at its controller’s', () => {
    expect(vfx([{ type: 'spellCast', player: 'B', instanceId: 1, name: 'x', castTypes: [] }])).toMatchObject([
      { kind: 'flare', tone: 'cast', at: { where: 'board', seat: 'B' } },
    ]);
    expect(vfx([{ type: 'tokenCreated', instanceId: 2, controller: 'A', name: 'Soldier' }])).toMatchObject([
      { kind: 'flare', tone: 'token', at: { where: 'board', seat: 'A' } },
    ]);
  });

  it('damage to a CREATURE bursts on the tile; damage to a face does not (the life flash covers it)', () => {
    expect(vfx([{ type: 'damageDealt', source: 1, target: 9, amount: 3, combat: true }])).toMatchObject([
      { kind: 'burst', tone: 'damage', at: { where: 'tile', instanceId: 9 } },
    ]);
    expect(vfx([{ type: 'damageDealt', source: 1, target: 'B', amount: 3, combat: false }])).toEqual([]);
  });

  it('a death bursts where the creature stood', () => {
    expect(vfx([{ type: 'creatureDied', instanceId: 7, name: 'Bear' }])).toMatchObject([
      { kind: 'burst', tone: 'death', at: { where: 'tile', instanceId: 7 } },
    ]);
  });

  it('a wrath shows one poof per creature (distinct tiles), a double life-loss just one flash', () => {
    const wrath: GameEvent[] = [
      { type: 'creatureDied', instanceId: 1, name: 'a' },
      { type: 'creatureDied', instanceId: 2, name: 'b' },
      { type: 'creatureDied', instanceId: 3, name: 'c' },
    ];
    expect(vfx(wrath).map((e) => (e.at.where === 'tile' ? e.at.instanceId : -1))).toEqual([1, 2, 3]);
    const doubleLoss: GameEvent[] = [
      { type: 'lifeChanged', player: 'A', delta: -2, to: 18 },
      { type: 'lifeChanged', player: 'A', delta: -2, to: 16 },
    ];
    expect(vfx(doubleLoss)).toHaveLength(1); // same place + tone ⇒ coalesced
  });

  it('reduced motion derives nothing at all', () => {
    expect(vfx([{ type: 'lifeChanged', player: 'A', delta: 5, to: 25 }], VIEWER, true)).toEqual([]);
  });

  it('keys are unique across a mixed batch', () => {
    const batch: GameEvent[] = [
      { type: 'lifeChanged', player: 'A', delta: -1, to: 19 },
      { type: 'spellCast', player: 'A', instanceId: 1, name: 'x', castTypes: [] },
      { type: 'creatureDied', instanceId: 2, name: 'y' },
    ];
    const keys = deriveVfxCues(batch, { reducedMotion: false, startIndex: 50, viewer: VIEWER }).map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
