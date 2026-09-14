/**
 * §3.130 — the pure event→sound-cue table. These pin the rows that carry a
 * decision (viewer-relative draw, life sign, win/loss) and the coalescing that
 * keeps a batch from machine-gunning, so a change to the table is a change a
 * test sees.
 */
import { describe, expect, it } from 'vitest';
import type { GameEvent, PlayerId } from '@jonny-boi/core';
import { ALL_SOUND_CUES, deriveSoundCues, type SoundCue, type SoundCueHit } from './sound-cues.js';
import { SYNTHESIZABLE_CUES } from './sound-engine.js';
import { DAMAGE_ANIM_CONFIG, SOUND_CONFIG } from './play-config.js';

const VIEWER: PlayerId = 'A';
const OPP: PlayerId = 'B';

function hits(events: readonly GameEvent[], viewer: PlayerId = VIEWER, muted = false): readonly SoundCueHit[] {
  return deriveSoundCues(events, { muted, startIndex: 0, viewer });
}

function cues(events: readonly GameEvent[], viewer: PlayerId = VIEWER, muted = false): SoundCue[] {
  return hits(events, viewer, muted).map((h) => h.cue);
}

/** A combat hit, marked with the step core would have stamped it with. */
const dealt = (
  source: number,
  target: number | PlayerId,
  amount: number,
  round: 'firstStrike' | 'normal' = 'normal',
): GameEvent => ({ type: 'damageDealt', source, target, amount, combat: true, round });

describe('deriveSoundCues — the table', () => {
  it('maps the common actions to their cues', () => {
    expect(cues([{ type: 'landPlayed', player: 'A', instanceId: 1 }])).toEqual(['land']);
    expect(cues([{ type: 'spellCast', player: 'A', instanceId: 1, name: 'Bolt', castTypes: [] }])).toEqual(['cast']);
    expect(cues([{ type: 'attackersDeclared', attackers: [1] }])).toEqual(['attack']);
    expect(cues([{ type: 'creatureDied', instanceId: 1, name: 'Bear' }])).toEqual(['death']);
    expect(cues([{ type: 'tokenCreated', instanceId: 1, controller: 'A', name: 'Soldier' }])).toEqual(['token']);
  });

  it('a draw sounds for the VIEWER only — the opponent’s draw is theirs', () => {
    expect(cues([{ type: 'drawCard', player: 'A', instanceId: 1 }])).toEqual(['draw']);
    expect(cues([{ type: 'drawCard', player: 'B', instanceId: 1 }])).toEqual([]);
  });

  it('life splits on the delta sign; a zero swing is silent', () => {
    expect(cues([{ type: 'lifeChanged', player: 'A', delta: 5, to: 25 }])).toEqual(['lifeGain']);
    expect(cues([{ type: 'lifeChanged', player: 'A', delta: -3, to: 17 }])).toEqual(['lifeLoss']);
    expect(cues([{ type: 'lifeChanged', player: 'A', delta: 0, to: 20 }])).toEqual([]);
  });

  it('the game-over sting is a win for the viewer, a loss otherwise, silence on a draw', () => {
    expect(cues([{ type: 'gameOver', winner: 'A' }])).toEqual(['victory']);
    expect(cues([{ type: 'gameOver', winner: 'B' }])).toEqual(['defeat']);
    expect(cues([{ type: 'gameOver', winner: 'A' }], OPP)).toEqual(['defeat']);
    expect(cues([{ type: 'gameOver', winner: null }])).toEqual([]);
  });

  it('identical cues in one batch coalesce to a single hit (no machine-gun)', () => {
    const fiveTaps: GameEvent[] = Array.from({ length: 5 }, () => ({ type: 'tapped', instanceId: 1 }));
    expect(cues(fiveTaps)).toEqual(['tap']);
    // A whole board dying is one death sound, not twelve.
    const wrath: GameEvent[] = Array.from({ length: 12 }, (_, i) => ({ type: 'creatureDied', instanceId: i, name: 'x' }));
    expect(cues(wrath)).toEqual(['death']);
  });

  it('a cast that auto-taps reads as "tap then cast", both once', () => {
    const batch: GameEvent[] = [
      { type: 'tapped', instanceId: 1 },
      { type: 'manaAdded', player: 'A', color: 'G', amount: 1 },
      { type: 'tapped', instanceId: 2 },
      { type: 'manaAdded', player: 'A', color: 'G', amount: 1 },
      { type: 'spellCast', player: 'A', instanceId: 9, name: 'Thragtusk', castTypes: [] },
    ];
    // manaAdded is intentionally silent; tap coalesces; order is event order.
    expect(cues(batch)).toEqual(['tap', 'cast']);
  });

  it('silent events make no sound, and muted derives nothing at all', () => {
    expect(cues([{ type: 'priorityPassed', player: 'A' }])).toEqual([]);
    expect(cues([{ type: 'stepBegin', step: 'upkeep', activePlayer: 'A' }])).toEqual([]);
    expect(cues([{ type: 'landPlayed', player: 'A', instanceId: 1 }], VIEWER, true)).toEqual([]);
  });

  it('a batch is capped, and keys are unique and offset by startIndex', () => {
    // More distinct cues than the cap allows.
    const many: GameEvent[] = [
      { type: 'landPlayed', player: 'A', instanceId: 1 },
      { type: 'spellCast', player: 'A', instanceId: 2, name: 'x', castTypes: [] },
      { type: 'drawCard', player: 'A', instanceId: 3 },
      { type: 'attackersDeclared', attackers: [4] },
      { type: 'damageDealt', source: 4, target: 'B', amount: 2, combat: true },
      { type: 'creatureDied', instanceId: 5, name: 'y' },
      { type: 'counterAdded', instanceId: 6, kind: '+1/+1', amount: 1 },
      { type: 'tokenCreated', instanceId: 7, controller: 'A', name: 'z' },
    ];
    const batch = deriveSoundCues(many, { muted: false, startIndex: 100, viewer: VIEWER });
    expect(batch.length).toBe(SOUND_CONFIG.maxPerBatch);
    expect(new Set(batch.map((h) => h.key)).size).toBe(batch.length);
    expect(batch[0]!.key).toBe('100');
  });
});

/**
 * §3.143 GAP-11 — the damage cue and the damage ANIMATION are one event.
 *
 * The defect these pin: `damageDealt: always('damage')` fired the impact sound
 * at t=0, `DAMAGE_ANIM_CONFIG.travelMs` before the hit it is the sound of landed
 * on screen. Two answers to "the damage landed", on two clocks — the same DRY
 * failure `vfx-cues.ts` had already fixed on the visual axis, missed here.
 *
 * These are the regression guard for the CLASS, not the instance: they assert
 * that the cue is DERIVED from the damage sequence (so it cannot drift from it
 * when a duration is retuned), not that it equals one particular number.
 */
describe('the damage cue rides the damage sequence’s clock', () => {
  it('fires at the IMPACT, not at t=0 — the travel time is waited out', () => {
    const [cue] = hits([dealt(1, 2, 3)]);
    expect(cue?.cue).toBe('damage');
    expect(cue?.delayMs).toBe(DAMAGE_ANIM_CONFIG.travelMs);
    // …and the fallback schedule (`order * staggerMs`) lands within half a
    // stagger of it, so a consumer that has not adopted `delayMs` is late by
    // milliseconds rather than early by a whole travel.
    expect(Math.abs((cue?.order ?? 0) * SOUND_CONFIG.staggerMs - DAMAGE_ANIM_CONFIG.travelMs)).toBeLessThanOrEqual(
      SOUND_CONFIG.staggerMs / 2,
    );
  });

  it('a whole board’s worth of hits in ONE round is ONE impact (no machine-gun)', () => {
    const swing = [dealt(1, 10, 2), dealt(2, 11, 2), dealt(3, 12, 2), dealt(4, 'B', 2)];
    expect(cues(swing).filter((c) => c === 'damage')).toEqual(['damage']);
  });

  it('TWO combat-damage rounds are TWO impacts — the audible half of first strike', () => {
    // The same two hits the fold splits on core's marker (GAP-12). One thump per
    // round is what makes the two steps countable by ear as well as by eye.
    const combat = [dealt(1, 'B', 2, 'firstStrike'), dealt(3, 'B', 3, 'normal')];
    const damage = hits(combat).filter((h) => h.cue === 'damage');
    expect(damage).toHaveLength(2);
    const [first, second] = damage;
    expect(second!.delayMs).toBeGreaterThan(first!.delayMs);
    // The gap is one whole round of the sequence — travel, impact, settle —
    // taken from the config rather than typed as a second copy of those numbers.
    expect(second!.delayMs - first!.delayMs).toBe(
      DAMAGE_ANIM_CONFIG.travelMs + DAMAGE_ANIM_CONFIG.impactMs + DAMAGE_ANIM_CONFIG.settleHoldMs,
    );
  });

  it('PREVENTED damage still thumps, and still at its own impact', () => {
    const fizzle: GameEvent[] = [
      { type: 'damagePrevented', source: 1, target: 2, amount: 3, combat: true, round: 'normal' },
    ];
    expect(hits(fizzle).map((h) => [h.cue, h.delayMs])).toEqual([['damage', DAMAGE_ANIM_CONFIG.travelMs]]);
  });

  it('the cue keeps its place in event order, so the cap never eats the combat', () => {
    // A batch busier than the cap, with damage in the middle: the impact must
    // survive. It used to be a plain table row and was cut like any other.
    const busy: GameEvent[] = [
      { type: 'landPlayed', player: 'A', instanceId: 1 },
      { type: 'spellCast', player: 'A', instanceId: 2, name: 'x', castTypes: [] },
      { type: 'drawCard', player: 'A', instanceId: 3 },
      { type: 'attackersDeclared', attackers: [4] },
      dealt(4, 'B', 2),
      { type: 'creatureDied', instanceId: 5, name: 'y' },
      { type: 'counterAdded', instanceId: 6, kind: '+1/+1', amount: 1 },
      { type: 'tokenCreated', instanceId: 7, controller: 'A', name: 'z' },
    ];
    expect(cues(busy)).toContain('damage');
    expect(hits(busy).length).toBeLessThanOrEqual(SOUND_CONFIG.maxPerBatch);
  });

  it('every cue states WHEN it plays, and `order` is that time in stagger slots', () => {
    // THE CLASS: a consumer that re-derives the schedule from an index is a
    // second answer to "when". `delayMs` is the answer; `order` is derived from
    // it, and this fails the moment they can disagree.
    const mixed: GameEvent[] = [
      { type: 'landPlayed', player: 'A', instanceId: 1 },
      { type: 'spellCast', player: 'A', instanceId: 2, name: 'x', castTypes: [] },
      dealt(4, 'B', 2),
    ];
    for (const h of hits(mixed)) {
      expect(h.delayMs).toBeGreaterThanOrEqual(0);
      expect(h.order).toBe(Math.round(h.delayMs / SOUND_CONFIG.staggerMs));
    }
    // The ordinary table cues still sit on the plain stagger grid.
    expect(hits(mixed).slice(0, 2).map((h) => h.delayMs)).toEqual([0, SOUND_CONFIG.staggerMs]);
  });

  it('muted still derives nothing — the new path honours the same gate', () => {
    expect(cues([dealt(1, 2, 3)], VIEWER, true)).toEqual([]);
  });
});

describe('§3.132 — the cue list, the recipes and no duplicates stay in lockstep', () => {
  it('every listed cue has a synth recipe, and every recipe is listed', () => {
    // The preview bench and `canRespond`-style consumers iterate ALL_SOUND_CUES;
    // the engine can only play what has a recipe. If these ever diverge, a cue
    // ships with no sound (or a button plays nothing) — so pin them equal.
    expect(new Set(SYNTHESIZABLE_CUES)).toEqual(new Set<SoundCue>(ALL_SOUND_CUES));
  });

  it('ALL_SOUND_CUES has no duplicates', () => {
    expect(new Set(ALL_SOUND_CUES).size).toBe(ALL_SOUND_CUES.length);
  });
});
