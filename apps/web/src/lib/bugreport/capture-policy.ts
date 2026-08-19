/**
 * The DECISIONS the frozen-frame capture makes, with no DOM in them.
 *
 * Split out of `capture.ts` so they can be tested in Node, because two of them
 * were real defects found by looking at the running app rather than at the code,
 * and neither would be caught by a test of the rasteriser itself:
 *
 *   1. WHAT REGION IS CAPTURED. Handing the rasteriser `document.body` produces
 *      the whole scrollable page — several screens tall on the Cards view — while
 *      the reporter draws on it in POINTER coordinates, which are VIEWPORT
 *      coordinates. Every stroke then lands somewhere the reporter did not put
 *      it. `captureOptionsFor` is the fix: viewport-sized output, with the clone
 *      translated by the scroll offset. (Lightwalker's port of this same tool
 *      shipped exactly that defect, for the equivalent reason — a framebuffer
 *      bigger than the window.)
 *   2. WHAT IS SKIPPED. `html-to-image` fetches and base64-inlines every `<img>`
 *      it clones, and the Cards view holds ~190 card tiles: the capture ran past
 *      30 seconds and timed out. Images entirely outside the viewport cannot
 *      change a visible pixel, so `isOffScreen` drops them.
 *
 * Plus the bound. Rasterisation does not merely run slowly, it can fail to
 * finish at all — verified in a backgrounded tab, where even a single header
 * element never resolves. `withTimeout` is what turns that into a report with a
 * note in it instead of an app that has frozen.
 */

/** Marks a node the capture must skip — the overlay's own chrome, mainly. */
export const CAPTURE_IGNORE_ATTR = 'data-bugreport-ignore';

/**
 * How long the freeze may take before the report gives up on the picture and
 * ships everything else. Generous enough for a heavy view on a phone; finite so
 * a hang cannot become the user's problem.
 */
export const CAPTURE_TIMEOUT_MS = 12_000;

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/**
 * True when `rect` lies entirely outside `viewport`. Touching an edge counts as
 * on-screen: a card tile with one row of pixels showing is part of the frame the
 * reporter is looking at, and dropping it would change the picture.
 */
export function isOffScreen(rect: Rect, viewport: Viewport): boolean {
  return (
    rect.bottom < 0 || rect.top > viewport.height || rect.right < 0 || rect.left > viewport.width
  );
}

export interface CaptureOptions {
  readonly width: number;
  readonly height: number;
  readonly style: { readonly transform: string; readonly transformOrigin: string };
}

/**
 * The size and clone-transform that make the rasteriser produce the VISIBLE
 * frame. Non-finite or non-positive viewport values floor to 1 so the options can
 * never describe a zero-area canvas.
 */
export function captureOptionsFor(
  viewport: Viewport,
  scroll: { readonly x: number; readonly y: number },
): CaptureOptions {
  const clampEdge = (value: number): number =>
    Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
  const offset = (value: number): number => (Number.isFinite(value) ? -Math.round(value) : 0);
  return {
    width: clampEdge(viewport.width),
    height: clampEdge(viewport.height),
    style: {
      transform: `translate(${offset(scroll.x)}px, ${offset(scroll.y)}px)`,
      transformOrigin: 'top left',
    },
  };
}

/**
 * Reject after `ms` if `promise` has not settled. The rejection carries `label`
 * so the note in the report says WHICH step gave up, not just that something did.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * What `report.md` says when there is no picture. It names the cause AND what the
 * report still carries, because a reader who sees only "screenshot failed"
 * reasonably assumes the whole report is junk.
 */
export function captureFailureNote(error: unknown): string {
  return (
    `the page could not be rasterised (${String(error)}) — the typed note, ` +
    `the state dump and the console ring still ship`
  );
}

/**
 * Decode a `data:` URL into bytes for the bundle. Uses the global `atob`, which
 * both the browser and Node provide, so this stays testable.
 */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return new Uint8Array(0);
  const binary = atob(dataUrl.slice(comma + 1));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
