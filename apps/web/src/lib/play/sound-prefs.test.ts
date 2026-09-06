/**
 * §3.130 — the persisted audio preference decodes defensively: a stale or
 * hand-edited blob must degrade to the defaults, never to a crash or a bogus
 * volume.
 */
import { describe, expect, it } from 'vitest';
import { decodeSoundPrefs, DEFAULT_SOUND_PREFS } from './sound-prefs.js';

describe('decodeSoundPrefs', () => {
  it('garbage decodes to the defaults', () => {
    expect(decodeSoundPrefs(null)).toEqual(DEFAULT_SOUND_PREFS);
    expect(decodeSoundPrefs('nope')).toEqual(DEFAULT_SOUND_PREFS);
    expect(decodeSoundPrefs(42)).toEqual(DEFAULT_SOUND_PREFS);
  });

  it('keeps a real boolean and an in-range volume, filling the rest from defaults', () => {
    expect(decodeSoundPrefs({ enabled: false, volume: 0.3 })).toEqual({ enabled: false, volume: 0.3 });
    expect(decodeSoundPrefs({ enabled: 'yes', volume: 0.3 })).toEqual({ enabled: DEFAULT_SOUND_PREFS.enabled, volume: 0.3 });
    expect(decodeSoundPrefs({ enabled: true })).toEqual({ enabled: true, volume: DEFAULT_SOUND_PREFS.volume });
  });

  it('clamps an out-of-range or non-finite volume', () => {
    expect(decodeSoundPrefs({ volume: 5 }).volume).toBe(1);
    expect(decodeSoundPrefs({ volume: -2 }).volume).toBe(0);
    expect(decodeSoundPrefs({ volume: Number.NaN }).volume).toBe(DEFAULT_SOUND_PREFS.volume);
  });
});
