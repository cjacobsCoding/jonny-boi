/**
 * Reading a photo of a deck laid out as FANNED PILES.
 *
 * THIS IS HOW PEOPLE ACTUALLY PHOTOGRAPH A DECK, and it is a better input than
 * the grid of loose cards the scanner originally assumed. Nobody spreads sixty
 * separate cards across a table; they put the four copies of a card in a pile,
 * slide the pile so every copy's title bar peeks out above the one below it, and
 * lay the piles out in rows. One photo then carries both the names AND the
 * quantities — which is exactly the decklist — in a fraction of the space.
 *
 * HOW A PILE READS TO A VARIANCE DETECTOR, and why that is easy. Scan down a
 * pile's own column and the content comes in stripes: a title bar is a plate
 * with a name printed on it, so its rows vary a lot across the width, while the
 * card edge above it — border plus sleeve lip — is a flat line that varies
 * hardly at all. So a pile of four is three thin busy stripes and then one very
 * tall one, the fully visible bottom card. Count the stripes and you have
 * counted the cards.
 *
 * That tall last stripe is also what ENDS a pile, and using it as the boundary
 * is the crux of this module. The obvious alternative — declaring a pile over
 * when the gap gets big — has to separate "the gap between two copies" from "the
 * gap between two rows of piles", and those can be a few pixels apart. A title
 * bar versus a whole card is a factor of ten. So piles are delimited by finding
 * the bottom card, and no gap threshold is tuned anywhere in here.
 *
 * The card WIDTH comes from the column bands, since a pile is exactly one card
 * wide, and the card's fixed 63:88 shape gives the height from that.
 *
 * A pile of one is a pile whose very first stripe is already the bottom card, so
 * this also reads a plain grid of single cards; {@link detectCards} still gets
 * first refusal on the grid case because it can additionally split cards that
 * TOUCH side by side.
 *
 * Assumes the fan runs downward, which is what laying a pile down and pushing
 * the top of it away produces.
 *
 * Pure: no DOM, no canvas — callers hand in pixels.
 */

import {
  CARD_ASPECT_RATIO,
  CONTENT_VARIANCE_THRESHOLD,
  FACE_CARD_MIN_OF_CARD,
  FAN_PITCH_TOLERANCE,
  MAX_COPIES_PER_STACK,
  MIN_CARD_EXTENT_FRACTION,
  MIN_FAN_PITCH_OF_CARD,
  SAME_ROW_TOLERANCE_OF_CARD,
  STRIPE_HEIGHT_TOLERANCE,
  TITLE_BAND_BOTTOM,
  TITLE_BAND_LEFT_INSET,
  TITLE_BAND_RIGHT_INSET,
  TITLE_BAND_TOP,
  TITLE_STRIPE_PADDING,
} from './config.js';
import { titleBandOf } from './crop.js';
import { findBands, lineVariance, splitByCardSize, toLuminance } from './detect.js';
import type { Band, DetectionResult, PixelImage, Rect } from './detect.js';

/** One pile of identical cards. */
export interface CardStack {
  /** The whole pile, fanned copies included — the crop the review grid shows. */
  readonly bounds: Rect;
  /** How many copies of the card the pile holds. */
  readonly count: number;
  /**
   * Crops holding this card's printed name, best first.
   *
   * These come straight from the detected stripes rather than from a fraction of
   * a reconstructed card rect, and that matters: a stripe is found by looking
   * for the letters, so it lands on the name however the card is framed, while
   * "the top 4%–17% of the card" only lands correctly if the card's exact top
   * edge is known — and in a fan it is buried under the copy above.
   *
   * Every copy in a pile is the same card, so the extras are free second
   * opinions when the first read is weak.
   */
  readonly titleBands: readonly Rect[];
}

/** What reading a photo of piles found. */
export interface StackDetectionResult {
  readonly stacks: readonly CardStack[];
  readonly rows: number;
  readonly columns: number;
}

/**
 * RAW variance of each row of a rectangle — deliberately not normalized.
 *
 * Every other variance profile in the scanner is scaled against its own peak,
 * which is right when the question is "where within this profile is the
 * content". Here the question is "does this column hold a card AT ALL", and
 * self-normalization answers that with a confident yes every time: an empty
 * patch of tablecloth scales its own grain up to 1.0. So these stay in absolute
 * units and callers compare them against one reference taken across the photo.
 */
export function rowVariances(luma: Float32Array, imageWidth: number, rect: Rect): Float32Array {
  const out = new Float32Array(Math.max(0, rect.height));
  if (rect.width <= 0) return out;
  for (let y = 0; y < out.length; y += 1) {
    const row = (rect.y + y) * imageWidth;
    let sum = 0;
    let sumSquares = 0;
    for (let x = 0; x < rect.width; x += 1) {
      const value = luma[row + rect.x + x] ?? 0;
      sum += value;
      sumSquares += value * value;
    }
    const mean = sum / rect.width;
    out[y] = Math.max(0, sumSquares / rect.width - mean * mean);
  }
  return out;
}

/** Largest value in a profile. */
function peakOf(profile: Float32Array): number {
  let peak = 0;
  for (const value of profile) if (value > peak) peak = value;
  return peak;
}

/**
 * Runs of content in a profile, in absolute units. `minSeparation` suppresses a
 * flicker of noise inside one title bar from starting a spurious second stripe.
 */
export function contentStripes(
  profile: Float32Array,
  floor: number,
  minSeparation: number,
): Band[] {
  const stripes: Band[] = [];
  let start = -1;
  for (let y = 0; y < profile.length; y += 1) {
    const busy = (profile[y] ?? 0) >= floor;
    if (busy && start < 0) start = y;
    if (!busy && start >= 0) {
      pushStripe(stripes, { start, end: y - 1 }, minSeparation);
      start = -1;
    }
  }
  if (start >= 0) pushStripe(stripes, { start, end: profile.length - 1 }, minSeparation);
  return stripes;
}

/** Append a stripe, merging it into the previous one when they are too close to be separate cards. */
function pushStripe(stripes: Band[], stripe: Band, minSeparation: number): void {
  const previous = stripes[stripes.length - 1];
  if (previous && stripe.start - previous.start < minSeparation) {
    stripes[stripes.length - 1] = { start: previous.start, end: stripe.end };
    return;
  }
  stripes.push(stripe);
}

/**
 * Lower median — the middle value, taking the SMALLER of the two middles on an
 * even count.
 *
 * The bias is deliberate. This averages the offsets between copies in a fan, and
 * the errors are one-sided: a card edge too faint to see merges two copies and
 * DOUBLES an offset, while nothing halves one. Leaning low keeps a single missed
 * edge from dragging the estimate up and losing a copy.
 */
function lowerMedian(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Turn one pile's stripes into copies.
 *
 * The count is the number of fan offsets spanned by the pile's title bars, NOT
 * the raw stripe count — so a card edge too faint to split into its own stripe
 * still gets counted, because the offset is a median over the edges that WERE
 * seen and the span still reaches the last copy.
 *
 * The last stripe's start is the top of the bottom card whether or not that
 * card's body registered as content: a busy body merges into the same stripe as
 * its title bar, and a flat one adds nothing below it. Either way the stripe
 * BEGINS at the bottom card's title bar, which is the only thing measured here.
 */
export function copiesFromStripes(
  stripes: readonly Band[],
  x: number,
  cardWidth: number,
  cardHeight: number,
  imageHeight = Number.POSITIVE_INFINITY,
): CardStack {
  const first = stripes[0]!;
  const last = stripes[stripes.length - 1]!;

  const spacings: number[] = [];
  for (let i = 1; i < stripes.length; i += 1) {
    spacings.push(stripes[i]!.start - stripes[i - 1]!.start);
  }
  const pitch = lowerMedian(spacings);

  // How far the fan reaches, which divided by the offset is the count. Which
  // measurement gives that reach depends on what the last stripe IS:
  //
  //   - a bare title bar (the card's frame line split it off from the art) —
  //     then its START is the top of the bottom card;
  //   - a whole card face (title bar and art merged into one stripe) — then its
  //     END is the bottom of the pile, and the fan's reach is what is left after
  //     taking a card's height off the pile's full span.
  //
  // The second form is also what tells a single card from a pile of two: one
  // title bar above one card-sized stripe spans just a card, so it counts as one
  // — where going by the number of stripes would call it two.
  const merged = last.end - last.start + 1 >= cardHeight * FACE_CARD_MIN_OF_CARD;
  const reach = merged ? last.end + 1 - first.start - cardHeight : last.start - first.start;
  const count =
    pitch > 0 ? clamp(1 + Math.round(reach / pitch), 1, MAX_COPIES_PER_STACK) : 1;

  // The pile reaches a full card below the LAST COPY's title bar even when that
  // card's body was too flat to register — otherwise the review thumbnail would
  // show the fan and crop off the very card the name was read from.
  const lastCopyTop = first.start + (count - 1) * pitch;
  const bottom = Math.min(imageHeight, Math.max(last.end + 1, lastCopyTop + cardHeight));
  const bounds: Rect = { x, y: first.start, width: cardWidth, height: bottom - first.start };

  // The bottom card's stripe first: the fanned copies above it show only the
  // sliver the fan revealed, which can clip a descender, while the bottom card's
  // title bar is whole.
  const ordered = [last, ...stripes.slice(0, -1)];
  const titleBands = ordered.map((stripe) =>
    titleBandOfStripe(stripe, x, cardWidth, cardHeight, imageHeight),
  );

  return { bounds, count, titleBands };
}

/**
 * The OCR crop for one title stripe: the stripe padded a little vertically, and
 * inset horizontally to drop the frame edge on the left and the mana cost on the
 * right — the mana symbols OCR as junk that then has to be corrected away.
 *
 * The crop is CAPPED at a title bar's printed height, because the bottom card's
 * stripe is not just its title bar: that card is fully visible, so its title,
 * art and rules text are all busy and merge into one stripe as tall as the card.
 * Cropping that whole stripe would hand OCR the entire card, which is the thing
 * this pipeline exists to avoid — the art and rules text generate confident
 * nonsense. The title bar is at the TOP of the stripe either way, since a stripe
 * begins where the name does.
 */
function titleBandOfStripe(
  stripe: Band,
  x: number,
  cardWidth: number,
  cardHeight: number,
  imageHeight: number,
): Rect {
  const printedTitleHeight = cardHeight * (TITLE_BAND_BOTTOM - TITLE_BAND_TOP);
  const height = Math.min(stripe.end - stripe.start + 1, printedTitleHeight);
  const pad = Math.max(1, Math.round(height * TITLE_STRIPE_PADDING));
  const top = Math.max(0, stripe.start - pad);
  const bottom = Math.min(imageHeight, stripe.start + height + pad);
  const left = Math.round(x + cardWidth * TITLE_BAND_LEFT_INSET);
  const right = Math.round(x + cardWidth * (1 - TITLE_BAND_RIGHT_INSET));
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, Math.round(bottom - top)),
  };
}

/** Whether two measurements agree to within a fraction of the larger. */
function alike(a: number, b: number, tolerance: number): boolean {
  const larger = Math.max(Math.abs(a), Math.abs(b));
  return larger === 0 || Math.abs(a - b) <= larger * tolerance;
}

/**
 * Split one column's stripes into piles, by looking for the FAN'S RHYTHM.
 *
 * A column does not just show a pile's title bars. Scanning down past the fan,
 * the bottom card contributes its art as one stripe and then — because the gaps
 * between lines of rules text are flat, light card stock — very often one stripe
 * per line of text. So a column of two piles can be four title bars, an art
 * band, seven text lines, and then the next pile.
 *
 * What separates the copies from all of that is that THE COPIES ARE REGULAR and
 * nothing else is. A pile is fanned in one motion, so its title bars are equally
 * spaced and equally tall; the art band is much taller than a title bar, and the
 * text lines sit on a different, tighter rhythm. So a pile is read as the run of
 * stripes that keeps both a constant offset and a constant height, and the run
 * ends at the bottom card's title bar. Everything within one card height below
 * that is the bottom card's own insides, and is skipped.
 *
 * Simpler rules were tried and are not enough: "end the pile at a stripe tall
 * enough to be a card" misses a bottom card whose body fragments into bands, and
 * "end the pile at a gap of a card height" misses it too, because those
 * fragments are never a card height apart.
 */
export function groupIntoPiles(stripes: readonly Band[], cardHeight: number): Band[][] {
  const heightOf = (band: Band): number => band.end - band.start + 1;
  const piles: Band[][] = [];

  let index = 0;
  while (index < stripes.length) {
    const first = stripes[index]!;
    const run: Band[] = [first];
    let pitch = 0;
    let next = index + 1;

    while (next < stripes.length) {
      const stripe = stripes[next]!;
      const spacing = stripe.start - stripes[next - 1]!.start;
      // Beyond a card height it cannot be another copy of this pile: copies
      // overlap by definition, and the next pile is a whole card further down.
      if (spacing >= cardHeight) break;
      if (pitch === 0) pitch = spacing;
      else if (!alike(spacing, pitch, FAN_PITCH_TOLERANCE)) break;

      run.push(stripe);
      next += 1;
      // A stripe on the fan's rhythm but of a different height ends the pile: it
      // is the bottom card, whose title bar merged with its art. Everything
      // below it belongs to that card rather than to another copy.
      if (!alike(heightOf(stripe), heightOf(first), STRIPE_HEIGHT_TOLERANCE)) break;
    }
    piles.push(run);

    // Skip the bottom card's own body — its art and its lines of rules text.
    const bottomCardTop = run[run.length - 1]!.start;
    while (next < stripes.length && stripes[next]!.start < bottomCardTop + cardHeight) next += 1;
    index = next;
  }
  return piles;
}

/** Middle value of the band extents — the typical pile width, i.e. a card. */
function medianExtent(bands: readonly Band[]): number {
  const extents = bands.map((band) => band.end - band.start + 1).sort((a, b) => a - b);
  return extents[Math.floor(extents.length / 2)] ?? 0;
}

/**
 * Order piles the way they sit on the table — across each row, then down — so
 * the review grid reads like the photo. Piles in a row share a top edge because
 * that is how a row gets laid out, so grouping by top edge recovers the rows.
 */
function inReadingOrder(stacks: readonly CardStack[], cardHeight: number): CardStack[] {
  const byTop = [...stacks].sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
  const tolerance = cardHeight * SAME_ROW_TOLERANCE_OF_CARD;

  const rows: CardStack[][] = [];
  for (const stack of byTop) {
    const row = rows[rows.length - 1];
    if (row && stack.bounds.y - row[0]!.bounds.y <= tolerance) row.push(stack);
    else rows.push([stack]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.bounds.x - b.bounds.x));
}

/**
 * Find the piles of cards in a photo.
 *
 * Returns an empty result when the photo cannot be read as piles at all, which
 * the caller turns into "tell us the layout" rather than a wrong decklist.
 */
export function detectStacks(image: PixelImage): StackDetectionResult {
  const { width, height } = image;
  if (width <= 0 || height <= 0) return { stacks: [], rows: 0, columns: 0 };

  const luma = toLuminance(image);
  const columnBands = findBands(lineVariance(luma, width, height, 'x'));
  if (columnBands.length === 0) return { stacks: [], rows: 0, columns: 0 };

  // A pile is one card wide, so the typical column band IS a card. Splitting by
  // it also separates two piles that ended up shoulder to shoulder.
  const cardWidth = medianExtent(columnBands);
  if (cardWidth < Math.max(width, height) * MIN_CARD_EXTENT_FRACTION) {
    return { stacks: [], rows: 0, columns: 0 };
  }
  const cardHeight = cardWidth / CARD_ASPECT_RATIO;
  if (cardWidth > width || cardHeight > height) return { stacks: [], rows: 0, columns: 0 };

  const columns = splitByCardSize(columnBands, cardWidth);

  // Profile each column over the full height of the photo, then read the piles
  // out of the stripes. One reference for the whole image — the busiest row
  // anywhere in it — decides what counts as content, so a bare column is
  // measured against a card rather than against its own noise.
  const profiles = columns.map((column) =>
    rowVariances(luma, width, {
      x: column.start,
      y: 0,
      width: column.end - column.start + 1,
      height,
    }),
  );
  const reference = Math.max(0, ...profiles.map(peakOf));
  if (reference <= 0) return { stacks: [], rows: 0, columns: 0 };

  const floor = reference * CONTENT_VARIANCE_THRESHOLD;
  const minSeparation = Math.max(1, Math.round(cardHeight * MIN_FAN_PITCH_OF_CARD));

  const found: CardStack[] = [];
  for (let i = 0; i < columns.length; i += 1) {
    const column = columns[i]!;
    const stripes = contentStripes(profiles[i]!, floor, minSeparation);
    for (const pile of groupIntoPiles(stripes, cardHeight)) {
      found.push(
        copiesFromStripes(pile, column.start, cardWidth, Math.round(cardHeight), height),
      );
    }
  }

  const stacks = inReadingOrder(found, cardHeight);
  const rowTops = new Set(stacks.map((stack) => Math.round(stack.bounds.y / cardHeight)));
  return { stacks, rows: rowTops.size, columns: columns.length };
}

/**
 * A plain grid of single cards, expressed as piles of one. Here the whole card
 * IS the cell, so the name sits at the printed fraction of it that
 * {@link titleBandOf} knows.
 */
export function stacksFromGrid(grid: DetectionResult): StackDetectionResult {
  return {
    stacks: grid.cells.map((cell) => ({
      bounds: cell,
      count: 1,
      titleBands: [titleBandOf(cell)],
    })),
    rows: grid.rows,
    columns: grid.columns,
  };
}
