/**
 * §3.57 — the animation-descriptor fold: events in → descriptors out. Pins the
 * scoped kinds, the hidden-information rule (a draw carries NO identity), the
 * reduced-motion kill switch, the per-batch cap and the stable keys.
 */
import { describe, expect, it } from 'vitest';
import type { GameEvent, InstanceId, PlayerId } from '@jonny-boi/core';
import { deriveAnimations, type AnimationCardInfo } from './animations.js';
import { ANIMATION_CONFIG } from './play-config.js';

const draw = (player: PlayerId, instanceId: number): GameEvent =>
  ({ type: 'drawCard', player, instanceId }) as GameEvent;

const move = (instanceId: number, from: string, to: string): GameEvent =>
  ({ type: 'zoneChange', instanceId, from, to }) as GameEvent;

/** A lookup over a tiny public board: ids 1–9 are A's, 11–19 are B's. */
const lookup = (id: InstanceId): AnimationCardInfo | undefined => {
  if (id === 99) return undefined; // deliberately unknown
  const owner: PlayerId = id < 10 ? 'A' : 'B';
  return { cardId: `c${id}`, name: `Card ${id}`, owner };
};

const OPTS = { reducedMotion: false, startIndex: 100, lookup } as const;

describe('deriveAnimations', () => {
  it('a draw animates for EITHER seat and carries no card identity', () => {
    const out = deriveAnimations([draw('A', 1), draw('B', 11)], OPTS);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'draw', seat: 'A', key: '100', order: 0 });
    expect(out[1]).toMatchObject({ kind: 'draw', seat: 'B', key: '101', order: 1 });
    for (const d of out) {
      // The hidden-info rule: nothing that names the drawn card may ride a draw.
      expect(d.cardId).toBeUndefined();
      expect(d.name).toBeUndefined();
    }
  });

  it('classifies mill / discard / death (graveyard AND exile removals) with public identity', () => {
    const out = deriveAnimations(
      [
        move(1, 'library', 'graveyard'),
        move(2, 'hand', 'graveyard'),
        move(11, 'battlefield', 'graveyard'),
        move(12, 'battlefield', 'exile'),
      ],
      OPTS,
    );
    expect(out.map((d) => d.kind)).toEqual(['mill', 'discard', 'death', 'death']);
    expect(out[0]).toMatchObject({ seat: 'A', cardId: 'c1', name: 'Card 1' });
    expect(out[2]).toMatchObject({ seat: 'B', instanceId: 11 });
  });

  it('ignores moves outside the scoped kinds (a bounce, a cast, a land drop)', () => {
    const out = deriveAnimations(
      [
        move(1, 'battlefield', 'hand'), // bounce — not scoped
        move(2, 'hand', 'battlefield'), // land drop / resolve — not scoped
        move(3, 'hand', 'stack'), // cast — not scoped
        ({ type: 'lifeChanged', player: 'A', delta: -2, to: 18 }) as GameEvent,
      ],
      OPTS,
    );
    expect(out).toHaveLength(0);
  });

  it('skips a move whose identity the public board cannot resolve (safe fallback)', () => {
    const out = deriveAnimations([move(99, 'library', 'graveyard')], OPTS);
    expect(out).toHaveLength(0);
  });

  it('reduced motion derives NOTHING at all', () => {
    const events = [draw('A', 1), move(1, 'library', 'graveyard')];
    expect(deriveAnimations(events, { ...OPTS, reducedMotion: true })).toHaveLength(0);
  });

  it('caps one batch at the configured maximum', () => {
    const events: GameEvent[] = [];
    for (let i = 0; i < ANIMATION_CONFIG.maxPerBatch + 5; i++) events.push(draw('A', i + 1));
    const out = deriveAnimations(events, OPTS);
    expect(out).toHaveLength(ANIMATION_CONFIG.maxPerBatch);
  });

  it('keys are minted from the absolute event index, so batches never collide', () => {
    const first = deriveAnimations([draw('A', 1)], { ...OPTS, startIndex: 5 });
    const second = deriveAnimations([draw('A', 2)], { ...OPTS, startIndex: 6 });
    expect(first[0]?.key).toBe('5');
    expect(second[0]?.key).toBe('6');
    expect(first[0]?.key).not.toBe(second[0]?.key);
  });
});
