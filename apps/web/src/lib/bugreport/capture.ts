/**
 * The frozen frame — a raster of exactly what the reporter was looking at.
 *
 * This file is the DOM shell only: it reads the viewport and the scroll position,
 * asks the rasteriser, and hands back bytes. Every decision it makes — which
 * region, what to skip, how long to wait, what to say when it fails — lives in
 * `capture-policy.ts`, where it is unit-tested in Node. That split is deliberate
 * and matches the same tool in the two C++ games: the arithmetic that has bitten
 * us is pure and pinned, and only the backend call is untestable.
 *
 * `html-to-image` is loaded with a DYNAMIC import so it lands in its own chunk
 * and the rasteriser is only fetched by someone who actually opens the reporter —
 * a debug tool must not tax the app's first paint (rule 7).
 */
import {
  CAPTURE_IGNORE_ATTR,
  CAPTURE_TIMEOUT_MS,
  captureFailureNote,
  captureOptionsFor,
  isOffScreen,
  prunableChildIndices,
  withTimeout,
} from './capture-policy.js';

export { CAPTURE_IGNORE_ATTR, dataUrlToBytes } from './capture-policy.js';

export interface Capture {
  /** `data:image/png;base64,…`, or empty when rasterising failed. */
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  /** Why the capture is missing or imperfect. Empty when it is clean. */
  readonly note: string;
}

/**
 * The elements the rasteriser can skip: the tail of the document that renders
 * entirely below the fold. Measured once, in one layout pass, because calling
 * getBoundingClientRect from inside the rasteriser's filter would do it
 * thousands of times while the DOM is being cloned.
 */
function belowFoldTail(prune: boolean): Set<Element> {
  const skip = new Set<Element>();
  if (!prune) return skip;
  const viewportHeight = window.innerHeight;

  const anchorTop = (element: Element): number | null => {
    // The reporter's own chrome is removed from the clone anyway, and something
    // that occupies no space draws nothing — neither may anchor the run.
    if (element.hasAttribute(CAPTURE_IGNORE_ATTR)) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return rect.top;
  };

  const prunePastFold = (parent: Element): void => {
    const children = Array.from(parent.children);
    if (children.length === 0) return;
    const tops = children.map(anchorTop);
    const dropped = new Set(prunableChildIndices(tops, viewportHeight));
    for (const index of dropped) skip.add(children[index]!);
    // Recurse into everything KEPT — including the boxless children after the
    // last anchor, which are kept precisely because they still draw something.
    for (let i = 0; i < children.length; i += 1) {
      if (!dropped.has(i)) prunePastFold(children[i]!);
    }
  };

  prunePastFold(document.body);
  return skip;
}

/** The overlay's own chrome, the below-fold tail, and scrolled-past images. */
function shouldSkip(node: Node, tail: ReadonlySet<Element>): boolean {
  if (!(node instanceof Element)) return false;
  if (node.hasAttribute(CAPTURE_IGNORE_ATTR)) return true;
  if (tail.has(node)) return true;
  if (!(node instanceof HTMLImageElement)) return false;
  return isOffScreen(node.getBoundingClientRect(), {
    width: window.innerWidth,
    height: window.innerHeight,
  });
}

/**
 * Capture the visible viewport. NEVER throws and never rejects: a failed capture
 * returns an empty `dataUrl` with the reason in `note`, because a report with a
 * typed description, the state dump and the console ring is still worth far more
 * than no report at all (rule 6).
 */
export async function captureViewport(prune = true): Promise<Capture> {
  const tail = belowFoldTail(prune);
  const options = captureOptionsFor(
    { width: window.innerWidth, height: window.innerHeight },
    { x: window.scrollX, y: window.scrollY },
  );

  try {
    const { toPng } = await import('html-to-image');
    const body = document.body;
    const dataUrl = await withTimeout(
      toPng(body, {
        width: options.width,
        height: options.height,
        style: options.style,
        // 1:1 with CSS pixels: the strokes are stored in these units, and the
        // file has to be small enough to sit in a bug report.
        pixelRatio: 1,
        backgroundColor: window.getComputedStyle(body).backgroundColor || '#0f1419',
        // Cross-origin card art is fetched and inlined by the library; a miss
        // leaves a gap in the image rather than failing the capture.
        cacheBust: false,
        filter: (node) => !shouldSkip(node, tail),
      }),
      CAPTURE_TIMEOUT_MS,
      'page rasterisation',
    );

    return { dataUrl, width: options.width, height: options.height, note: '' };
  } catch (error) {
    return {
      dataUrl: '',
      width: options.width,
      height: options.height,
      note: captureFailureNote(error),
    };
  }
}
