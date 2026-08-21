/**
 * THE ROLLING CLIP — what happened in the seconds BEFORE you pressed `b`.
 *
 * This is the feature the two C++ games have and the web reporter did not. They
 * read the framebuffer back ten times a second into a ring and dump the last N
 * seconds as video. A browser cannot do that: rasterising the DOM costs ~800 ms
 * per frame even after optimisation (see capture-policy.ts), and `getDisplayMedia`
 * is a permission prompt that Android Chrome does not implement at all — so on a
 * phone, the surface this app actually ships on, screen recording is not an
 * option.
 *
 * So the clip is a DOM SESSION RECORDING (rrweb), not a video. What lands in the
 * report is `replay.html`, a self-contained page that plays those seconds back
 * with a scrubber and no network access. For a bug report this is strictly more
 * useful than video: the replay carries the real DOM, so text is selectable, the
 * layout is inspectable, and it is a fraction of the size. It also costs no
 * permission and works identically on the phone and the desktop.
 *
 * THE RECORDING STOPS THE INSTANT THE REPORTER OPENS. The clip is meant to show
 * the bug, not the reporter drawing on top of it — and the frozen frame the
 * overlay puts on screen is a huge inlined data URL that has no business being
 * in the event stream.
 *
 * WHY CHUNKS AND NOT A FLAT LIST OF EVENTS. A replay can only start from a full
 * DOM snapshot; the events after it are mutations that mean nothing on their
 * own. rrweb re-snapshots every `checkoutEveryNms` and flags that event, so the
 * ring keeps whole chunks and drops whole chunks. Trimming to an exact "last 30
 * seconds" would slice a chunk mid-mutation and produce a replay of nothing.
 */

/** One event as this module needs to see it. rrweb's own type is structural. */
export interface ClipEvent {
  readonly type: number;
  readonly timestamp: number;
  readonly [key: string]: unknown;
}

/** A run of events beginning at a full snapshot. */
export interface ClipChunk {
  readonly startMs: number;
  readonly endMs: number;
  readonly events: readonly ClipEvent[];
}

/** Chunk bounds, which is all the window arithmetic needs. */
export interface ChunkSpan {
  readonly startMs: number;
  readonly endMs: number;
}

export const CLIP_DEFAULTS = {
  /**
   * How often rrweb takes a fresh snapshot, and therefore the granularity of
   * what can be dropped. 15 s against a 30 s window means the ring holds
   * between 30 and 45 s — enough that a 30 s request is always satisfiable.
   */
  checkoutEveryMs: 15_000,
  /** Chunks retained. Three x 15 s covers the 30 s window with one to spare. */
  maxChunks: 3,
  /**
   * A ceiling on retained events, so a pathological page (an animation storm,
   * a runaway render loop) cannot turn a debugging aid into a memory leak.
   * Rule 7: a tool that is always on must have a bound that does not depend on
   * the page behaving.
   */
  maxEvents: 20_000,
  /** The rolling window offered at submit time, in seconds. */
  windowSeconds: 30,
} as const;

const MS_PER_SECOND = 1000;

/**
 * The index of the first chunk to include for a window of `seconds` ending at
 * `nowMs` — PURE, so the rule can be pinned without a browser.
 *
 * The window is a FLOOR, not a ceiling: chunks are whole, so a 30 s request
 * yields between 30 and 45 s. More context than asked for is harmless in a bug
 * report; less is a clip that cuts off before the thing being reported.
 *
 * The last chunk is always included even when it is older than the window: a
 * clip of the last 30 seconds of a page that has been idle for a minute is
 * still the last thing that happened, and returning nothing would be a report
 * that silently carries no clip. `seconds <= 0` means "no clip", which is the
 * same dial-to-zero rule the games use, and returns -1.
 */
export function firstChunkForWindow(
  chunks: readonly ChunkSpan[],
  nowMs: number,
  seconds: number,
): number {
  if (seconds <= 0 || chunks.length === 0) return -1;
  const windowStartMs = nowMs - seconds * MS_PER_SECOND;
  let first = chunks.length - 1;
  // Walk back while the earlier chunk still overlaps the window. Stopping at
  // the first that does not is what keeps the replay starting on a snapshot.
  while (first > 0) {
    const previous = chunks[first - 1];
    if (previous === undefined || previous.endMs < windowStartMs) break;
    first -= 1;
  }
  return first;
}

/**
 * Drop whole chunks from the front until the retained event count fits the cap.
 * The NEWEST chunk is never dropped — it is the only one guaranteed to contain
 * what the reporter just saw, and a clip that begins after the bug is worthless.
 */
export function trimToEventCap(
  counts: readonly number[],
  maxEvents: number,
): number {
  if (counts.length === 0) return 0;
  let first = 0;
  let total = counts.reduce((sum, n) => sum + n, 0);
  while (first < counts.length - 1 && total > maxEvents) {
    total -= counts[first] ?? 0;
    first += 1;
  }
  return first;
}

/** rrweb's `record`, typed to what is used here so the module stays testable. */
type RecordFn = (options: {
  emit: (event: ClipEvent, isCheckout?: boolean) => void;
  checkoutEveryNms?: number;
  maskInputOptions?: Record<string, boolean>;
  collectFonts?: boolean;
}) => (() => void) | undefined;

/**
 * The always-on ring. One instance, started when the app loads — by the time
 * someone presses `b` the interesting seconds have already happened, so there
 * is no version of this that starts later.
 */
export class ClipRing {
  private chunks: ClipChunk[] = [];
  private open: ClipEvent[] = [];
  private stopFn: (() => void) | null = null;
  private note = '';

  get recording(): boolean {
    return this.stopFn !== null;
  }

  /** Events currently retained, across every chunk. For the debug readout. */
  get eventCount(): number {
    return this.chunks.reduce((n, c) => n + c.events.length, 0) + this.open.length;
  }

  get chunkCount(): number {
    return this.chunks.length + (this.open.length > 0 ? 1 : 0);
  }

  /** Why there is no clip, when there is not one. */
  get status(): string {
    return this.note;
  }

  /**
   * Begin recording. Never throws: rrweb failing to start costs the clip and
   * nothing else, and the report says so instead of failing (rule 6).
   */
  start(record: RecordFn, options: { checkoutEveryMs?: number; maxEvents?: number } = {}): void {
    if (this.stopFn !== null) return;
    const checkoutEveryNms = options.checkoutEveryMs ?? CLIP_DEFAULTS.checkoutEveryMs;
    const maxEvents = options.maxEvents ?? CLIP_DEFAULTS.maxEvents;
    try {
      const stop = record({
        emit: (event, isCheckout) => {
          if (isCheckout === true && this.open.length > 0) this.sealOpenChunk(maxEvents);
          this.open.push(event);
        },
        checkoutEveryNms,
        // Passwords are masked by rrweb's own default; this app has none, and
        // deck names and search text are exactly what a report needs to show.
        maskInputOptions: { password: true },
        // Fonts are loaded from the page's own origin at replay time; embedding
        // them would multiply the size of every report for no gain.
        collectFonts: false,
      });
      this.stopFn = stop ?? null;
      if (this.stopFn === null) this.note = 'the session recorder returned no handle';
    } catch (error) {
      this.note = `the session recorder would not start (${String(error)})`;
    }
  }

  private sealOpenChunk(maxEvents: number): void {
    const events = this.open;
    this.open = [];
    if (events.length === 0) return;
    this.chunks.push({
      startMs: events[0]?.timestamp ?? 0,
      endMs: events[events.length - 1]?.timestamp ?? 0,
      events,
    });
    while (this.chunks.length > CLIP_DEFAULTS.maxChunks) this.chunks.shift();
    const first = trimToEventCap(
      this.chunks.map((c) => c.events.length),
      maxEvents,
    );
    if (first > 0) this.chunks = this.chunks.slice(first);
  }

  /** Stop recording, keeping everything captured so far. */
  stop(): void {
    this.stopFn?.();
    this.stopFn = null;
    if (this.open.length > 0) this.sealOpenChunk(CLIP_DEFAULTS.maxEvents);
  }

  /** Drop everything. Used when a clip has been handed over. */
  clear(): void {
    this.chunks = [];
    this.open = [];
  }

  /**
   * The events for the last `seconds`, ready to hand to the player. Empty when
   * the dial is at zero, when nothing was recorded, or when what was recorded
   * cannot make a replay (fewer than two events is a snapshot with nothing
   * happening after it).
   */
  eventsForWindow(seconds: number, nowMs: number): readonly ClipEvent[] {
    const all = this.snapshotChunks();
    const first = firstChunkForWindow(all, nowMs, seconds);
    if (first < 0) return [];
    const selected = all.slice(first);
    const events = selected.flatMap((chunk) => [...chunk.events]);
    return events.length >= 2 ? events : [];
  }

  /** Chunk list including the one still being filled. */
  private snapshotChunks(): ClipChunk[] {
    if (this.open.length === 0) return [...this.chunks];
    return [
      ...this.chunks,
      {
        startMs: this.open[0]?.timestamp ?? 0,
        endMs: this.open[this.open.length - 1]?.timestamp ?? 0,
        events: this.open,
      },
    ];
  }
}
