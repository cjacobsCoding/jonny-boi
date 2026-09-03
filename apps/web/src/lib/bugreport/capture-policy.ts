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

/**
 * Which of a parent's children the rasteriser may drop: the trailing run that
 * renders entirely below the fold.
 *
 * THIS IS THE SINGLE BIGGEST THING THE CAPTURE DOES. Measured on the Deck
 * Builder (3702 nodes): the rasteriser serialises the cloned DOM into an
 * intermediate SVG — **41 MB** of it — and building that string, not fetching
 * images and not copying styles, is where the time goes. Nearly all of those
 * nodes are scrolled off the bottom and cannot contribute a visible pixel.
 * Dropping them took a capture from **10.4 s to 0.7 s**, with the two images
 * compared pixel for pixel.
 *
 * WHY A TRAILING RUN OF SIBLINGS AND NOT "EVERY OFF-SCREEN ELEMENT". Removing an
 * element can move the ones around it: a grid re-flows into the gap, a centred
 * column re-centres. But nothing placed BEFORE an element depends on what comes
 * after it, so dropping a trailing run of children cannot disturb what is on
 * screen, whereas dropping one from the middle can.
 *
 * Per PARENT, and not once over the whole document, because a page with columns
 * defeats the document-wide version: the Deck Builder's long card grid is
 * followed in DOM order by a short side panel that sits above the fold, so the
 * document-wide suffix was empty and the grid was never pruned (11.1 s, exactly
 * as if the optimisation were not there).
 *
 * TWO KINDS OF "NO BOX", and conflating them was a real defect. An element with
 * no measurable rect must not ANCHOR the run — the reporter's own launcher
 * button is `position: fixed` at the bottom of the viewport and is the last node
 * in the body, and while it anchored, nothing anywhere was pruned. But it must
 * not be PRUNED either: `<option>` elements have no rect, and pruning them
 * emptied the sort dropdown — the capture came back with a blank box where the
 * word "Name" should be. Only an element with a real box, entirely below the
 * fold, is safe to drop.
 *
 * `tops` are `getBoundingClientRect().top` per child, in order, or `null` for a
 * child with no box or one the capture is skipping anyway.
 */
export function prunableChildIndices(
  tops: readonly (number | null)[],
  viewportHeight: number,
): number[] {
  let lastAnchor = -1;
  for (let i = 0; i < tops.length; i += 1) {
    const top = tops[i];
    if (top === null || top === undefined) continue;
    // NaN keeps the element: a node we cannot measure must never be the one
    // silently cut out of the picture.
    if (!Number.isFinite(top) || top <= viewportHeight) lastAnchor = i;
  }

  const prunable: number[] = [];
  for (let i = lastAnchor + 1; i < tops.length; i += 1) {
    const top = tops[i];
    if (top === null || top === undefined || !Number.isFinite(top)) continue;
    if (top > viewportHeight) prunable.push(i);
  }
  return prunable;
}

/** The index of the last child that anchors the run; -1 when none does. */
export function lastAnchoringChild(
  tops: readonly (number | null)[],
  viewportHeight: number,
): number {
  let last = -1;
  for (let i = 0; i < tops.length; i += 1) {
    const top = tops[i];
    if (top === null || top === undefined) continue;
    if (!Number.isFinite(top) || top <= viewportHeight) last = i;
  }
  return last;
}

/**
 * WHICH `<option>` ELEMENTS CANNOT DRAW A PIXEL — the Lab's 12-second timeout
 * (bug report 20260902_231525, "bug reporter not working, says screen could not
 * be captured": `page rasterisation timed out after 12000 ms`).
 *
 * Measured from the report's OWN clip rather than guessed: the frozen frame's
 * DOM is 10,540 nodes, of which **5,140 are `<option>`** — the A/B Swap tab
 * mounts two card pickers over the whole 5,097-card pool. Nothing else on the
 * page is heavy (no image, no SVG, no canvas), which is why the Lab looks light
 * when you measure it on another tab and is pathological on that one.
 *
 * The below-fold pruning above cannot help, and says so in its own header: an
 * `<option>` has no bounding box, and dropping boxless children once emptied a
 * dropdown's label. But "no box" is not "draws nothing": a CLOSED select paints
 * exactly its selected option, so every OTHER option is provably invisible and
 * safe to drop — which keeps the label the earlier regression lost while
 * removing 5,138 nodes from the serialised clone.
 *
 * A select that is `multiple` or has `size > 1` renders its options as a list
 * box, so none of them is dropped: that one really does draw.
 */
export function optionIsPrunable(option: {
  readonly selected: boolean;
  readonly multiple: boolean;
  readonly size: number;
}): boolean {
  if (option.multiple || option.size > 1) return false;
  return !option.selected;
}

/**
 * How the capture is attempted, in order. The first attempt is the honest
 * picture; each later one gives something up to finish at all, and the report
 * says which one produced the image. A report with a degraded screenshot is
 * worth far more than a report with none (rule 6), and "could not be captured"
 * was the reporter's own complaint.
 */
export interface CaptureAttempt {
  /** Named for the note the report carries. */
  readonly id: 'full' | 'reduced';
  /** This attempt's own budget, in ms. */
  readonly timeoutMs: number;
  /** Skip embedding web fonts (they are re-fetched and inlined per capture). */
  readonly skipFonts: boolean;
  /** Drop every image, not only the off-screen ones. */
  readonly dropImages: boolean;
}

/** The attempt ladder (see {@link CaptureAttempt}). */
export const CAPTURE_ATTEMPTS: readonly CaptureAttempt[] = Object.freeze([
  { id: 'full', timeoutMs: CAPTURE_TIMEOUT_MS, skipFonts: false, dropImages: false },
  // Half the budget, because this one exists to finish: no fonts to fetch and
  // no images to inline leaves the DOM serialisation and nothing else.
  { id: 'reduced', timeoutMs: CAPTURE_TIMEOUT_MS / 2, skipFonts: true, dropImages: true },
]);

/** The note a degraded-but-real capture carries, or '' for the clean one. */
export function attemptNote(attempt: CaptureAttempt): string {
  if (attempt.id === 'full') return '';
  return 'the first capture timed out; this frame was taken without card art or web fonts';
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
