/**
 * Tests for the scanning core — detection, cropping and OCR correction — all of
 * which are pure pixel/string work and therefore fully testable in Node with
 * synthetic images. The browser-only parts (canvas decoding, Tesseract) are thin
 * wrappers around these.
 */

import { describe, expect, it } from 'vitest';
import {
  detectCards,
  findBands,
  gridCells,
  lineVariance,
  looksLikeCard,
  toLuminance,
  type PixelImage,
} from './detect.js';
import { cropRegion, prepareForOcr, titleBandOf } from './crop.js';
import {
  buildNameIndex,
  editDistance,
  matchCardName,
  normalizeForMatch,
  similarity,
} from './match.js';
import { CARD_ASPECT_RATIO } from './config.js';

/** A blank canvas of one flat colour — stands in for the table surface. */
function blankImage(width: number, height: number, value = 200): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

/**
 * Paint a "card" into an image: a high-variance checker pattern, which is what
 * a real card's art and text look like to a variance-based detector.
 */
function paintCard(image: PixelImage, x: number, y: number, width: number, height: number): void {
  const data = image.data as Uint8ClampedArray;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const px = x + column;
      const py = y + row;
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
      const value = (column + row) % 2 === 0 ? 20 : 235;
      const offset = (py * image.width + px) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
}

/** Card dimensions with a real card's aspect ratio, for synthetic layouts. */
const CARD_HEIGHT = 88;
const CARD_WIDTH = Math.round(CARD_HEIGHT * CARD_ASPECT_RATIO);

describe('detectCards', () => {
  it('finds a single card on a flat surface', () => {
    const image = blankImage(300, 300);
    paintCard(image, 60, 60, CARD_WIDTH, CARD_HEIGHT);

    const { cells } = detectCards(image);

    expect(cells).toHaveLength(1);
    // Bands are inclusive pixel runs, so allow a pixel of slack at each edge.
    expect(cells[0]!.x).toBeGreaterThanOrEqual(58);
    expect(cells[0]!.x).toBeLessThanOrEqual(62);
    expect(cells[0]!.width).toBeGreaterThanOrEqual(CARD_WIDTH - 3);
    expect(cells[0]!.width).toBeLessThanOrEqual(CARD_WIDTH + 3);
  });

  it('finds a 3 × 2 grid of cards in reading order', () => {
    const gap = 24;
    const image = blankImage(3 * CARD_WIDTH + 4 * gap, 2 * CARD_HEIGHT + 3 * gap);
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        paintCard(
          image,
          gap + column * (CARD_WIDTH + gap),
          gap + row * (CARD_HEIGHT + gap),
          CARD_WIDTH,
          CARD_HEIGHT,
        );
      }
    }

    const { cells, rows, columns } = detectCards(image);

    expect(rows).toBe(2);
    expect(columns).toBe(3);
    expect(cells).toHaveLength(6);
    // Reading order: the first three share a row, then the next three.
    expect(cells[0]!.y).toBe(cells[1]!.y);
    expect(cells[3]!.y).toBeGreaterThan(cells[0]!.y);
    expect(cells[1]!.x).toBeGreaterThan(cells[0]!.x);
  });

  it('returns nothing for a photo of an empty table', () => {
    expect(detectCards(blankImage(400, 400)).cells).toHaveLength(0);
  });

  it('rejects a region whose shape is not a card', () => {
    const image = blankImage(400, 200);
    paintCard(image, 20, 20, 340, 60); // a long strip — a table edge, not a card

    expect(detectCards(image).cells).toHaveLength(0);
  });

  it('handles a zero-sized image without throwing', () => {
    expect(detectCards({ width: 0, height: 0, data: new Uint8ClampedArray(0) }).cells).toEqual([]);
  });
});

describe('detection internals', () => {
  it('computes luminance from RGB', () => {
    const white = blankImage(2, 1, 255);
    expect(toLuminance(white)[0]).toBeCloseTo(255, 0);
  });

  it('scores busy columns above flat ones', () => {
    const image = blankImage(60, 60);
    paintCard(image, 20, 10, 20, 40);
    const profile = lineVariance(toLuminance(image), 60, 60, 'x');

    expect(profile[30]).toBeGreaterThan(0.5); // inside the card
    expect(profile[5]).toBeLessThan(0.1); // flat surface
  });

  it('bridges a narrow gap inside one band but splits on a wide one', () => {
    const profile = new Float32Array(200);
    profile.fill(1, 0, 90);
    profile.fill(0, 90, 91); // one-pixel dip — a frame line, not a card edge
    profile.fill(1, 91, 100);
    profile.fill(0, 100, 140); // a real gap
    profile.fill(1, 140, 200);

    const bands = findBands(profile, 200);

    expect(bands).toHaveLength(2);
    expect(bands[0]).toEqual({ start: 0, end: 99 });
  });

  it('accepts card-shaped rectangles and rejects extreme ones', () => {
    expect(looksLikeCard({ x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT })).toBe(true);
    expect(looksLikeCard({ x: 0, y: 0, width: 300, height: 20 })).toBe(false);
    expect(looksLikeCard({ x: 0, y: 0, width: 0, height: 0 })).toBe(false);
  });
});

describe('gridCells (the manual fallback)', () => {
  it('produces rows × columns cells in reading order', () => {
    const cells = gridCells(600, 400, 2, 3);

    expect(cells).toHaveLength(6);
    expect(cells[0]!.y).toBe(cells[2]!.y);
    expect(cells[3]!.y).toBeGreaterThan(cells[0]!.y);
  });

  it('returns nothing for a degenerate grid', () => {
    expect(gridCells(600, 400, 0, 3)).toEqual([]);
    expect(gridCells(0, 0, 2, 2)).toEqual([]);
  });
});

describe('title band + crop', () => {
  const card = { x: 100, y: 200, width: CARD_WIDTH, height: CARD_HEIGHT };

  it('sits in the top portion of the card and trims the mana cost', () => {
    const band = titleBandOf(card);

    expect(band.y).toBeGreaterThan(card.y);
    expect(band.y + band.height).toBeLessThan(card.y + card.height * 0.25);
    // The right end (where the mana cost prints) is excluded.
    expect(band.x + band.width).toBeLessThan(card.x + card.width * 0.8);
  });

  it('crops the requested pixels', () => {
    const image = blankImage(50, 50, 10);
    paintCard(image, 10, 10, 10, 10);
    const crop = cropRegion(image, { x: 10, y: 10, width: 10, height: 10 });

    expect(crop.width).toBe(10);
    expect(crop.height).toBe(10);
    expect(crop.data[0]).toBe(20); // first checker pixel
  });

  it('clamps a crop that runs past the edge instead of throwing', () => {
    const image = blankImage(20, 20);
    const crop = cropRegion(image, { x: 15, y: 15, width: 50, height: 50 });

    expect(crop.width).toBe(5);
    expect(crop.height).toBe(5);
  });

  it('upscales and stretches contrast for OCR', () => {
    const image = blankImage(4, 4, 100);
    (image.data as Uint8ClampedArray)[0] = 120;
    (image.data as Uint8ClampedArray)[1] = 120;
    (image.data as Uint8ClampedArray)[2] = 120;

    const prepared = prepareForOcr(image, 2);

    expect(prepared.width).toBe(8);
    expect(prepared.height).toBe(8);
    // Contrast stretched to the full range: the extremes become 0 and 255.
    const values = Array.from({ length: prepared.width * prepared.height }, (_, i) =>
      prepared.data[i * 4],
    );
    expect(Math.min(...(values as number[]))).toBe(0);
    expect(Math.max(...(values as number[]))).toBe(255);
  });

  it('leaves a flat crop alone rather than amplifying noise', () => {
    const prepared = prepareForOcr(blankImage(3, 3, 128), 1);
    expect(prepared.data[0]).toBe(128);
  });
});

describe('OCR correction against the card-name vocabulary', () => {
  const NAMES = [
    'Lightning Bolt',
    'Lightning Helix',
    'Serra Angel',
    "Jace's Ingenuity",
    'Birds of Paradise',
    'Llanowar Elves',
    'Monastery Swiftspear',
  ];
  const index = buildNameIndex(NAMES);

  it('normalizes case, punctuation and accents away', () => {
    expect(normalizeForMatch("Jace's  Ingenuity!")).toBe('jaces ingenuity');
    expect(normalizeForMatch('Lótus')).toBe('lotus');
  });

  it('measures edit distance and bails out past the budget', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('abc', 'xyz', 1)).toBeGreaterThan(1);
    expect(similarity('bolt', 'bolt')).toBe(1);
  });

  it('recovers the right card from classic OCR letter confusion', () => {
    // l/1 and rn/m are the mistakes an OCR engine actually makes on card titles.
    expect(matchCardName('Llghtnlng Bolt', index)[0]?.name).toBe('Lightning Bolt');
    expect(matchCardName('Serra Ange1', index)[0]?.name).toBe('Serra Angel');
    expect(matchCardName('Llanowar Efves', index)[0]?.name).toBe('Llanowar Elves');
  });

  it('recovers a name whose apostrophe OCR dropped', () => {
    expect(matchCardName('Jaces Ingenuity', index)[0]?.name).toBe("Jace's Ingenuity");
  });

  it('handles a name whose tail was clipped off', () => {
    expect(matchCardName('Monastery Swift', index)[0]?.name).toBe('Monastery Swiftspear');
  });

  it('distinguishes two names that share a prefix', () => {
    expect(matchCardName('Lightning Helix', index)[0]?.name).toBe('Lightning Helix');
    expect(matchCardName('Lightning Bolt', index)[0]?.name).toBe('Lightning Bolt');
  });

  it('offers ranked alternatives so the user can correct a wrong guess', () => {
    const matches = matchCardName('Lightning Bol', index, 3);
    expect(matches.length).toBeGreaterThan(1);
    expect(matches[0]!.score).toBeGreaterThanOrEqual(matches[1]!.score);
  });

  it('returns nothing for unreadable junk rather than a confident wrong answer', () => {
    expect(matchCardName('zzzz qqqq xxxx', index)).toHaveLength(0);
    expect(matchCardName('', index)).toHaveLength(0);
  });
});
