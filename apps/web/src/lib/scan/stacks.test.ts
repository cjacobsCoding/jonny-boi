/**
 * Tests for reading a photo of FANNED PILES — the way a deck actually gets
 * photographed, and the layout the scanner originally could not read at all.
 *
 * The synthetic photos here reproduce the structure of a real one: a dark
 * surface, piles one card wide, each copy offset downward by a fixed amount so
 * its title bar shows, and the bottom card fully visible. The REAL-photo cases
 * that this synthetic structure cannot reproduce — glare, washed-out edges,
 * pale art impersonating a title plate — are pinned by `real-photo.test.ts`
 * against an actual photo, and the unit tests here encode each of those shapes
 * against `titlePlates` / `countCopies` directly.
 */

import { describe, expect, it } from 'vitest';
import { CARD_ASPECT_RATIO, CONTENT_VARIANCE_THRESHOLD } from './config.js';
import { toLuminance, type PixelImage } from './detect.js';
import {
  contentStripes,
  copyBoundaries,
  countCopies,
  detectStacks,
  groupIntoPiles,
  rowBrightness,
  rowVariances,
  titlePlates,
  type Plate,
  type Valley,
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
 * Paint one card the way a real one reads to the detector: a FLAT DARK border
 * strip across the top (the frame edge and the sleeve lip), then a BRIGHT title
 * plate with darker text speckle, then a busy mid-brightness body. The dark
 * border is the valley between copies; the bright plate is what gets counted.
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

  it('finds one title plate per copy in the brightness profile', () => {
    const image = surface(CARD_WIDTH + 60, 6 * FAN_PITCH + CARD_HEIGHT + 60);
    paintPile(image, 30, 30, 4);
    const luma = toLuminance(image);

    // The pile's content starts below the first copy's flat border.
    const pileTop = 30 + CARD_BORDER;
    const pileHeight = 3 * FAN_PITCH + CARD_HEIGHT - CARD_BORDER;
    const profile = rowBrightness(luma, image.width, {
      x: 30 + 24,
      y: pileTop,
      width: CARD_WIDTH - 48,
      height: pileHeight,
    });
    const valleys = copyBoundaries(profile, CARD_HEIGHT);
    const plates = titlePlates(profile, valleys, pileHeight, CARD_HEIGHT);

    expect(plates).toHaveLength(4);
    // One plate per fan offset, the bottom card's included.
    const positions = plates.map((plate) => plate.at);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]! - positions[i - 1]!).toBeGreaterThan(FAN_PITCH * 0.7);
      expect(positions[i]! - positions[i - 1]!).toBeLessThan(FAN_PITCH * 1.3);
    }
  });
});

describe('countCopies', () => {
  const pitch = 25;
  const plate = (at: number): Plate => ({ start: at - 4, end: at + 4, at });
  const valley = (position: number, depth: number): Valley => ({ position, depth });

  it('counts plates on the fan pitch as copies', () => {
    const { count } = countCopies([plate(4), plate(29), plate(54)], [], pitch);
    expect(count).toBe(3);
  });

  it('drops a band too close to its predecessor — pale art, not a copy', () => {
    // The real-photo shape: a Thragtusk's bright green art right under the
    // bottom card's plate, closer than any fan offset.
    const { count } = countCopies(
      [plate(4), plate(29), plate(46)],
      [valley(38, 0.42)],
      pitch,
    );
    expect(count).toBe(2);
  });

  it('keeps two nearly-flush copies when a deep valley proves the card edge', () => {
    // The real-photo shape: two Forests slid almost flush, plates 4px apart,
    // with the upper card's edge as a deep dark line between them.
    const { count } = countCopies(
      [plate(4), plate(29), { start: 33, end: 34, at: 34 }],
      [valley(31, 0.75)],
      pitch,
    );
    expect(count).toBe(3);
  });

  it('does not let a shallow dip fake a flush pair', () => {
    const { count } = countCopies(
      [plate(4), plate(29), { start: 33, end: 34, at: 34 }],
      [valley(31, 0.3)],
      pitch,
    );
    expect(count).toBe(2);
  });

  it('reports one copy when no plates were found', () => {
    expect(countCopies([], [], pitch).count).toBe(1);
  });
});

describe('titlePlates', () => {
  const cardHeight = 100;

  /** A profile of dim rows with bright plates painted in. */
  function profileWith(bands: ReadonlyArray<readonly [number, number]>, length: number, dark: ReadonlyArray<readonly [number, number]> = []): Float32Array {
    const profile = new Float32Array(length).fill(60);
    for (const [start, end] of bands) profile.fill(200, start, end + 1);
    for (const [start, end] of dark) profile.fill(5, start, end + 1);
    return profile;
  }

  it('finds the bright bands that start within the fanned zone', () => {
    // Pile of 120 rows against a 100-row card: plates may start only in the
    // top ~43 rows — anything lower would hang its copy off the pile.
    const profile = profileWith([[10, 20], [40, 50], [70, 80]], 120);
    const plates = titlePlates(profile, [], 120, cardHeight);

    expect(plates.map((p) => p.start)).toEqual([10, 40]);
  });

  it('splits a bright band where a deep valley crosses it', () => {
    const profile = profileWith([[10, 20], [23, 33]], 140, [[21, 22]]);
    const valleys = copyBoundaries(profile, cardHeight);
    const plates = titlePlates(profile, valleys, 140, cardHeight);

    expect(plates.map((p) => p.start)).toEqual([10, 23]);
  });

  it('drops the sleeve-glare line above the top copy', () => {
    // Bright rim at the very top, then the top card's edge as a deep valley
    // within the glare cap, then the real plates.
    const profile = profileWith([[2, 4], [10, 20], [40, 50]], 140, [[6, 7]]);
    const valleys = copyBoundaries(profile, cardHeight);
    const plates = titlePlates(profile, valleys, 140, cardHeight);

    expect(plates.map((p) => p.start)).toEqual([10, 40]);
  });

  it('returns nothing for a pile shorter than a card can explain', () => {
    expect(titlePlates(profileWith([[5, 10]], 40), [], 40, cardHeight)).toEqual([]);
  });
});

describe('grouping stripes into piles', () => {
  /**
   * The stripes a real column produces: title bars a fan offset apart, the
   * bottom card's art and rules-text lines a few pixels apart, then a strip of
   * cloth, then the next pile. Everything inside one pile merges; the cloth gap
   * splits.
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
    { start: 534, end: 547 }, // next pile, a strip of cloth away
    { start: 572, end: 585 },
    { start: 599, end: 708 },
  ];

  it('merges a pile’s own stripes and splits piles at the cloth between them', () => {
    const piles = groupIntoPiles(REAL_COLUMN, 268);

    expect(piles).toEqual([
      { start: 58, end: 360 },
      { start: 534, end: 708 },
    ]);
  });

  it('drops card-wide clutter that is not card-tall — a deck box edge in shot', () => {
    const piles = groupIntoPiles(
      [
        { start: 0, end: 300 },
        { start: 500, end: 560 }, // far too short to be a card
      ],
      268,
    );

    expect(piles).toEqual([{ start: 0, end: 300 }]);
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
