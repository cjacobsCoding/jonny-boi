/**
 * §3.130 — the pure event→sound-cue table. These pin the rows that carry a
 * decision (viewer-relative draw, life sign, win/loss) and the coalescing that
 * keeps a batch from machine-gunning, so a change to the table is a change a
 * test sees.
 */
import { describe, expect, it } from 'vitest';
import type { GameEvent, PlayerId } from '@jonny-boi/core';
import { ALL_SOUND_CUES, deriveSoundCues, type SoundCue } from './sound-cues.js';
import { SYNTHESIZABLE_CUES } from './sound-engine.js';
import { SOUND_CONFIG } from './play-config.js';

const VIEWER: PlayerId = 'A';
const OPP: PlayerId = 'B';

function cues(events: readonly GameEvent[], viewer: PlayerId = VIEWER, muted = false): SoundCue[] {
  return deriveSoundCues(events, { muted, startIndex: 0, viewer }).map((h) => h.cue);
}

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
    const hits = deriveSoundCues(many, { muted: false, startIndex: 100, viewer: VIEWER });
    expect(hits.length).toBe(SOUND_CONFIG.maxPerBatch);
    expect(new Set(hits.map((h) => h.key)).size).toBe(hits.length);
    expect(hits[0]!.key).toBe('100');
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
