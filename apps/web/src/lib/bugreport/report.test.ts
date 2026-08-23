/**
 * Pure BUG REPORTER tests — the half of the in-game reporter with no DOM in it:
 * the tolerant config parse, the annotation model, the bundle naming, the
 * report.md assembly and the log ring.
 *
 * Deliberately the same cases as `tests/test_bug_report.cpp` in Treadlight and
 * Lightwalker, so a behavioural drift between the three projects' reporters
 * shows up as a failing test rather than as three reports that read differently.
 */
import { describe, expect, it } from 'vitest';
import {
  Annotation,
  DEFAULT_BUG_REPORT_CONFIG,
  LogRing,
  assembleReportMarkdown,
  defaultPalette,
  parseBugReportConfig,
  reportBundleName,
  type ReportSummary,
  type ReportTimestamp,
} from './report.js';

const STAMP: ReportTimestamp = {
  year: 2026,
  month: 8,
  day: 15,
  hour: 14,
  minute: 25,
  second: 30,
};

function summary(overrides: Partial<ReportSummary> = {}): ReportSummary {
  return {
    timestamp: STAMP,
    typedText: 'the swap verdict says improved but the win rate went down',
    transcript: '',
    transcriptNote: '',
    screenName: 'Lab',
    buildCommit: 'abc1234',
    attachments: ['screenshot.png', 'annotated.png', 'state_dump.txt'],
    clipSeconds: 0,
    clipEvents: 0,
    clipNote: '',
    audioRecorded: false,
    audioSeconds: 0,
    annotationStrokes: 3,
    consoleLines: 12,
    errorLines: 1,
    screenshotNote: '',
    ...overrides,
  };
}

describe('bug report config', () => {
  it('ships defaults that are usable with no override at all', () => {
    expect(DEFAULT_BUG_REPORT_CONFIG.hotkey).toBe('b');
    expect(DEFAULT_BUG_REPORT_CONFIG.palette.length).toBeGreaterThan(0);
    expect(DEFAULT_BUG_REPORT_CONFIG.strokeWidthPx).toBeGreaterThan(0);
  });

  it('keeps every default for a non-object document', () => {
    expect(parseBugReportConfig(null)).toEqual(DEFAULT_BUG_REPORT_CONFIG);
    expect(parseBugReportConfig([1, 2])).toEqual(DEFAULT_BUG_REPORT_CONFIG);
    expect(parseBugReportConfig('nope')).toEqual(DEFAULT_BUG_REPORT_CONFIG);
  });

  it('reads plain values as written', () => {
    const c = parseBugReportConfig({ hotkey: 'F9', strokeWidthPx: 8, audioMaxSeconds: 60 });
    expect(c.hotkey).toBe('F9');
    expect(c.strokeWidthPx).toBe(8);
    expect(c.audioMaxSeconds).toBe(60);
  });

  it('clamps out-of-range numbers into the usable band instead of ignoring them', () => {
    const c = parseBugReportConfig({
      strokeWidthPx: 900,
      audioMaxSeconds: -5,
      consoleRingLines: 1_000_000,
    });
    expect(c.strokeWidthPx).toBeLessThanOrEqual(64);
    expect(c.strokeWidthPx).toBeGreaterThan(0);
    expect(c.audioMaxSeconds).toBeGreaterThanOrEqual(1);
    expect(c.consoleRingLines).toBeLessThanOrEqual(5000);
  });

  it('ignores wrong-typed values rather than coercing them', () => {
    const c = parseBugReportConfig({ strokeWidthPx: 'fat', hotkey: 42 });
    expect(c.strokeWidthPx).toBe(DEFAULT_BUG_REPORT_CONFIG.strokeWidthPx);
    expect(c.hotkey).toBe(DEFAULT_BUG_REPORT_CONFIG.hotkey);
  });

  it('adopts a good palette and refuses an all-malformed one', () => {
    const good = parseBugReportConfig({
      palette: [{ name: 'orange', color: '#ff8000' }, { color: '#8000ff' }],
    });
    expect(good.palette).toHaveLength(2);
    expect(good.palette[0]).toEqual({ name: 'orange', color: '#ff8000' });
    expect(good.palette[1]!.name).toBe('color');

    // A palette where nothing parsed must still leave the reporter with a pen.
    const bad = parseBugReportConfig({ palette: ['red', 7, { name: 'no colour' }] });
    expect(bad.palette).toEqual(defaultPalette());
  });
});

describe('annotation', () => {
  it('records strokes and points, and drops duplicate points', () => {
    const a = new Annotation();
    expect(a.empty).toBe(true);

    a.beginStroke(10, 10, 0, 4);
    a.extendStroke(20, 20);
    a.extendStroke(30, 30);
    a.endStroke();
    expect(a.strokeCount).toBe(1);
    expect(a.pointCount).toBe(3);

    // A held-still pointer must not grow the buffer every frame.
    a.beginStroke(5, 5, 0, 4);
    for (let i = 0; i < 100; i += 1) a.extendStroke(5, 5);
    a.endStroke();
    expect(a.strokes[1]!.points).toHaveLength(1);
  });

  it('ignores extend with no open stroke rather than throwing', () => {
    const a = new Annotation();
    expect(() => a.extendStroke(1, 1)).not.toThrow();
    expect(a.empty).toBe(true);
  });

  it('keeps a single-point stroke — a dot is how you point at one card', () => {
    const a = new Annotation();
    a.beginStroke(7, 7, 1, 4);
    a.endStroke();
    expect(a.strokeCount).toBe(1);
    expect(a.strokes[0]!.points).toHaveLength(1);
  });

  it('closes the previous stroke on a begin instead of merging into it', () => {
    const a = new Annotation();
    a.beginStroke(1, 1, 0, 4);
    a.beginStroke(2, 2, 0, 4);
    expect(a.strokeCount).toBe(2);
    expect(a.strokes[0]!.points).toHaveLength(1);
  });

  it('undoes and clears, and undoing nothing is false rather than a throw', () => {
    const a = new Annotation();
    a.beginStroke(1, 1, 0, 4);
    a.endStroke();
    a.beginStroke(5, 5, 1, 6);
    a.endStroke();
    expect(a.undo()).toBe(true);
    expect(a.undo()).toBe(true);
    expect(a.undo()).toBe(false);

    a.beginStroke(1, 1, 0, 4);
    a.clear();
    expect(a.empty).toBe(true);
    expect(a.drawing).toBe(false);
  });

  it('undoing mid-drag removes the open stroke and ends the drag', () => {
    const a = new Annotation();
    a.beginStroke(1, 1, 0, 4);
    a.extendStroke(2, 2);
    expect(a.drawing).toBe(true);
    expect(a.undo()).toBe(true);
    expect(a.drawing).toBe(false);
    expect(a.empty).toBe(true);
  });

  it('carries colour and width PER STROKE, not globally', () => {
    const a = new Annotation();
    a.beginStroke(1, 1, 2, 4);
    a.endStroke();
    a.beginStroke(2, 2, 5, 12);
    a.endStroke();
    expect(a.strokes[0]).toMatchObject({ paletteIndex: 2, widthPx: 4 });
    expect(a.strokes[1]).toMatchObject({ paletteIndex: 5, widthPx: 12 });
  });

  it('floors a zero or negative stroke width to a visible one', () => {
    const a = new Annotation();
    a.beginStroke(1, 1, 0, 0);
    a.endStroke();
    expect(a.strokes[0]!.widthPx).toBeGreaterThanOrEqual(1);
  });
});

describe('bundle name', () => {
  it('is fixed width, zero padded, and sorts as a timeline', () => {
    expect(reportBundleName(STAMP)).toBe('bugreport_20260815_142530');
    expect(reportBundleName(STAMP) < reportBundleName({ ...STAMP, minute: 26 })).toBe(true);
    expect(reportBundleName(STAMP) < reportBundleName({ ...STAMP, day: 16, hour: 1 })).toBe(true);
  });

  it('cannot produce a name with a sign or a stray separator from a broken clock', () => {
    const name = reportBundleName({ year: -7, month: 99, day: 200, hour: -1, minute: 0, second: 0 });
    expect(name).not.toContain('-');
    expect(name).not.toContain('/');
    expect(name).toHaveLength('bugreport_20260815_142530'.length);
  });
});

describe('report markdown', () => {
  it('carries the facts and is deterministic', () => {
    const md = assembleReportMarkdown(summary());
    expect(md).toContain('# jonny-boi bug report');
    expect(md).toContain('2026-08-15 14:25:30');
    expect(md).toContain('- **screen**: Lab');
    expect(md).toContain('abc1234');
    expect(md).toContain('the swap verdict says improved');
    expect(md).toContain('12 line(s) captured, 1 error(s)');
    expect(md).toContain('state_dump.txt');
    expect(assembleReportMarkdown(summary())).toBe(md);
  });

  it('distinguishes the three reasons a clip can be missing', () => {
    // "there is no clip", "you asked for no clip" and "the recorder never
    // started" send a reader to three different places; a single blank line
    // sends them nowhere.
    expect(assembleReportMarkdown(summary())).toContain('- **clip**: none');
    expect(
      assembleReportMarkdown(summary({ clipNote: 'the clip was dialled to 0 s' })),
    ).toContain('- **clip**: none (the clip was dialled to 0 s)');
    expect(
      assembleReportMarkdown(summary({ clipNote: 'the session recorder would not start (x)' })),
    ).toContain('would not start');
  });

  it('reports the clip it actually carries, and points at the player', () => {
    const md = assembleReportMarkdown(summary({ clipSeconds: 31.25, clipEvents: 417 }));
    // The SPAN captured, not the span requested: the ring cuts on snapshot
    // boundaries, so a 30 s request routinely carries a little more.
    expect(md).toContain('31.3 s before the report');
    expect(md).toContain('417 recorded event(s)');
    expect(md).toContain('replay.html');
  });

  it('attaches the health warning to every transcript', () => {
    const md = assembleReportMarkdown(summary({ transcript: 'it drew the wrong card' }));
    expect(md).toContain('it drew the wrong card');
    expect(md).toContain('voice.webm');
    expect(md).toContain('HINT');
  });

  it('shows a failed transcription as a note, never a silent gap', () => {
    const md = assembleReportMarkdown(
      summary({ transcript: '', transcriptNote: 'this browser has no speech recognition' }),
    );
    expect(md).toContain('Transcription note');
    expect(md).toContain('no speech recognition');
  });

  it('shows a failed screenshot as a note, never a silent gap', () => {
    const md = assembleReportMarkdown(summary({ screenshotNote: 'rasterising the page failed' }));
    expect(md).toContain('Screenshot note');
    expect(md).toContain('rasterising the page failed');
  });

  it('reports recorded audio to one decimal place', () => {
    const md = assembleReportMarkdown(summary({ audioRecorded: true, audioSeconds: 4.25 }));
    expect(md).toContain('4.3 s recorded');
  });

  it('degrades empty optional fields to a readable placeholder', () => {
    const md = assembleReportMarkdown(
      summary({ screenName: '', buildCommit: '', typedText: '', attachments: [] }),
    );
    expect(md).toContain('(unknown)');
    expect(md).toContain('none recorded');
    // No empty headings for sections with nothing in them.
    expect(md).not.toContain('## What the reporter wrote');
  });
});

describe('log ring', () => {
  it('keeps the newest lines and drops the oldest at capacity', () => {
    const ring = new LogRing(3);
    for (let i = 0; i < 5; i += 1) {
      ring.push({ atMs: i * 1000, level: 'log', text: `line ${i}` });
    }
    expect(ring.size).toBe(3);
    expect(ring.lines[0]!.text).toBe('line 2');
    expect(ring.lines[2]!.text).toBe('line 4');
  });

  it('counts by level, so the report can say how many errors there were', () => {
    const ring = new LogRing(10);
    ring.push({ atMs: 0, level: 'log', text: 'a' });
    ring.push({ atMs: 1, level: 'error', text: 'boom' });
    ring.push({ atMs: 2, level: 'error', text: 'boom again' });
    expect(ring.countOf('error')).toBe(2);
    expect(ring.countOf('warn')).toBe(0);
  });

  it('formats oldest first with a timestamp and a level', () => {
    const ring = new LogRing(10);
    ring.push({ atMs: 1500, level: 'warn', text: 'careful' });
    expect(ring.format()).toBe('[1.500s] WARN careful');
  });

  it('is empty-safe', () => {
    const ring = new LogRing(5);
    expect(ring.format()).toBe('');
    expect(ring.size).toBe(0);
  });
});
