/**
 * Finding the cards in a photo of a laid-out deck.
 *
 * THE APPROACH, and why: a proper contour-and-perspective pipeline wants
 * OpenCV, which is an 8 MB WASM download and still struggles with overlapping
 * cards. But the photo we are actually asking for — a deck laid out in rows on
 * a table — has far more structure than a general scene, and that structure is
 * enough.
 *
 * Cards are visually BUSY (art, text, borders); the surface between them is
 * FLAT. So we measure per-column and per-row pixel variance, mark the busy runs
 * as card bands and the flat runs as gaps, and take the grid those bands imply.
 * That is a handful of array passes, needs no libraries, and — because it works
 * on plain pixel arrays — is fully unit-testable in Node with synthetic images.
 *
 * When the photo does not cooperate (a patterned tablecloth, cards touching),
 * detection is not the last word: {@link gridCells} builds the same cells from a
 * rows × columns the user types in, so the feature degrades to "tell us the
 * layout" instead of failing (DESIGN §1.6).
 *
 * Pure: no DOM, no canvas — callers hand in pixels.
 */

import {
  ASPECT_RATIO_TOLERANCE,
  CARD_ASPECT_RATIO,
  CONTENT_VARIANCE_THRESHOLD,
  MIN_BAND_FRACTION,
  MIN_GAP_FRACTION,
} from './config.js';

/** RGBA pixels plus dimensions — structurally compatible with `ImageData`. */
export interface PixelImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  readonly data: Uint8ClampedArray;
}

/** An axis-aligned rectangle in image pixels. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A contiguous run of "content" columns or rows. */
interface Band {
  readonly start: number;
  readonly end: number;
}

/** The outcome of looking for cards in a photo. */
export interface DetectionResult {
  readonly cells: readonly Rect[];
  readonly rows: number;
  readonly columns: number;
}

/** Rec. 709 luminance — how bright a pixel looks, not its raw average. */
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Convert an RGBA image to a single-channel luminance array. */
export function toLuminance(image: PixelImage): Float32Array {
  const { width, height, data } = image;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    out[i] = luminance(data[p] ?? 0, data[p + 1] ?? 0, data[p + 2] ?? 0);
  }
  return out;
}

/**
 * Variance of each column (`axis: 'x'`) or row (`axis: 'y'`) of a luminance
 * image, normalized to 0–1 against the strongest line. Normalizing makes the
 * threshold meaningful regardless of exposure — a dim photo and a bright one
 * both put their card bands near 1.
 */
export function lineVariance(
  luma: Float32Array,
  width: number,
  height: number,
  axis: 'x' | 'y',
): Float32Array {
  const lines = axis === 'x' ? width : height;
  const span = axis === 'x' ? height : width;
  const variances = new Float32Array(lines);

  for (let line = 0; line < lines; line += 1) {
    let sum = 0;
    let sumSquares = 0;
    for (let i = 0; i < span; i += 1) {
      const value = axis === 'x' ? (luma[i * width + line] ?? 0) : (luma[line * width + i] ?? 0);
      sum += value;
      sumSquares += value * value;
    }
    const mean = sum / span;
    variances[line] = Math.max(0, sumSquares / span - mean * mean);
  }

  let peak = 0;
  for (const value of variances) if (value > peak) peak = value;
  if (peak > 0) {
    for (let i = 0; i < variances.length; i += 1) variances[i] = (variances[i] ?? 0) / peak;
  }
  return variances;
}

/**
 * Group a normalized variance profile into content bands: runs above the
 * threshold, with narrow gaps bridged (a card's inner frame line is a dip, not a
 * card boundary) and short runs dropped as noise.
 */
export function findBands(profile: Float32Array, total: number): Band[] {
  const minBand = Math.max(1, Math.floor(total * MIN_BAND_FRACTION));
  const minGap = Math.max(1, Math.floor(total * MIN_GAP_FRACTION));

  // 1. Raw runs above the content threshold.
  const runs: Band[] = [];
  let start = -1;
  for (let i = 0; i < profile.length; i += 1) {
    const isContent = (profile[i] ?? 0) >= CONTENT_VARIANCE_THRESHOLD;
    if (isContent && start < 0) start = i;
    if (!isContent && start >= 0) {
      runs.push({ start, end: i - 1 });
      start = -1;
    }
  }
  if (start >= 0) runs.push({ start, end: profile.length - 1 });

  // 2. Bridge gaps too narrow to be a real separation between two cards.
  const merged: Band[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous && run.start - previous.end - 1 < minGap) {
      merged[merged.length - 1] = { start: previous.start, end: run.end };
    } else {
      merged.push(run);
    }
  }

  // 3. Drop runs too short to be a card.
  return merged.filter((band) => band.end - band.start + 1 >= minBand);
}

/** Whether a rectangle is plausibly a single card, by aspect ratio. */
export function looksLikeCard(rect: Rect): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  const ratio = rect.width / rect.height;
  return Math.abs(ratio - CARD_ASPECT_RATIO) <= ASPECT_RATIO_TOLERANCE;
}

/**
 * Detect the cards in a photo of a laid-out deck.
 *
 * Returns the cells in reading order (left to right, top to bottom) so the
 * review UI lists them the way they sit on the table. An empty result means
 * "could not read this layout" — the caller should offer the manual grid.
 */
export function detectCards(image: PixelImage): DetectionResult {
  const { width, height } = image;
  if (width <= 0 || height <= 0) return { cells: [], rows: 0, columns: 0 };

  const luma = toLuminance(image);
  const columnBands = findBands(lineVariance(luma, width, height, 'x'), width);
  const rowBands = findBands(lineVariance(luma, width, height, 'y'), height);

  const cells: Rect[] = [];
  for (const row of rowBands) {
    for (const column of columnBands) {
      const rect: Rect = {
        x: column.start,
        y: row.start,
        width: column.end - column.start + 1,
        height: row.end - row.start + 1,
      };
      if (looksLikeCard(rect)) cells.push(rect);
    }
  }

  return { cells, rows: rowBands.length, columns: columnBands.length };
}

/**
 * Build an evenly-spaced grid of cells — the manual fallback when detection
 * cannot read a photo. The user says "4 rows of 6" and gets exactly that,
 * inset slightly so neighbouring cards do not bleed into each other's crop.
 */
export function gridCells(
  width: number,
  height: number,
  rows: number,
  columns: number,
  insetFraction = 0.02,
): Rect[] {
  if (rows <= 0 || columns <= 0 || width <= 0 || height <= 0) return [];
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const insetX = cellWidth * insetFraction;
  const insetY = cellHeight * insetFraction;

  const cells: Rect[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      cells.push({
        x: Math.round(column * cellWidth + insetX),
        y: Math.round(row * cellHeight + insetY),
        width: Math.round(cellWidth - insetX * 2),
        height: Math.round(cellHeight - insetY * 2),
      });
    }
  }
  return cells;
}
