/**
 * BUG REPORTER — the PURE half.
 *
 * The tool that turns "it did something weird" into something actionable: freeze
 * the app, scribble on the frozen frame, type and/or SPEAK what went wrong, and
 * submit a bundle carrying the screenshot, the annotation, the recent console
 * output and the full app state. The impure half (the DOM, the canvas, the
 * microphone, the download) lives beside this file; NOTHING here touches a
 * browser API, so all of the geometry and assembly below is unit-tested.
 *
 * PORTED FROM the same tool in the two C++ games (Treadlight's
 * `core/debug/bug_report.*`, Lightwalker's `src/core/BugReport.*`). The bundle
 * layout, the `bugreport_<stamp>` naming and the `report.md` field lines are
 * deliberately IDENTICAL across all three, so a report reads the same whichever
 * project it came from and one habit covers all of them.
 *
 * WHERE THIS ONE HONESTLY DIFFERS, and why:
 *   - No rolling video. The games read their framebuffer back ~10 times a second;
 *     a web page has no framebuffer to read, and rasterising the DOM at that rate
 *     would cost more than the bug. The web report is a screenshot, and says so
 *     in the `video` line rather than leaving a silent gap.
 *   - The console/error ring takes video's place as "what happened just before
 *     this". For a web app it is arguably the better artifact: a thrown error
 *     with its stack beats ten seconds of footage of the same frozen screen.
 *   - A browser cannot write a folder, so the bundle is one `.zip` with the same
 *     entries the games write as files.
 */

/** A named annotation colour offered in the overlay's palette. */
export interface PaletteEntry {
  readonly name: string;
  /** `#rrggbb`. */
  readonly color: string;
}

/**
 * The palette used when nothing overrides it. Red first: it is what a person
 * reaches for to circle a mistake. The values match the two games' palettes so a
 * red circle means the same thing in every report.
 */
export function defaultPalette(): PaletteEntry[] {
  return [
    { name: 'red', color: '#e83030' },
    { name: 'yellow', color: '#f8d840' },
    { name: 'cyan', color: '#40d8f8' },
    { name: 'green', color: '#60e878' },
    { name: 'white', color: '#f5f5f5' },
    { name: 'black', color: '#101010' },
  ];
}

/** Everything tunable about the reporter. */
export interface BugReportConfig {
  /** Keyboard shortcut that opens the reporter, as a `KeyboardEvent.key`. */
  readonly hotkey: string;
  /** Prefix of the downloaded bundle, matching the games' folder prefix. */
  readonly bundlePrefix: string;
  readonly strokeWidthPx: number;
  readonly palette: readonly PaletteEntry[];
  /** Hard cap on a single recording, so a forgotten mic cannot fill memory. */
  readonly audioMaxSeconds: number;
  /** How many console/error lines the ring keeps. */
  readonly consoleRingLines: number;
}

/** The shipped defaults. Every one is named here and nowhere else (rule 1). */
export const DEFAULT_BUG_REPORT_CONFIG: BugReportConfig = {
  // The same key the two games use. One muscle memory across three projects is
  // worth more than a per-project preference.
  hotkey: 'b',
  bundlePrefix: 'bugreport',
  strokeWidthPx: 4,
  palette: defaultPalette(),
  audioMaxSeconds: 300,
  consoleRingLines: 200,
};

const MIN_STROKE_WIDTH_PX = 1;
const MAX_STROKE_WIDTH_PX = 64;
const MIN_AUDIO_SECONDS = 1;
const MAX_AUDIO_SECONDS = 3600;
const MIN_CONSOLE_LINES = 10;
const MAX_CONSOLE_LINES = 5000;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function readClampedInt(
  source: Record<string, unknown>,
  key: string,
  lo: number,
  hi: number,
  fallback: number,
): number {
  const raw = source[key];
  // Clamped rather than rejected: someone who types 900 should get the maximum
  // usable value and a working tool, not a silently ignored edit (rule 6).
  return typeof raw === 'number' && Number.isFinite(raw)
    ? clamp(Math.round(raw), lo, hi)
    : fallback;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Total, non-throwing, tolerant parse. A non-object document, missing keys,
 * wrong-typed values and out-of-range numbers all keep the corresponding
 * default (rule 6). Values are clamped, never trusted.
 */
export function parseBugReportConfig(input: unknown): BugReportConfig {
  const d = DEFAULT_BUG_REPORT_CONFIG;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return d;
  const source = input as Record<string, unknown>;

  const hotkey = typeof source.hotkey === 'string' && source.hotkey ? source.hotkey : d.hotkey;
  const bundlePrefix =
    typeof source.bundlePrefix === 'string' && source.bundlePrefix
      ? source.bundlePrefix
      : d.bundlePrefix;

  let palette = d.palette;
  if (Array.isArray(source.palette)) {
    const parsed: PaletteEntry[] = [];
    for (const entry of source.palette) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.color !== 'string' || !HEX_COLOR.test(e.color)) continue;
      parsed.push({ name: typeof e.name === 'string' ? e.name : 'color', color: e.color });
    }
    // Only adopt a parsed palette that yielded a usable colour — an
    // all-malformed array must not leave the reporter with no pen.
    if (parsed.length > 0) palette = parsed;
  }

  return {
    hotkey,
    bundlePrefix,
    palette,
    strokeWidthPx: readClampedInt(
      source,
      'strokeWidthPx',
      MIN_STROKE_WIDTH_PX,
      MAX_STROKE_WIDTH_PX,
      d.strokeWidthPx,
    ),
    audioMaxSeconds: readClampedInt(
      source,
      'audioMaxSeconds',
      MIN_AUDIO_SECONDS,
      MAX_AUDIO_SECONDS,
      d.audioMaxSeconds,
    ),
    consoleRingLines: readClampedInt(
      source,
      'consoleRingLines',
      MIN_CONSOLE_LINES,
      MAX_CONSOLE_LINES,
      d.consoleRingLines,
    ),
  };
}

// ---------------------------------------------------------------------------
// Annotation model — pure geometry. The overlay turns pointer drags into these
// and then draws them; undo/clear and the "a dot IS a valid annotation" rule are
// testable without a canvas.
// ---------------------------------------------------------------------------

export interface StrokePoint {
  readonly x: number;
  readonly y: number;
}

export interface Stroke {
  points: StrokePoint[];
  paletteIndex: number;
  widthPx: number;
}

export class Annotation {
  private readonly list: Stroke[] = [];
  private open = false;

  beginStroke(x: number, y: number, paletteIndex: number, widthPx: number): void {
    // A begin without an end (a drag interrupted by a lost pointer) closes the
    // old stroke rather than corrupting it.
    if (this.open) this.endStroke();
    this.list.push({
      points: [{ x, y }],
      paletteIndex,
      widthPx: Math.max(MIN_STROKE_WIDTH_PX, widthPx),
    });
    this.open = true;
  }

  extendStroke(x: number, y: number): void {
    if (!this.open || this.list.length === 0) return;
    const points = this.list[this.list.length - 1]!.points;
    const last = points[points.length - 1];
    // A held-still pointer must not grow the buffer every frame.
    if (last && last.x === x && last.y === y) return;
    points.push({ x, y });
  }

  endStroke(): void {
    this.open = false;
  }

  /** Drop the most recent stroke (the open one, if a drag is in progress). */
  undo(): boolean {
    if (this.list.length === 0) return false;
    this.list.pop();
    this.open = false;
    return true;
  }

  clear(): void {
    this.list.length = 0;
    this.open = false;
  }

  get drawing(): boolean {
    return this.open;
  }

  get empty(): boolean {
    return this.list.length === 0;
  }

  get strokeCount(): number {
    return this.list.length;
  }

  get pointCount(): number {
    return this.list.reduce((n, s) => n + s.points.length, 0);
  }

  get strokes(): readonly Stroke[] {
    return this.list;
  }
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

/** Broken out so naming is testable without a clock. */
export interface ReportTimestamp {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly hour: number; // 0-23
  readonly minute: number; // 0-59
  readonly second: number; // 0-59
}

function pad(value: number, width: number): string {
  const clamped = clamp(Math.trunc(value), 0, 10 ** width - 1);
  return String(clamped).padStart(width, '0');
}

/**
 * `bugreport_20260815_142530`. Sorts chronologically as text, which is the whole
 * point — a listing is a timeline. Out-of-range fields are clamped so a bad clock
 * can never produce a name with a sign or a stray separator.
 */
export function reportBundleName(ts: ReportTimestamp, prefix = 'bugreport'): string {
  return `${prefix}_${pad(ts.year, 4)}${pad(ts.month, 2)}${pad(ts.day, 2)}_${pad(ts.hour, 2)}${pad(
    ts.minute,
    2,
  )}${pad(ts.second, 2)}`;
}

/** Everything the human-readable `report.md` needs, gathered by the overlay. */
export interface ReportSummary {
  readonly timestamp: ReportTimestamp;
  /** What they wrote. */
  readonly typedText: string;
  /** What the recogniser heard (may be empty). */
  readonly transcript: string;
  /** Why there is no transcript, when there isn't. */
  readonly transcriptNote: string;
  /** Where they were, e.g. "Lab". */
  readonly screenName: string;
  readonly buildCommit: string;
  /** File names present in the bundle. */
  readonly attachments: readonly string[];
  /**
   * The rolling clip: how many seconds of session were handed over, how many
   * recorded events that came to, and why there is none when there is none.
   * `clipSeconds` is the span actually captured, not what was asked for — the
   * ring can only cut on snapshot boundaries, so the two differ.
   */
  readonly clipSeconds: number;
  readonly clipEvents: number;
  readonly clipNote: string;
  readonly audioRecorded: boolean;
  readonly audioSeconds: number;
  readonly annotationStrokes: number;
  readonly consoleLines: number;
  readonly errorLines: number;
  /** Set when the DOM could not be rasterised, so the gap is never silent. */
  readonly screenshotNote: string;
}

function block(heading: string, body: string): string {
  // A section is only written when it has content — an empty heading in a bug
  // report is noise the reader has to skip past.
  if (!body) return '';
  return `## ${heading}\n\n${body.endsWith('\n') ? body : `${body}\n`}\n`;
}

/**
 * Render `report.md`. Deterministic — the same summary always produces the same
 * bytes, so a harness can diff two reports.
 */
export function assembleReportMarkdown(s: ReportSummary): string {
  const when =
    `${pad(s.timestamp.year, 4)}-${pad(s.timestamp.month, 2)}-${pad(s.timestamp.day, 2)} ` +
    `${pad(s.timestamp.hour, 2)}:${pad(s.timestamp.minute, 2)}:${pad(s.timestamp.second, 2)}`;

  let out = '# jonny-boi bug report\n\n';
  out += `- **when**: ${when}\n`;
  out += `- **screen**: ${s.screenName || '(unknown)'}\n`;
  out += `- **build**: ${s.buildCommit || '(unknown)'}\n`;
  out += `- **annotation strokes**: ${s.annotationStrokes}\n`;
  // Says what was produced AND why, because "there is no clip", "you asked for
  // no clip" and "the recorder could not start" are three different facts, and a
  // reader chasing a bug needs to know which one they are looking at.
  out += '- **clip**: ';
  if (s.clipEvents > 0) {
    out +=
      `${(Math.round(s.clipSeconds * 10) / 10).toFixed(1)} s before the report, ` +
      `${s.clipEvents} recorded event(s) - open replay.html`;
  } else {
    out += 'none';
  }
  if (s.clipNote) out += ` (${s.clipNote})`;
  out += '\n';
  out += `- **voice**: ${
    s.audioRecorded ? `${(Math.round(s.audioSeconds * 10) / 10).toFixed(1)} s recorded` : 'none recorded'
  }\n`;
  out += `- **console**: ${s.consoleLines} line(s) captured, ${s.errorLines} error(s)\n`;
  if (s.attachments.length > 0) out += `- **files**: ${s.attachments.join(', ')}\n`;
  out += '\n';

  out += block('What the reporter wrote', s.typedText);
  // The transcript carries its own health warning, EVERY time: a machine
  // transcript that reads cleanly can still describe the wrong thing, and a
  // reader who trusts it over the audio will chase the wrong bug.
  if (s.transcript) {
    out += block(
      'What the reporter said (transcribed)',
      `${s.transcript}\n\n> Machine transcript — treat as a HINT, not a quote. Speech ` +
        `recognition drops and substitutes words. \`voice.webm\` is the record; listen to ` +
        `it before concluding anything from this paragraph.`,
    );
  }
  out += block('Transcription note', s.transcriptNote);
  out += block('Screenshot note', s.screenshotNote);

  out += '## App state\n\n';
  out += 'See `state_dump.txt` — the build header, the live view, the decks and\n';
  out += 'sim state, the persisted settings, and `console.txt` for the log and\n';
  out += 'error ring as it stood on the frozen frame.\n';
  return out;
}

// ---------------------------------------------------------------------------
// The console/error ring — what happened just before the report.
// ---------------------------------------------------------------------------

export interface LogLine {
  /** Milliseconds since the ring started, so the ordering survives export. */
  readonly atMs: number;
  readonly level: 'log' | 'info' | 'warn' | 'error';
  readonly text: string;
}

/**
 * A fixed-capacity ring of log lines. Fixed on purpose: an app left open all day
 * must not accumulate an unbounded log because a debug tool might one day want
 * it (rule 7). Pure — the console hooks that feed it live in the impure half.
 */
export class LogRing {
  private readonly buffer: LogLine[] = [];

  constructor(private readonly capacity: number) {}

  push(line: LogLine): void {
    this.buffer.push(line);
    if (this.buffer.length > this.capacity) this.buffer.shift();
  }

  get lines(): readonly LogLine[] {
    return this.buffer;
  }

  get size(): number {
    return this.buffer.length;
  }

  countOf(level: LogLine['level']): number {
    return this.buffer.filter((l) => l.level === level).length;
  }

  clear(): void {
    this.buffer.length = 0;
  }

  /** Oldest first, one line each — the order a reader wants. */
  format(): string {
    return this.buffer
      .map((l) => `[${(l.atMs / 1000).toFixed(3)}s] ${l.level.toUpperCase()} ${l.text}`)
      .join('\n');
  }
}
