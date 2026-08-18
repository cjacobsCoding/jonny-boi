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
 * FLAT. So we measure per-column and per-row pixel variance and mark the busy
 * runs as card bands. That is a handful of array passes, needs no libraries, and
 * — because it works on plain pixel arrays — is fully unit-testable in Node with
 * synthetic images.
 *
 * Busy-versus-flat alone is not enough, though, because it only ever sees the
 * gaps BETWEEN cards, and people lay cards out touching. The second half of the
 * idea is that every Magic card is the same size and shape: once we know one
 * card's width we know its height, and every band in the photo must be a whole
 * number of cards across. So we search for the single card size that best
 * explains the bands on BOTH axes at once and slice the bands up by it. A row of
 * ten touching cards is one band of content, but only one card size makes that
 * band ten cards wide AND the rows one card tall — which is why this reads a
 * tightly-packed layout that gap-hunting alone cannot.
 *
 * When the photo still does not cooperate (a patterned tablecloth, a photo of
 * something that is not a deck), detection is not the last word: {@link gridCells}
 * builds the same cells from a rows × columns the user types in, so the feature
 * degrades to "tell us the layout" instead of failing (DESIGN §1.6).
 *
 * Pure: no DOM, no canvas — callers hand in pixels.
 */

import {
  ASPECT_RATIO_TOLERANCE,
  CARD_ASPECT_RATIO,
  CONTENT_VARIANCE_THRESHOLD,
  INTERNAL_GAP_FRACTION,
  MAX_CARDS_PER_BAND,
  MAX_LAYOUT_RESIDUAL,
  MIN_BAND_OF_CARD,
  MIN_CARD_EXTENT_FRACTION,
  MIN_CELL_OCCUPANCY,
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
export interface Band {
  readonly start: number;
  readonly end: number;
}

/** How many columns/rows a band spans (bands are inclusive). */
function extentOf(band: Band): number {
  return band.end - band.start + 1;
}

/** Middle value of a list — robust to the odd speck in a way a mean is not. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
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

/** Raw runs of the profile that sit above the content threshold. */
export function contentRuns(profile: Float32Array): Band[] {
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
  return runs;
}

/**
 * Group a normalized variance profile into content bands: runs above the
 * threshold, with narrow gaps bridged (a card's inner frame line is a dip, not a
 * card boundary) and short runs dropped as speckle.
 *
 * "Narrow" is measured against the typical run, i.e. against a card, rather than
 * against the photo — see {@link INTERNAL_GAP_FRACTION}. Bridging is deliberately
 * timid: separating cards that genuinely touch is not this function's job, it is
 * {@link splitByCardSize}'s.
 */
export function findBands(profile: Float32Array): Band[] {
  const runs = contentRuns(profile);
  if (runs.length === 0) return [];

  const typicalRun = median(runs.map(extentOf));
  const minGap = Math.max(1, Math.round(typicalRun * INTERNAL_GAP_FRACTION));
  const minBand = Math.max(1, Math.round(typicalRun * MIN_BAND_OF_CARD));

  const merged: Band[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous && run.start - previous.end - 1 < minGap) {
      merged[merged.length - 1] = { start: previous.start, end: run.end };
    } else {
      merged.push(run);
    }
  }

  return merged.filter((band) => extentOf(band) >= minBand);
}

/**
 * How far a band sits from a whole number of cards, in cards. Zero means the
 * band is exactly N cards across; 0.5 means it is N-and-a-half.
 */
function tilingResidual(extent: number, cardExtent: number): number {
  const count = Math.max(1, Math.round(extent / cardExtent));
  return Math.abs(extent - count * cardExtent) / cardExtent;
}

/** Mean tiling residual of a set of bands against one card size. */
function axisResidual(bands: readonly Band[], cardExtent: number): number {
  if (bands.length === 0) return 0;
  let total = 0;
  for (const band of bands) total += tilingResidual(extentOf(band), cardExtent);
  return total / bands.length;
}

/**
 * Estimate the card WIDTH that explains the photo. A card's height follows from
 * its width, so this one number fixes the whole layout — which is what lets the
 * next step cut a row of touching cards apart.
 *
 * Each axis offers an estimate: the typical (median) band on that axis. The two
 * are then reconciled by taking the SMALLER, and the asymmetry is deliberate.
 * The errors here are not symmetric — cards that touch merge into one oversized
 * band and inflate an estimate, while nothing deflates one (a card split in two
 * by a gap would, but {@link findBands} has already bridged gaps that narrow).
 * So when the axes disagree it is because one of them merged, and the axis that
 * still sees gaps is the one telling the truth. That is exactly the case of a
 * deck laid out in tight rows with clear space between the rows.
 *
 * Returns `null` when the result cannot be trusted — a card implausibly small
 * for the frame, or bands that are not a whole number of cards across after all.
 * The caller then asks the user for the layout rather than inventing one.
 */
export function estimateCardWidth(
  columnBands: readonly Band[],
  rowBands: readonly Band[],
  imageWidth: number,
  imageHeight: number,
): number | null {
  if (columnBands.length === 0 || rowBands.length === 0) return null;

  const fromColumns = median(columnBands.map(extentOf));
  // A row band measures card HEIGHTS; convert to a width so the two compare.
  const fromRows = median(rowBands.map(extentOf)) * CARD_ASPECT_RATIO;
  const cardWidth = Math.min(fromColumns, fromRows);
  const cardHeight = cardWidth / CARD_ASPECT_RATIO;

  if (cardWidth < Math.max(imageWidth, imageHeight) * MIN_CARD_EXTENT_FRACTION) return null;
  if (cardWidth > imageWidth || cardHeight > imageHeight) return null;

  // Every band must now be a whole number of cards across. When it is not, we
  // are not looking at a grid of cards at all.
  const residual = axisResidual(columnBands, cardWidth) + axisResidual(rowBands, cardHeight);
  return residual <= MAX_LAYOUT_RESIDUAL ? cardWidth : null;
}

/**
 * The single tile size that best explains a set of bands as whole multiples.
 *
 * A band's own extent is NOT that size: piles or cards that sit close enough
 * merge into one band, so the observed extents are small multiples of the true
 * card — a photo of eight piles can come back as bands of one, one, two and
 * four cards. Taking any average of those extents picks a multiple of the card
 * instead of the card, and every measurement downstream (columns, crops,
 * copy-counting) inherits the doubling. That is exactly what a real photo of a
 * deck on dark cloth did: two merged piles became the "card", and the scanner
 * read half the piles at twice the width.
 *
 * So instead of averaging, every band nominates candidates — its extent divided
 * by each plausible card count — and the candidate whose multiples best fit ALL
 * the bands wins. Ties inside the tolerance go to the LARGEST candidate,
 * because every harmonic of the true card (half, a third…) also tiles the bands
 * perfectly, but no whole multiple of it does.
 *
 * Returns `null` when nothing fits, e.g. bands with no common tile.
 */
export function estimateTileExtent(
  bands: readonly Band[],
  minExtent: number,
  maxResidual: number = MAX_LAYOUT_RESIDUAL,
): number | null {
  const extents = bands.map(extentOf);
  const candidates = new Set<number>();
  for (const extent of extents) {
    for (let count = 1; count <= MAX_CARDS_PER_BAND; count += 1) {
      const candidate = extent / count;
      if (candidate < minExtent) break;
      candidates.add(candidate);
    }
  }

  let best: number | null = null;
  let bestResidual = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const residual = axisResidual(bands, candidate);
    if (residual > maxResidual) continue;
    const better =
      residual < bestResidual - TILE_RESIDUAL_TIE_BREAK ||
      (Math.abs(residual - bestResidual) <= TILE_RESIDUAL_TIE_BREAK && candidate > (best ?? 0));
    if (better) {
      best = candidate;
      bestResidual = residual;
    }
  }
  return best;
}

/**
 * Two candidate tile sizes whose residuals are within this of each other fit
 * the bands equally well as far as the measurement can tell — the difference is
 * noise, and the tie-break (prefer the larger tile) decides. Without a band of
 * slack, a half-card harmonic that fits 0.001 "better" would beat the real card.
 */
const TILE_RESIDUAL_TIE_BREAK = 0.02;

/**
 * Cut each band into the whole number of cards it holds. A band of one card is
 * returned as-is; a row of ten touching cards becomes ten evenly-spaced bands.
 */
export function splitByCardSize(bands: readonly Band[], cardExtent: number): Band[] {
  const out: Band[] = [];
  for (const band of bands) {
    const extent = extentOf(band);
    const count = Math.min(MAX_CARDS_PER_BAND, Math.max(1, Math.round(extent / cardExtent)));
    const step = extent / count;
    for (let i = 0; i < count; i += 1) {
      const start = Math.round(band.start + i * step);
      const end = Math.round(band.start + (i + 1) * step) - 1;
      if (end >= start) out.push({ start, end });
    }
  }
  return out;
}

/** Mean squared deviation of a rectangle's luminance — "how busy is this cell". */
function cellVariance(luma: Float32Array, imageWidth: number, cell: Rect): number {
  const x1 = Math.min(imageWidth, cell.x + cell.width);
  const y1 = cell.y + cell.height;
  let count = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let y = Math.max(0, cell.y); y < y1; y += 1) {
    const row = y * imageWidth;
    for (let x = Math.max(0, cell.x); x < x1; x += 1) {
      const value = luma[row + x] ?? 0;
      sum += value;
      sumSquares += value * value;
      count += 1;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return Math.max(0, sumSquares / count - mean * mean);
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
  const columnBands = findBands(lineVariance(luma, width, height, 'x'));
  const rowBands = findBands(lineVariance(luma, width, height, 'y'));

  const cardWidth = estimateCardWidth(columnBands, rowBands, width, height);
  if (cardWidth === null) return { cells: [], rows: 0, columns: 0 };

  const columns = splitByCardSize(columnBands, cardWidth);
  const rows = splitByCardSize(rowBands, cardWidth / CARD_ASPECT_RATIO);

  const candidates: Rect[] = [];
  for (const row of rows) {
    for (const column of columns) {
      const rect: Rect = {
        x: column.start,
        y: row.start,
        width: column.end - column.start + 1,
        height: row.end - row.start + 1,
      };
      if (looksLikeCard(rect)) candidates.push(rect);
    }
  }

  return {
    cells: keepOccupiedCells(luma, width, candidates),
    rows: rows.length,
    columns: columns.length,
  };
}

/**
 * Drop grid slots that hold no card.
 *
 * A grid is a rectangle but a deck is a count, so the last row of a laid-out
 * sixty is nearly always short. Without this the empty slots would be cropped,
 * OCR'd, and either wasted or — worse — matched to whatever the table grain
 * happened to look like.
 */
function keepOccupiedCells(
  luma: Float32Array,
  imageWidth: number,
  candidates: readonly Rect[],
): Rect[] {
  if (candidates.length === 0) return [];
  const variances = candidates.map((cell) => cellVariance(luma, imageWidth, cell));
  // Measured against the busiest cell rather than the average: card faces differ
  // in busyness far less than a card differs from bare table.
  const busiest = Math.max(...variances);
  if (busiest <= 0) return [];
  return candidates.filter((_, i) => (variances[i] ?? 0) >= busiest * MIN_CELL_OCCUPANCY);
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
