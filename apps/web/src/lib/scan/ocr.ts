/**
 * The OCR engine, and the browser glue for turning a photo into pixels.
 *
 * Tesseract is loaded with a dynamic `import()` so its WebAssembly core and
 * English training data — a few megabytes — are downloaded only when someone
 * actually scans a photo, and never weigh on the app's first paint. The library
 * caches those assets itself after the first run.
 *
 * Everything here is browser-only by nature (canvas, WASM). The decisions worth
 * testing — where to crop, how to condition the image, how to correct the text —
 * live in `detect.ts`, `crop.ts` and `match.ts`, which are pure and tested.
 */

import { MAX_IMAGE_EDGE } from './config.js';
import type { MutablePixelImage } from './crop.js';
import type { PixelImage } from './detect.js';

/** A recognizer: pixels in, text out. Injectable so callers can fake it. */
export interface OcrEngine {
  recognize(image: MutablePixelImage): Promise<string>;
  terminate(): Promise<void>;
}

/**
 * Characters Tesseract is allowed to emit. Card names are letters, digits,
 * spaces and a little punctuation; whitelisting stops the engine "reading" frame
 * edges and mana symbols as brackets and slashes, which then have to be
 * normalized away downstream.
 */
const CHARACTER_WHITELIST =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ',-";

/**
 * Tesseract's page-segmentation mode 6: a uniform block of text.
 *
 * A title crop is nominally ONE line, but mode 7 ("single text line") turned
 * out to be the fragile choice on a real photo: a tilted pile puts a sliver of
 * the neighbouring copy's title into the crop, and mode 7 then finds no line at
 * all and returns empty — it did so on legible crops reading "Sunpetal Grove"
 * and "Thragtusk". Mode 6 reads every line it can see; the matcher scores each
 * line against the vocabulary and keeps the best, so the extra sliver costs
 * nothing.
 */
const TEXT_BLOCK_MODE = '6';

/**
 * Wrap a pixel buffer in an `ImageData`. The copy is deliberate: our buffers are
 * typed as backed by any `ArrayBufferLike` (they may come from a worker), while
 * `ImageData` requires a plain `ArrayBuffer`.
 */
function toImageData(image: MutablePixelImage): ImageData {
  return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
}

/** Convert a pixel buffer into a canvas the OCR engine can consume. */
function toCanvas(image: MutablePixelImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('this browser could not provide a 2D canvas for scanning');
  context.putImageData(toImageData(image), 0, 0);
  return canvas;
}

/**
 * Start an OCR worker. Call `terminate()` when the scan finishes — the worker
 * holds the WASM instance and would otherwise outlive the dialog.
 */
export async function createOcrEngine(
  onProgress?: (fraction: number) => void,
): Promise<OcrEngine> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng', undefined, {
    logger: onProgress
      ? (message: { status: string; progress: number }) => {
          if (message.status === 'recognizing text') onProgress(message.progress);
        }
      : undefined,
  });
  await worker.setParameters({
    tessedit_char_whitelist: CHARACTER_WHITELIST,
    tessedit_pageseg_mode: TEXT_BLOCK_MODE as never,
  });

  return {
    async recognize(image) {
      const { data } = await worker.recognize(toCanvas(image));
      return data.text.trim();
    },
    async terminate() {
      await worker.terminate();
    },
  };
}

/**
 * Decode an image file into raw pixels, downscaling very large photos first.
 *
 * Phone cameras produce 12-megapixel images; the detector's variance passes gain
 * nothing from that resolution but pay for it in memory, so we cap the long edge
 * at a size chosen to keep a card's title bar legible ({@link MAX_IMAGE_EDGE}).
 *
 * EXIF ORIENTATION IS APPLIED EXPLICITLY. A phone held upright records a
 * landscape sensor image plus a "rotate me" tag, and browsers disagree about
 * whether an un-hinted `createImageBitmap` honours it. Decoding sideways is not a
 * subtle degradation: the title bands would be cut from the left edge of each
 * card and every single name would come back as noise.
 */
export async function decodeImageFile(file: File, maxEdge = MAX_IMAGE_EDGE): Promise<PixelImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('this browser could not provide a 2D canvas for scanning');
    context.drawImage(bitmap, 0, 0, width, height);

    const imageData = context.getImageData(0, 0, width, height);
    return { width, height, data: imageData.data };
  } finally {
    bitmap.close();
  }
}

/** Render a pixel buffer to a data URL, for the review grid's thumbnails. */
export function toDataUrl(image: MutablePixelImage): string {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) return '';
  context.putImageData(toImageData(image), 0, 0);
  return canvas.toDataURL('image/jpeg', 0.7);
}
