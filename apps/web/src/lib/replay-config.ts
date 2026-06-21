/**
 * Named configuration for the match-replay viewer's playback (DESIGN §1: no magic
 * numbers — every value that shapes playback feel is a NAMED token here, and the
 * UI reads these instead of inlining literals).
 *
 * Covers the trace cap handed to the worker (so a pathological game can't produce
 * an unbounded trace), the playback speeds, and the auto-advance step size.
 */

/**
 * Hard cap on how many events the worker records for ONE replay. A normal game is
 * a few hundred events; a degenerate stall could be far longer. We cap the trace
 * so the scrubber stays responsive and the payload stays small, flagging
 * truncation honestly in the UI when we hit it (DESIGN §6 robustness).
 */
export const MAX_REPLAY_EVENTS = 4000;

/** A single board snapshot is captured after each applied action; this caps them. */
export const MAX_REPLAY_FRAMES = 2000;

/** One named playback speed: a label plus the ms between auto-advance ticks. */
export interface PlaybackSpeed {
  readonly id: string;
  readonly label: string;
  /** Milliseconds between automatic steps while playing. */
  readonly tickMs: number;
}

/**
 * The selectable playback speeds, slow → fast. Named, ordered, and tuned so the
 * default reads at a comfortable "watch it happen" pace. The viewer selects among
 * these; it never invents an interval.
 */
export const PLAYBACK_SPEEDS: readonly PlaybackSpeed[] = [
  { id: 'slow', label: '0.5×', tickMs: 1600 },
  { id: 'normal', label: '1×', tickMs: 800 },
  { id: 'fast', label: '2×', tickMs: 400 },
  { id: 'turbo', label: '4×', tickMs: 200 },
] as const;

/** The speed selected when the viewer first loads a trace (the comfortable pace). */
export const DEFAULT_PLAYBACK_SPEED_ID = 'normal';

/** How many frames a single Step-forward / Step-back advances (one checkpoint). */
export const STEP_SIZE = 1;

/** The fixed seed the viewer offers by default (mirrors the Lab's, for parity). */
export const DEFAULT_REPLAY_SEED = 0xc0ffee;

/** Resolve a speed by id, falling back to the default so the UI never breaks. */
export function speedById(id: string): PlaybackSpeed {
  return (
    PLAYBACK_SPEEDS.find((s) => s.id === id) ??
    PLAYBACK_SPEEDS.find((s) => s.id === DEFAULT_PLAYBACK_SPEED_ID) ??
    PLAYBACK_SPEEDS[0]!
  );
}
