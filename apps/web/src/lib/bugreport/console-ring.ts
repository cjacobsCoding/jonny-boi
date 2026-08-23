/**
 * The console/error ring — "what happened just before this".
 *
 * WHY THIS IS THE WEB REPORTER'S EQUIVALENT OF THE GAMES' VIDEO RING. Treadlight
 * and Lightwalker keep the last N seconds of frames because a rendering bug is
 * something you have to SEE. In a rules engine and a sim harness the equivalent
 * evidence is textual: the warning that fired twice, the unsupported-mechanic
 * signal, the thrown error and its stack. A screenshot of a card grid rarely says
 * why the verdict was wrong; the log usually does.
 *
 * INSTALLED ONCE, AT MODULE LOAD, and never uninstalled: a ring that only starts
 * recording when you open the reporter has already missed the thing you opened it
 * for. The original console methods are always called, so nothing this does can
 * hide output from the devtools console.
 *
 * The ring itself is the pure `LogRing` in ./report.ts — this file is only the
 * plumbing that feeds it.
 */
import { DEFAULT_BUG_REPORT_CONFIG, LogRing, type LogLine } from './report.js';

const ring = new LogRing(DEFAULT_BUG_REPORT_CONFIG.consoleRingLines);

/** Longest single captured line. A stack trace is useful; a megabyte is not. */
const MAX_LINE_CHARS = 2000;

let startedAt = 0;
let installed = false;

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    // A circular or exotic object must not throw INSIDE the log hook — that
    // would turn every stray console.log into a crash.
    return String(arg);
  }
}

function record(level: LogLine['level'], args: readonly unknown[]): void {
  const text = args.map(stringifyArg).join(' ');
  ring.push({
    atMs: Math.max(0, performance.now() - startedAt),
    level,
    text: text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}… [truncated]` : text,
  });
}

/**
 * Hook the console and the two global error events. Idempotent — a second call
 * (a hot reload, a second import) is a no-op rather than a double-wrap that would
 * record every line twice.
 */
export function installConsoleRing(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  startedAt = performance.now();

  const levels: ReadonlyArray<LogLine['level']> = ['log', 'info', 'warn', 'error'];
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      record(level, args);
      original(...args);
    };
  }

  // An uncaught error or rejection is the single most valuable line in a report,
  // and it never reaches console.error in every browser.
  window.addEventListener('error', (event) => {
    record('error', [
      `uncaught: ${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
      event.error instanceof Error ? (event.error.stack ?? '') : '',
    ]);
  });
  window.addEventListener('unhandledrejection', (event) => {
    record('error', ['unhandled rejection:', event.reason]);
  });
}

/** The live ring, for the reporter to read at submit time. */
export function consoleRing(): LogRing {
  return ring;
}
