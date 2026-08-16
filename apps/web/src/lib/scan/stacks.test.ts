/**
 * Tests for reading a photo of FANNED PILES — the way a deck actually gets
 * photographed, and the layout the scanner originally could not read at all.
 *
 * The synthetic photos here reproduce the structure of a real one: a dark
 * surface, piles one card wide, each copy offset downward by a fixed amount so
 * its title bar shows, and the bottom card fully visible.
 */

import { describe, expect, it } from 'vitest';
import { CARD_ASPECT_RATIO, CONTENT_VARIANCE_THRESHOLD } from './config.js';
import { toLuminance, type PixelImage } from './detect.js';
import {
  contentStripes,
  copiesFromStripes,
  detectStacks,
  groupIntoPiles,
  rowVariances,
} from './stacks.js';

const CARD_WIDTH = 120;
const CARD_HEIGHT = Math.round(CARD_WIDTH / CARD_ASPECT_RATIO); // 168
/** How far each copy in a pile is slid down — about a title bar's height. */
const FAN_PITCH = 24;

/** A dark surface, like the cloth a deck gets laid out on. */
function surface(width: number, height: number): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 18;
    data[i + 1] = 18;
    data[i + 2] = 18;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

function fill(image: PixelImage, rect: { x: number; y: number; width: number; height: number }, paint: (x: number, y: number) => number): void {
  const data = image.data as Uint8ClampedArray;
  for (let row = 0; row < rect.height; row += 1) {
    for (let column = 0; column < rect.width; column += 1) {
      const px = rect.x + column;
      const py = rect.y + row;
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
      const value = paint(column, row);
      const offset = (py * image.width + px) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
}

/** The flat border-and-sleeve lip at the top of a card, in pixels. */
const CARD_BORDER = 5;

/**
 * Paint one card the way a real one reads to the detector: a FLAT border strip
 * across the top (the frame edge and the sleeve lip — uniform, so low variance),
 * then a busy title plate, then a busy body. The flat strip is the separator
 * that makes each copy in a fan its own stripe.
 */
function paintCard(image: PixelImage, x: number, y: number): void {
  fill(image, { x, y, width: CARD_WIDTH, height: CARD_HEIGHT }, (cx, cy) => {
    if (cy < CARD_BORDER) return 30; // flat frame edge
    if (cy < FAN_PITCH) return (cx + cy) % 3 === 0 ? 150 : 235; // title plate, with text
    return (cx + cy) % 2 === 0 ? 40 : 200; // art and rules text
  });
}

/** Paint a pile of `count` copies fanned downward, and return its bounds. */
function paintPile(
  image: PixelImage,
  x: number,
  y: number,
  count: number,
): { x: number; y: number; width: number; height: number } {
  // Back to front, so each copy overlaps the one behind it the way a real fan does.
  for (let i = 0; i < count; i += 1) paintCard(image, x, y + i * FAN_PITCH);
  return {
    x,
    y,
    width: CARD_WIDTH,
    height: (count - 1) * FAN_PITCH + CARD_HEIGHT,
  };
}

/** The stripes one pile's own column shows: thin title bars, then the whole bottom card. */
function stripesOf(image: PixelImage, x: number): ReturnType<typeof contentStripes> {
  const luma = toLuminance(image);
  const profile = rowVariances(luma, image.width, {
    x,
    y: 0,
    width: CARD_WIDTH,
    height: image.height,
  });
  let peak = 0;
  for (const value of profile) if (value > peak) peak = value;
  return contentStripes(profile, peak * CONTENT_VARIANCE_THRESHOLD, 5);
}

describe('reading a pile', () => {
  it('shows one stripe per copy — thin title bars, then the whole bottom card', () => {
    const image = surface(CARD_WIDTH + 60, 6 * FAN_PITCH + CARD_HEIGHT + 60);
    paintPile(image, 30, 30, 4);

    const stripes = stripesOf(image, 30);

    expect(stripes).toHaveLength(4);
    // The last stripe is a whole card; the rest are just title bars.
    const heights = stripes.map((s) => s.end - s.start + 1);
    expect(heights[3]!).toBeGreaterThan(CARD_HEIGHT * 0.5);
    expect(Math.max(...heights.slice(0, 3))).toBeLessThan(CARD_HEIGHT * 0.5);
  });

  it('counts the copies in a fanned pile', () => {
    const image = surface(CARD_WIDTH + 60, 6 * FAN_PITCH + CARD_HEIGHT + 60);
    paintPile(image, 30, 30, 4);

    const stack = copiesFromStripes(stripesOf(image, 30), 30, CARD_WIDTH, CARD_HEIGHT);

    expect(stack.count).toBe(4);
  });

  it('reads a single card as one copy', () => {
    const image = surface(CARD_WIDTH + 60, CARD_HEIGHT + 60);
    paintPile(image, 30, 30, 1);

    const stack = copiesFromStripes(stripesOf(image, 30), 30, CARD_WIDTH, CARD_HEIGHT);

    expect(stack.count).toBe(1);
  });

  /**
   * The title crops come from the stripes themselves, so they land on the name
   * wherever it actually is. Deriving them from a fraction of a reconstructed
   * card instead put the crop into the art, because a fanned copy's true top
   * edge is hidden under the copy above it.
   */
  it('offers one title crop per copy, the bottom card first', () => {
    const image = surface(CARD_WIDTH + 60, 6 * FAN_PITCH + CARD_HEIGHT + 60);
    paintPile(image, 30, 30, 3);
    const stripes = stripesOf(image, 30);

    const { titleBands } = copiesFromStripes(stripes, 30, CARD_WIDTH, CARD_HEIGHT);

    expect(titleBands).toHaveLength(stripes.length);
    // Bottom card first, then the fan from the top.
    expect(titleBands[0]!.y).toBeGreaterThan(titleBands[1]!.y);
    // Each crop starts at its stripe, and stops short of the mana cost.
    const last = stripes[stripes.length - 1]!;
    expect(titleBands[0]!.y).toBeLessThanOrEqual(last.start);
    expect(titleBands[0]!.x + titleBands[0]!.width).toBeLessThan(30 + CARD_WIDTH);
  });

  /**
   * The bottom card is fully visible, so its title, art and rules text all merge
   * into one stripe as tall as the card. Cropping that whole stripe would feed
   * OCR the entire card — which is exactly the confident nonsense the title-only
   * crop exists to prevent.
   */
  it('crops only the title bar of the bottom card, not its whole face', () => {
    const image = surface(CARD_WIDTH + 60, 6 * FAN_PITCH + CARD_HEIGHT + 60);
    paintPile(image, 30, 30, 3);
    const stripes = stripesOf(image, 30);
    const tallest = Math.max(...stripes.map((s) => s.end - s.start + 1));

    const { titleBands } = copiesFromStripes(stripes, 30, CARD_WIDTH, CARD_HEIGHT);

    expect(tallest).toBeGreaterThan(CARD_HEIGHT * 0.5); // the merged stripe really is card-sized
    expect(titleBands[0]!.height).toBeLessThan(CARD_HEIGHT * 0.25);
  });

  /**
   * A faint card edge that never became its own stripe must not cost a copy: the
   * offset is a median over the edges that WERE seen, and the pile's full span
   * still reaches the last copy.
   */
  it('recovers a copy whose edge was too faint to see', () => {
    const stack = copiesFromStripes(
      [
        { start: 0, end: 14 },
        { start: 20, end: 34 },
        // The edge at 60 went unseen, so copies 3 and 4 merged into one stripe.
        { start: 40, end: 74 },
        { start: 80, end: 94 },
      ],
      0,
      CARD_WIDTH,
      CARD_HEIGHT,
    );

    expect(stack.count).toBe(5);
  });

  it('never reports fewer than one copy', () => {
    expect(copiesFromStripes([{ start: 0, end: 14 }], 0, CARD_WIDTH, CARD_HEIGHT).count).toBe(1);
  });
});

describe('grouping stripes into piles', () => {
  /**
   * The layout a real column actually produces, and the one that defeats the
   * simpler rules: four evenly-spaced title bars, then the bottom card's art as
   * one band, then a stripe per line of its rules text, then the next pile.
   * Neither "a stripe tall enough to be a card" nor "a gap of a card height"
   * separates those — but only the title bars are evenly spaced AND equally tall.
   */
  const REAL_COLUMN = [
    { start: 58, end: 71 },
    { start: 96, end: 109 },
    { start: 134, end: 147 },
    { start: 172, end: 185 },
    { start: 199, end: 308 }, // art
    { start: 318, end: 330 }, // rules text, one stripe per line
    { start: 333, end: 345 },
    { start: 348, end: 360 },
    { start: 534, end: 547 }, // next pile
    { start: 572, end: 585 },
    { start: 599, end: 708 },
  ];

  it('keeps only the fan’s regular rhythm, skipping the bottom card’s insides', () => {
    const piles = groupIntoPiles(REAL_COLUMN, 268);

    expect(piles.map((pile) => pile.length)).toEqual([4, 2]);
    expect(piles[0]!.map((s) => s.start)).toEqual([58, 96, 134, 172]);
    expect(piles[1]!.map((s) => s.start)).toEqual([534, 572]);
  });

  /**
   * A lone card also shows two stripes — its title bar and its art — at an
   * offset that looks like a plausible fan. What separates it from a pile of two
   * is that the whole thing spans only ONE card, which is what the count
   * measures; going by the number of stripes would call it two.
   */
  it('reads a lone card as one copy, not as a pile of two', () => {
    const stripes = [
      { start: 58, end: 71 },
      { start: 99, end: 226 },
    ];

    expect(groupIntoPiles(stripes, 168)).toHaveLength(1);
    expect(copiesFromStripes(stripes, 0, CARD_WIDTH, CARD_HEIGHT).count).toBe(1);
  });

  it('reads a pile of two whose bottom card merged into one stripe', () => {
    // The same two-stripe shape, but spanning a card AND a fan offset.
    const stripes = [
      { start: 58, end: 71 },
      { start: 99, end: 267 },
    ];

    expect(copiesFromStripes(stripes, 0, CARD_WIDTH, CARD_HEIGHT).count).toBe(2);
  });

  it('splits piles that are a whole card apart even with no other cue', () => {
    const piles = groupIntoPiles(
      [
        { start: 0, end: 13 },
        { start: 300, end: 313 },
      ],
      268,
    );

    expect(piles).toHaveLength(2);
  });

  it('handles a column with nothing in it', () => {
    expect(groupIntoPiles([], 268)).toEqual([]);
  });
});

describe('detectStacks', () => {
  /**
   * THE PHOTO THIS FEATURE FAILED ON. Two rows of piles on a dark cloth, each
   * pile a different depth — which is what a real deck looks like, and what the
   * grid-only scanner reported as "could not pick out the cards".
   */
  it('reads two rows of piles of differing depths, with their counts', () => {
    const gap = 40;
    const depths = [
      [4, 1, 3, 2],
      [2, 4, 1, 1],
    ];
    const tallest = Math.max(...depths.flat());
    const rowHeight = (tallest - 1) * FAN_PITCH + CARD_HEIGHT;
    const image = surface(
      gap + 4 * (CARD_WIDTH + gap),
      gap + 2 * (rowHeight + gap),
    );
    for (let row = 0; row < depths.length; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        paintPile(
          image,
          gap + column * (CARD_WIDTH + gap),
          gap + row * (rowHeight + gap),
          depths[row]![column]!,
        );
      }
    }

    const { stacks, rows, columns } = detectStacks(image);

    expect(rows).toBe(2);
    expect(columns).toBe(4);
    expect(stacks).toHaveLength(8);
    expect(stacks.map((stack) => stack.count)).toEqual(depths.flat());
  });

  it('does not let a tall pile inflate the count of a short neighbour', () => {
    // A pile of one beside a pile of five: without measuring each pile in its
    // own column, the short one inherits the row band and reads as five.
    const gap = 40;
    const rowHeight = 4 * FAN_PITCH + CARD_HEIGHT;
    const image = surface(gap + 2 * (CARD_WIDTH + gap), rowHeight + 2 * gap);
    paintPile(image, gap, gap, 5);
    paintPile(image, gap + CARD_WIDTH + gap, gap, 1);

    const { stacks } = detectStacks(image);

    expect(stacks.map((stack) => stack.count)).toEqual([5, 1]);
  });

  it('ignores the empty tail of a row', () => {
    const gap = 40;
    const rowHeight = CARD_HEIGHT;
    const image = surface(gap + 4 * (CARD_WIDTH + gap), rowHeight + 2 * gap);
    paintPile(image, gap, gap, 1);
    paintPile(image, gap + (CARD_WIDTH + gap), gap, 1);

    expect(detectStacks(image).stacks).toHaveLength(2);
  });

  it('returns nothing for a photo of bare cloth', () => {
    expect(detectStacks(surface(400, 400)).stacks).toEqual([]);
  });

  it('handles a zero-sized image without throwing', () => {
    expect(detectStacks({ width: 0, height: 0, data: new Uint8ClampedArray(0) }).stacks).toEqual([]);
  });
});

describe('contentStripes', () => {
  it('finds the busy runs and ignores the flat gaps between them', () => {
    const profile = new Float32Array(100);
    profile.fill(50, 10, 30);
    profile.fill(50, 40, 60);

    expect(contentStripes(profile, 10, 5)).toEqual([
      { start: 10, end: 29 },
      { start: 40, end: 59 },
    ]);
  });

  it('does not let a flicker inside one title bar start a second stripe', () => {
    const profile = new Float32Array(100);
    profile.fill(50, 10, 20);
    profile.fill(0, 20, 21); // a one-pixel dip mid-plate
    profile.fill(50, 21, 30);

    expect(contentStripes(profile, 10, 15)).toEqual([{ start: 10, end: 29 }]);
  });

  it('reports nothing for a flat column', () => {
    expect(contentStripes(new Float32Array(50), 10, 5)).toEqual([]);
  });
});
