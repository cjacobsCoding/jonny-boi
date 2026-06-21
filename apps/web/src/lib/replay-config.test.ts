/**
 * The replay viewer's playback config must stay coherent: a non-empty, ordered set
 * of named speeds, a default that actually exists, positive tick intervals and
 * caps, and a graceful `speedById` fallback — so the transport never invents a
 * magic interval (DESIGN §1) or breaks on a bad id.
 */
import { describe, expect, it } from 'vitest';
import {
  PLAYBACK_SPEEDS,
  DEFAULT_PLAYBACK_SPEED_ID,
  STEP_SIZE,
  MAX_REPLAY_EVENTS,
  MAX_REPLAY_FRAMES,
  DEFAULT_REPLAY_SEED,
  speedById,
} from './replay-config.js';

describe('replay-config coherence', () => {
  it('offers at least two named speeds, fastest → slowest, all positive intervals', () => {
    expect(PLAYBACK_SPEEDS.length).toBeGreaterThanOrEqual(2);
    for (const speed of PLAYBACK_SPEEDS) {
      expect(speed.id).toBeTruthy();
      expect(speed.label).toBeTruthy();
      expect(speed.tickMs).toBeGreaterThan(0);
    }
    // Strictly decreasing tick interval = strictly increasing speed (ordered).
    for (let i = 1; i < PLAYBACK_SPEEDS.length; i++) {
      expect(PLAYBACK_SPEEDS[i]!.tickMs).toBeLessThan(PLAYBACK_SPEEDS[i - 1]!.tickMs);
    }
  });

  it('the default speed id resolves to a real speed', () => {
    expect(PLAYBACK_SPEEDS.some((s) => s.id === DEFAULT_PLAYBACK_SPEED_ID)).toBe(true);
    expect(speedById(DEFAULT_PLAYBACK_SPEED_ID).id).toBe(DEFAULT_PLAYBACK_SPEED_ID);
  });

  it('speedById falls back to the default for an unknown id (never crashes)', () => {
    expect(speedById('does-not-exist').id).toBe(DEFAULT_PLAYBACK_SPEED_ID);
  });

  it('step size and caps are sensible positive integers', () => {
    expect(Number.isInteger(STEP_SIZE)).toBe(true);
    expect(STEP_SIZE).toBeGreaterThanOrEqual(1);
    expect(MAX_REPLAY_EVENTS).toBeGreaterThan(0);
    expect(MAX_REPLAY_FRAMES).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_REPLAY_SEED)).toBe(true);
  });
});
