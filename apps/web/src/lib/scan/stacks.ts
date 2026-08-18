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
 * HOW A PILE IS READ, in two steps with two different instruments:
 *
 *   1. WHERE the piles are — busyness. Cards are busy, cloth is flat, so a
 *      variance profile finds the columns of piles and, within a column, the
 *      runs of content; runs separated by a strip of cloth are separate piles
 *      ({@link groupIntoPiles}).
 *
 *   2. HOW MANY copies a pile holds — brightness. Every fanned copy reveals the
 *      pale TITLE PLATE its name is printed on, and that plate is the brightest
 *      thing in its sliver on every kind of card; so the copies are counted as
 *      bright bands, one per copy, bottom card included
 *      ({@link titlePlates} / {@link countCopies}). Busyness cannot do this
 *      job: on a real photo — sleeves, glare, jpeg noise — the dark line
 *      between two copies is every bit as "busy" as the title bars around it,
 *      and stripe-counting misread nearly every pile of a real deck photo that
 *      brightness reads correctly.
 *
 * The card WIDTH is the tile that explains every column band as a whole number
 * of piles ({@link estimateTileExtent} — bands merge when piles sit shoulder to
 * shoulder, so the bands themselves are NOT the card), and the card's fixed
 * 63:88 shape gives the height from that.
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
  CLOSE_PLATE_FRACTION,
  CONTENT_VARIANCE_THRESHOLD,
  FALLBACK_PITCH_OF_CARD,
  FLUSH_PLATE_FRACTION,
  GLARE_CAP_OF_CARD,
  MAX_COPIES_PER_STACK,
  MAX_FAN_PITCH_OF_CARD,
  MIN_CARD_EXTENT_FRACTION,
  MIN_FAN_PITCH_OF_CARD,
  MIN_PILE_HEIGHT_OF_CARD,
  MIN_PLATE_ROWS_OF_CARD,
  PILE_BOTTOM_SLACK_OF_CARD,
  PILE_GAP_OF_CARD,
  PILE_PROFILE_INSET,
  PLATE_BRIGHTNESS_FRACTION,
  PLATE_GAP_BRIDGE_OF_CARD,
  SAME_ROW_TOLERANCE_OF_CARD,
  SPLIT_VALLEY_DEPTH,
  TITLE_BAND_BOTTOM,
  TITLE_BAND_LEFT_INSET,
  TITLE_BAND_RIGHT_INSET,
  TITLE_BAND_TOP,
  TITLE_STRIPE_PADDING,
  VALLEY_MAX_WIDTH_OF_CARD,
  VALLEY_PROMINENCE,
} from './config.js';
import { titleBandOf } from './crop.js';
import {
  estimateTileExtent,
  findBands,
  lineVariance,
  splitByCardSize,
  toLuminance,
} from './detect.js';
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
 * Mean brightness of each row of a rectangle.
 *
 * Copy boundaries are invisible to a VARIANCE profile: the rows of a title bar
 * are busy and so are the rows of the dark line between two title bars once
 * glare, sleeve texture and jpeg noise are on them. What actually separates two
 * copies to the eye is that the line is DARK and the title bars around it are
 * BRIGHT — so counting copies works on brightness, not busyness.
 */
export function rowBrightness(luma: Float32Array, imageWidth: number, rect: Rect): Float32Array {
  const out = new Float32Array(Math.max(0, rect.height));
  if (rect.width <= 0) return out;
  for (let y = 0; y < out.length; y += 1) {
    const row = (rect.y + y) * imageWidth;
    let sum = 0;
    for (let x = 0; x < rect.width; x += 1) sum += luma[row + rect.x + x] ?? 0;
    out[y] = sum / rect.width;
  }
  return out;
}

/**
 * The copy boundaries in one pile's brightness profile: every narrow dark dip
 * between two bright stretches.
 *
 * A dip qualifies when its floor sits below {@link VALLEY_PROMINENCE} of the
 * brighter of its neighbouring peaks (each peak taken within a fan offset, so a
 * boundary is always compared against the title bars beside it) and the run of
 * dark rows is narrower than {@link VALLEY_MAX_WIDTH_OF_CARD} — a boundary is a
 * LINE, while dark card art or the cloth below the pile is a dark REGION and is
 * rejected by its width.
 *
 * Positions are offsets into the profile (i.e. relative to the pile's top),
 * each at the darkest row of its dip. Depth is how far below its neighbouring
 * peaks the floor sits (0 = barely qualified, →1 = pitch black between bright
 * bars), which the comb fit uses to weigh trustworthy valleys over marginal
 * ones.
 */
export interface Valley {
  readonly position: number;
  readonly depth: number;
}

export function copyBoundaries(profile: Float32Array, cardHeight: number): Valley[] {
  const window = Math.max(1, Math.round(cardHeight * MAX_FAN_PITCH_OF_CARD));
  const maxWidth = Math.max(1, Math.round(cardHeight * VALLEY_MAX_WIDTH_OF_CARD));
  const length = profile.length;
  if (length === 0) return [];

  // Rolling peak to each side of every row, one fan offset wide.
  const leftPeak = new Float32Array(length);
  const rightPeak = new Float32Array(length);
  for (let y = 0; y < length; y += 1) {
    let peak = 0;
    for (let i = Math.max(0, y - window); i < y; i += 1) {
      const value = profile[i] ?? 0;
      if (value > peak) peak = value;
    }
    leftPeak[y] = peak;
  }
  for (let y = length - 1; y >= 0; y -= 1) {
    let peak = 0;
    for (let i = Math.min(length - 1, y + window); i > y; i -= 1) {
      const value = profile[i] ?? 0;
      if (value > peak) peak = value;
    }
    rightPeak[y] = peak;
  }

  const boundaries: Valley[] = [];
  let runStart = -1;
  let floorAt = -1;
  let floor = Number.POSITIVE_INFINITY;
  for (let y = 0; y <= length; y += 1) {
    const value = profile[y] ?? Number.POSITIVE_INFINITY;
    const reference = Math.max(leftPeak[y] ?? 0, rightPeak[y] ?? 0);
    const inValley = y < length && value < VALLEY_PROMINENCE * reference;
    if (inValley) {
      if (runStart < 0) {
        runStart = y;
        floorAt = y;
        floor = value;
      } else if (value < floor) {
        floorAt = y;
        floor = value;
      }
    } else if (runStart >= 0) {
      if (y - runStart <= maxWidth) {
        const referenceAtFloor = Math.max(leftPeak[floorAt] ?? 0, rightPeak[floorAt] ?? 0);
        const depth = referenceAtFloor > 0 ? 1 - floor / referenceAtFloor : 0;
        boundaries.push({ position: floorAt, depth });
      }
      runStart = -1;
      floor = Number.POSITIVE_INFINITY;
    }
  }
  return boundaries;
}

/**
 * The TITLE PLATES visible in one pile — one per copy, which makes them the
 * thing to count.
 *
 * Every fanned copy reveals the same sliver of itself: the pale plate its name
 * is printed on. That plate is the brightest thing in the sliver whatever the
 * card looks like — dark art, pale art, black or white border — so the copies
 * appear as bright bands in the pile's brightness profile, one band per copy,
 * bottom card included. Counting bands needs none of the "which dark line is a
 * card edge" disambiguation that counting boundaries does, because art, text
 * and boundaries are all simply NOT plates.
 *
 * The bands returned here are raw: bright runs within the pile's fanned zone
 * (a plate cannot START lower than `pileHeight - cardHeight` plus
 * {@link PILE_BOTTOM_SLACK_OF_CARD} — its copy would hang off the pile), with
 * dips bridged per {@link PLATE_GAP_BRIDGE_OF_CARD} EXCEPT across a
 * {@link SPLIT_VALLEY_DEPTH} valley, which is a card edge: two nearly-flush
 * copies can show their plates a couple of pixels apart, and that valley is the
 * only sign they are two. Which bands are truly copies is decided against the
 * photo's fan pitch in {@link countCopies}.
 */
/** One title plate: its bright rows, and the single brightest row within them. */
export interface Plate {
  readonly start: number;
  readonly end: number;
  /** The brightest row — the plate's POSITION for all spacing arithmetic. */
  readonly at: number;
}

export function titlePlates(
  profile: Float32Array,
  valleys: readonly Valley[],
  pileHeight: number,
  cardHeight: number,
): Plate[] {
  const maxReach = pileHeight - cardHeight + cardHeight * PILE_BOTTOM_SLACK_OF_CARD;
  if (maxReach < 0) return [];
  // A plate sits TITLE_BAND_TOP below its copy's top edge, and its rows extend
  // a little further still.
  const maxStart = maxReach + cardHeight * TITLE_BAND_TOP;
  const zoneEnd = Math.min(
    profile.length,
    Math.ceil(maxStart + cardHeight * (TITLE_BAND_BOTTOM - TITLE_BAND_TOP)),
  );

  let peak = 0;
  for (let y = 0; y <= Math.min(profile.length - 1, Math.floor(maxStart)); y += 1) {
    const value = profile[y] ?? 0;
    if (value > peak) peak = value;
  }
  if (peak <= 0) return [];
  const threshold = peak * PLATE_BRIGHTNESS_FRACTION;

  // Bright runs, then bridge the dips that are notches rather than edges.
  const runs: Band[] = [];
  let start = -1;
  for (let y = 0; y <= zoneEnd; y += 1) {
    const bright = y < zoneEnd && (profile[y] ?? 0) >= threshold;
    if (bright && start < 0) start = y;
    if (!bright && start >= 0) {
      runs.push({ start, end: y - 1 });
      start = -1;
    }
  }

  const bridge = Math.max(1, Math.round(cardHeight * PLATE_GAP_BRIDGE_OF_CARD));
  const isEdge = (from: number, to: number): boolean =>
    valleys.some(
      (v) => v.position > from && v.position <= to && v.depth >= SPLIT_VALLEY_DEPTH,
    );
  const bands: Band[] = [];
  for (const run of runs) {
    const previous = bands[bands.length - 1];
    if (previous && run.start - previous.end - 1 <= bridge && !isEdge(previous.end, run.start)) {
      bands[bands.length - 1] = { start: previous.start, end: run.end };
    } else {
      bands.push(run);
    }
  }

  const minRows = Math.max(2, Math.round(cardHeight * MIN_PLATE_ROWS_OF_CARD));

  // Sleeve glare: an oversized sleeve's rim catches light ABOVE the top copy,
  // and that bright line is not a plate. It is recognisable because the top
  // card's own edge — a deep valley — sits just below it, still within
  // {@link GLARE_CAP_OF_CARD} of the pile's top. The LOWEST such valley is the
  // card edge (the glare itself can cast an earlier dark line).
  let glareEdge: Valley | undefined;
  for (const v of valleys) {
    if (v.depth >= SPLIT_VALLEY_DEPTH && v.position <= cardHeight * GLARE_CAP_OF_CARD) {
      glareEdge = v;
    }
  }

  return bands
    .filter(
      (band) =>
        band.end - band.start + 1 >= minRows &&
        band.start <= maxStart &&
        (glareEdge === undefined || band.end > glareEdge.position),
    )
    .map((band) => {
      let at = band.start;
      for (let y = band.start; y <= band.end; y += 1) {
        if ((profile[y] ?? 0) > (profile[at] ?? 0)) at = y;
      }
      return { ...band, at };
    });
}

/**
 * Decide which of a pile's plate bands are really copies, and count them.
 *
 * Brightness alone leaves one impostor: pale ART. A golden temple or a
 * green-lit beast can be as bright as a plate, so the bottom card (the only
 * fully visible one) can contribute a second band right below its own plate.
 * What separates that from a genuine extra copy is the fan's PITCH: a fan
 * offsets every copy by about a title bar, so two bands closer than
 * {@link CLOSE_PLATE_FRACTION} of the photo's pitch are the same copy — unless
 * a {@link SPLIT_VALLEY_DEPTH} valley between them proves a card edge, which is
 * how two nearly-flush copies still count as two.
 *
 * `photoPitch` is measured across the whole photo (median spacing of adjacent
 * plates in every pile) because every pile was fanned by the same hand in one
 * sitting; a single short pile has too few plates to know its own pitch.
 */
export function countCopies(
  plates: readonly Plate[],
  valleys: readonly Valley[],
  photoPitch: number,
): { count: number; copies: Plate[] } {
  const copies: Plate[] = [];
  for (const plate of plates) {
    const previous = copies[copies.length - 1];
    if (previous) {
      const spacing = plate.at - previous.at;
      if (spacing < photoPitch * CLOSE_PLATE_FRACTION) {
        // The one legitimate way to be this close: two copies slid almost
        // FLUSH, provable by the upper card's edge between the plates.
        const flush =
          spacing <= photoPitch * FLUSH_PLATE_FRACTION &&
          valleys.some(
            (v) =>
              v.position > previous.at && v.position <= plate.at && v.depth >= SPLIT_VALLEY_DEPTH,
          );
        if (!flush) continue;
      }
    }
    copies.push(plate);
    if (copies.length >= MAX_COPIES_PER_STACK) break;
  }
  if (copies.length === 0) copies.push({ start: 0, end: 0, at: 0 });
  return { count: copies.length, copies };
}

/**
 * Turn one pile — its extent and its counted copies — into a {@link CardStack}.
 */
export function stackFromPile(
  pileTop: number,
  pileHeight: number,
  copies: readonly Plate[],
  x: number,
  cardWidth: number,
  cardHeight: number,
  imageHeight = Number.POSITIVE_INFINITY,
): CardStack {
  // The pile reaches a full card below the LAST COPY's plate even when that
  // card's bottom border sank into the cloth — otherwise the review thumbnail
  // would show the fan and crop off the very card the name was read from.
  const lastPlate = copies[copies.length - 1]!;
  const lastCopyTop = pileTop + lastPlate.start - cardHeight * TITLE_BAND_TOP;
  const bottom = Math.min(
    imageHeight,
    Math.max(pileTop + pileHeight, Math.round(lastCopyTop + cardHeight)),
  );
  const bounds: Rect = { x, y: pileTop, width: cardWidth, height: bottom - pileTop };

  // The bottom card's plate first: the fanned copies above it show only the
  // sliver the fan revealed, which can clip a descender, while the bottom
  // card's title bar is whole.
  const ordered = [lastPlate, ...copies.slice(0, -1)];
  const titleBands = ordered.map((plate) =>
    titleBandAt(pileTop + plate.start, plate.end - plate.start + 1, x, cardWidth, cardHeight, imageHeight),
  );

  return { bounds, count: copies.length, titleBands };
}

/**
 * The OCR crop for one title plate: the plate's bright rows padded a little
 * vertically, and inset horizontally to drop the frame edge on the left and the
 * mana cost on the right — the mana symbols OCR as junk that then has to be
 * corrected away.
 *
 * The crop is CAPPED at a title bar's printed height so a band that ran long
 * (glare smearing down a sleeve) still hands OCR a title-sized strip rather
 * than half a card.
 */
function titleBandAt(
  start: number,
  extent: number,
  x: number,
  cardWidth: number,
  cardHeight: number,
  imageHeight: number,
): Rect {
  const printedTitleHeight = cardHeight * (TITLE_BAND_BOTTOM - TITLE_BAND_TOP);
  const height = Math.min(extent, printedTitleHeight);
  const pad = Math.max(1, Math.round(height * TITLE_STRIPE_PADDING));
  const top = Math.max(0, start - pad);
  const bottom = Math.min(imageHeight, start + height + pad);
  const left = Math.round(x + cardWidth * TITLE_BAND_LEFT_INSET);
  const right = Math.round(x + cardWidth * (1 - TITLE_BAND_RIGHT_INSET));
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, Math.round(bottom - top)),
  };
}

/**
 * Split one column's content stripes into piles, by the CLOTH between them.
 *
 * Everything inside one pile sits nearly flush: the flat separators a variance
 * profile shows — a border line, a sleeve lip, the quiet gaps between lines of
 * the bottom card's rules text — are a few pixels tall. The next pile down is a
 * strip of bare cloth away, a good fraction of a card. The two gaps differ by
 * an order of magnitude, so the pile boundary is simply a gap wider than
 * {@link PILE_GAP_OF_CARD}.
 *
 * COUNTING happens elsewhere ({@link copyBoundaries}): a pile's own stripes say
 * little about its copies, because on a real photo the boundaries between
 * copies are often too washed out to split a stripe at all.
 *
 * Piles shorter than {@link MIN_PILE_HEIGHT_OF_CARD} are dropped as clutter — a
 * deck box edge or a stray token in shot is card-WIDE but not card-TALL.
 */
export function groupIntoPiles(stripes: readonly Band[], cardHeight: number): Band[] {
  const maxGap = cardHeight * PILE_GAP_OF_CARD;
  const piles: Band[] = [];
  for (const stripe of stripes) {
    const previous = piles[piles.length - 1];
    if (previous && stripe.start - previous.end - 1 < maxGap) {
      piles[piles.length - 1] = { start: previous.start, end: stripe.end };
    } else {
      piles.push(stripe);
    }
  }
  return piles.filter((pile) => pile.end - pile.start + 1 >= cardHeight * MIN_PILE_HEIGHT_OF_CARD);
}

/**
 * Order piles the way they sit on the table — across each row, then down — so
 * the review grid reads like the photo. Piles in a row share a top edge because
 * that is how a row gets laid out, so grouping by top edge recovers the rows.
 */
function inReadingOrder(
  stacks: readonly CardStack[],
  cardHeight: number,
): { ordered: CardStack[]; rowCount: number } {
  const byTop = [...stacks].sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
  const tolerance = cardHeight * SAME_ROW_TOLERANCE_OF_CARD;

  const rows: CardStack[][] = [];
  for (const stack of byTop) {
    const row = rows[rows.length - 1];
    if (row && stack.bounds.y - row[0]!.bounds.y <= tolerance) row.push(stack);
    else rows.push([stack]);
  }
  return {
    ordered: rows.flatMap((row) => row.sort((a, b) => a.bounds.x - b.bounds.x)),
    rowCount: rows.length,
  };
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

  // A pile is one card wide — but a column BAND is not, because neighbouring
  // piles merge into one band when the surface between them is not flat enough
  // to register. The card width is the tile that explains every band as a whole
  // number of piles (see {@link estimateTileExtent}).
  const cardWidth = estimateTileExtent(
    columnBands,
    Math.max(width, height) * MIN_CARD_EXTENT_FRACTION,
  );
  if (cardWidth === null) return { stacks: [], rows: 0, columns: 0 };
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

  // FIRST PASS: find every pile's candidate title plates. Counting waits until
  // all piles are seen, because the arbiter between "extra copy" and "pale art"
  // is the PHOTO's fan pitch — every pile was fanned by the same hand.
  interface PendingPile {
    readonly x: number;
    readonly top: number;
    readonly height: number;
    readonly plates: Plate[];
    readonly valleys: Valley[];
  }
  const pending: PendingPile[] = [];
  for (let i = 0; i < columns.length; i += 1) {
    const column = columns[i]!;
    const columnWidth = column.end - column.start + 1;
    const inset = Math.round(columnWidth * PILE_PROFILE_INSET);
    const stripes = contentStripes(profiles[i]!, floor, minSeparation);
    for (const pile of groupIntoPiles(stripes, cardHeight)) {
      const pileHeight = pile.end - pile.start + 1;
      // Plates and valleys are read from a BRIGHTNESS profile of the pile's
      // middle strip — see {@link rowBrightness} for why busyness cannot see
      // them.
      const brightness = rowBrightness(luma, width, {
        x: column.start + inset,
        y: pile.start,
        width: columnWidth - inset * 2,
        height: pileHeight,
      });
      const valleys = copyBoundaries(brightness, cardHeight);
      pending.push({
        x: column.start,
        top: pile.start,
        height: pileHeight,
        plates: titlePlates(brightness, valleys, pileHeight, cardHeight),
        valleys,
      });
    }
  }

  // The photo's fan pitch: the median spacing between adjacent plates across
  // every pile. Falls back to a title bar's height when the photo has too few
  // fanned plates to measure (a grid of single cards, one short pile).
  const spacings: number[] = [];
  for (const pile of pending) {
    for (let i = 1; i < pile.plates.length; i += 1) {
      const spacing = pile.plates[i]!.at - pile.plates[i - 1]!.at;
      if (spacing >= cardHeight * MIN_FAN_PITCH_OF_CARD) spacings.push(spacing);
    }
  }
  spacings.sort((a, b) => a - b);
  const photoPitch =
    spacings[Math.floor(spacings.length / 2)] ?? cardHeight * FALLBACK_PITCH_OF_CARD;

  const found: CardStack[] = [];
  for (const pile of pending) {
    const { copies } = countCopies(pile.plates, pile.valleys, photoPitch);
    found.push(
      stackFromPile(
        pile.top,
        pile.height,
        copies,
        pile.x,
        cardWidth,
        Math.round(cardHeight),
        height,
      ),
    );
  }

  const { ordered, rowCount } = inReadingOrder(found, cardHeight);
  return { stacks: ordered, rows: rowCount, columns: columns.length };
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
