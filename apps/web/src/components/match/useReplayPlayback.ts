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
import { nextNotableFrame } from '../../lib/replay-skip.js';
import type { MatchTrace } from '../../lib/replay-types.js';

export interface ReplayPlayback {
  /** Current frame index (0 = opening, frameCount-1 = end). */
  readonly index: number;
  readonly playing: boolean;
  readonly speedId: string;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  /** When on, stepping and playback fast-forward past frames where nothing happened. */
  readonly skipQuiet: boolean;
  setSkipQuiet: (skip: boolean) => void;
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

/**
 * @param frameCount Number of frames in the trace.
 * @param trace The trace itself, used to find the next frame worth stopping on.
 *   Optional so the hook stays usable (and testable) without one — with no trace
 *   every frame is treated as notable and stepping is one-at-a-time.
 */
export function useReplayPlayback(
  frameCount: number,
  trace?: MatchTrace,
): ReplayPlayback {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedId, setSpeedId] = useState<string>(DEFAULT_PLAYBACK_SPEED_ID);
  // On by default: most frames in a real game are a pilot passing priority, and
  // stopping on each one buries the plays you are trying to watch.
  const [skipQuiet, setSkipQuiet] = useState(true);

  /** One step in `direction`, honoring the skip toggle. */
  const advance = useCallback(
    (current: number, direction: 1 | -1): number => {
      if (skipQuiet && trace) return nextNotableFrame(trace, current, direction);
      return clampIndex(current + direction * STEP_SIZE, frameCount);
    },
    [skipQuiet, trace, frameCount],
  );

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
  const stepForward = useCallback(() => setIndex((i) => advance(i, 1)), [advance]);
  const stepBack = useCallback(() => setIndex((i) => advance(i, -1)), [advance]);
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
        // Auto-advance uses the same skip rule as stepping, so playback doesn't
        // crawl through the quiet frames the step button jumps over.
        const next = advance(i, 1);
        if (next >= frameCount - 1) {
          setPlaying(false);
          return clampIndex(frameCount - 1, frameCount);
        }
        return next;
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
    skipQuiet,
    setSkipQuiet,
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
