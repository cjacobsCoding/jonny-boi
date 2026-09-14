/**
 * §3.131 — the pure event→visual-effect table. Pins the viewer-relative life
 * flash, the coalescing that keeps a board wipe from strobing while still
 * showing a poof per creature, and — since §3.143's UX-15 — the DELIBERATE
 * ABSENCE of a damage row: damage blooms from `damage-sequence.ts` at the
 * moment the hit lands, and exactly one module may answer that question.
 */
import { describe, expect, it } from 'vitest';
import type { GameEvent, PlayerId } from '@jonny-boi/core';
import { burstParticleOffsets, deriveVfxCues, type VfxCue } from './vfx-cues.js';
import { deriveDamageSequence } from './damage-sequence.js';

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

  it('UX-15: damage blooms from the SEQUENCE, not from this table (one answer, one bloom)', () => {
    // The `damageDealt` row was retired when the damage sequence shipped: it
    // bloomed at t=0 while the sequence's identical burst blooms when the hit
    // actually lands, and two modules answering "damage landed here" drift.
    // THIS TEST IS THE GUARD — putting the row back turns it red.
    const toCreature: GameEvent[] = [{ type: 'damageDealt', source: 1, target: 9, amount: 3, combat: true }];
    const toFace: GameEvent[] = [{ type: 'damageDealt', source: 1, target: 'B', amount: 3, combat: false }];
    expect(vfx(toCreature)).toEqual([]);
    expect(vfx(toFace)).toEqual([]);
    // ...and the sequence is the one that answers, for BOTH ends of the board.
    expect(deriveDamageSequence(toCreature, { reducedMotion: false, startIndex: 0 })).toMatchObject([
      { to: { where: 'tile', instanceId: 9 }, amount: 3 },
    ]);
    expect(deriveDamageSequence(toFace, { reducedMotion: false, startIndex: 0 })).toMatchObject([
      { to: { where: 'seat', seat: 'B' }, amount: 3 },
    ]);
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

  it('§3.132 — burstParticleOffsets returns the asked-for count of finite points', () => {
    const pts = burstParticleOffsets(10);
    expect(pts).toHaveLength(10);
    expect(pts.every((p) => Number.isFinite(p.dx) && Number.isFinite(p.dy))).toBe(true);
    // Not all at the origin — a real spray.
    expect(pts.some((p) => p.dx !== 0 || p.dy !== 0)).toBe(true);
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
