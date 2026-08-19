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

/** The overlay's own chrome, and images the viewport does not show. */
function shouldSkip(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  if (node.hasAttribute(CAPTURE_IGNORE_ATTR)) return true;
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
export async function captureViewport(): Promise<Capture> {
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
        filter: (node) => !shouldSkip(node),
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
