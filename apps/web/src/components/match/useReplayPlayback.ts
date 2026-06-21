/**
 * `useReplayPlayback` — owns the scrubber position + play/pause/auto-advance for the
 * match-replay viewer. One hook so the view never juggles timers inline (DRY); all
 * timing comes from the named `replay-config` speeds (DESIGN §1: no magic numbers).
 *
 * The position is a FRAME index into `MatchTrace.frames` (0 = opening). Auto-advance
 * ticks at the selected speed's `tickMs`, stopping at the last frame. Loading a new
 * trace resets to the start and pauses.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_PLAYBACK_SPEED_ID,
  speedById,
  STEP_SIZE,
} from '../../lib/replay-config.js';

export interface ReplayPlayback {
  /** Current frame index (0 = opening, frameCount-1 = end). */
  readonly index: number;
  readonly playing: boolean;
  readonly speedId: string;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  stepForward: () => void;
  stepBack: () => void;
  restart: () => void;
  seek: (index: number) => void;
  setSpeed: (id: string) => void;
}

/** Clamp an index into `[0, frameCount-1]` (empty trace → 0). */
function clampIndex(index: number, frameCount: number): number {
  if (frameCount <= 0) return 0;
  return Math.max(0, Math.min(index, frameCount - 1));
}

export function useReplayPlayback(frameCount: number): ReplayPlayback {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedId, setSpeedId] = useState<string>(DEFAULT_PLAYBACK_SPEED_ID);

  const atStart = index <= 0;
  const atEnd = frameCount <= 0 || index >= frameCount - 1;

  // A fresh trace (frame count changes identity) resets the scrubber + pauses.
  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [frameCount]);

  const seek = useCallback(
    (next: number) => setIndex(clampIndex(next, frameCount)),
    [frameCount],
  );
  const stepForward = useCallback(
    () => setIndex((i) => clampIndex(i + STEP_SIZE, frameCount)),
    [frameCount],
  );
  const stepBack = useCallback(
    () => setIndex((i) => clampIndex(i - STEP_SIZE, frameCount)),
    [frameCount],
  );
  const restart = useCallback(() => {
    setIndex(0);
    setPlaying(false);
  }, []);
  const play = useCallback(() => {
    if (frameCount > 0) setPlaying(true);
  }, [frameCount]);
  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => setPlaying((p) => !p), []);
  const setSpeed = useCallback((id: string) => setSpeedId(id), []);

  // Auto-advance: while playing, step one frame each tick; stop at the end. The
  // timer is recreated when the speed changes so a mid-playback speed change applies.
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!playing) return;
    const tickMs = speedById(speedId).tickMs;
    tickRef.current = setInterval(() => {
      setIndex((i) => {
        const next = i + STEP_SIZE;
        if (next >= frameCount - 1) {
          setPlaying(false);
          return clampIndex(frameCount - 1, frameCount);
        }
        return clampIndex(next, frameCount);
      });
    }, tickMs);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [playing, speedId, frameCount]);

  return {
    index,
    playing,
    speedId,
    atStart,
    atEnd,
    play,
    pause,
    toggle,
    stepForward,
    stepBack,
    restart,
    seek,
    setSpeed,
  };
}
