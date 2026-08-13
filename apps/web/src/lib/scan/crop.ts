/**
 * Cutting the title strip out of a detected card and preparing it for OCR.
 *
 * Pure pixel work — takes and returns plain arrays, no canvas — so the geometry
 * and the image conditioning are unit-testable without a browser.
 */

import {
  OCR_UPSCALE,
  TITLE_BAND_BOTTOM,
  TITLE_BAND_LEFT_INSET,
  TITLE_BAND_RIGHT_INSET,
  TITLE_BAND_TOP,
} from './config.js';
import type { PixelImage, Rect } from './detect.js';

/** A mutable pixel buffer we can hand back to a canvas. */
export interface MutablePixelImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/**
 * The region of a card that holds its printed name. Trimming to this strip is
 * the single biggest accuracy win in the whole pipeline: OCR over a full card
 * competes with the art and the rules text, while the title bar is one line of
 * high-contrast text on a flat plate.
 */
export function titleBandOf(card: Rect): Rect {
  const x = Math.round(card.x + card.width * TITLE_BAND_LEFT_INSET);
  const right = Math.round(card.x + card.width * (1 - TITLE_BAND_RIGHT_INSET));
  const y = Math.round(card.y + card.height * TITLE_BAND_TOP);
  const bottom = Math.round(card.y + card.height * TITLE_BAND_BOTTOM);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

/** Copy a rectangle out of an image, clamped to its bounds. */
export function cropRegion(image: PixelImage, rect: Rect): MutablePixelImage {
  const x0 = Math.max(0, Math.min(image.width - 1, Math.round(rect.x)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.round(rect.y)));
  const x1 = Math.max(x0 + 1, Math.min(image.width, Math.round(rect.x + rect.width)));
  const y1 = Math.max(y0 + 1, Math.min(image.height, Math.round(rect.y + rect.height)));

  const width = x1 - x0;
  const height = y1 - y0;
  const out = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const sourceRow = (y + y0) * image.width;
    const targetRow = y * width;
    for (let x = 0; x < width; x += 1) {
      const source = (sourceRow + x + x0) * 4;
      const target = (targetRow + x) * 4;
      out[target] = image.data[source] ?? 0;
      out[target + 1] = image.data[source + 1] ?? 0;
      out[target + 2] = image.data[source + 2] ?? 0;
      out[target + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/**
 * Condition a title crop for OCR: convert to greyscale, stretch the contrast so
 * the darkest pixel is black and the lightest white, and nearest-neighbour
 * upscale.
 *
 * Each step targets a specific failure mode seen on real photos — a phone
 * photo's title bar is small (so upscaling helps the engine find letter shapes),
 * often unevenly lit (so a fixed threshold would black out half the strip, while
 * a per-crop stretch adapts), and colour carries no signal for text (so greyscale
 * removes a distraction). Deliberately NOT binarised: Tesseract does its own
 * adaptive thresholding and does it better than a global cutoff.
 */
export function prepareForOcr(crop: PixelImage, upscale = OCR_UPSCALE): MutablePixelImage {
  const grey = new Float32Array(crop.width * crop.height);
  let min = 255;
  let max = 0;
  for (let i = 0, p = 0; i < grey.length; i += 1, p += 4) {
    const value =
      0.2126 * (crop.data[p] ?? 0) + 0.7152 * (crop.data[p + 1] ?? 0) + 0.0722 * (crop.data[p + 2] ?? 0);
    grey[i] = value;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  // A flat crop (all one colour) has no contrast to stretch; leave it alone
  // rather than dividing by zero and producing noise.
  const range = max - min;
  const scale = range > 1 ? 255 / range : 1;
  const offset = range > 1 ? min : 0;

  const factor = Math.max(1, Math.round(upscale));
  const width = crop.width * factor;
  const height = crop.height * factor;
  const out = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.floor(y / factor);
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.floor(x / factor);
      const value = ((grey[sourceY * crop.width + sourceX] ?? 0) - offset) * scale;
      const target = (y * width + x) * 4;
      const clamped = value < 0 ? 0 : value > 255 ? 255 : value;
      out[target] = clamped;
      out[target + 1] = clamped;
      out[target + 2] = clamped;
      out[target + 3] = 255;
    }
  }
  return { width, height, data: out };
}
