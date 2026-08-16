/**
 * Pipeline tests with a FAKE OCR engine — the whole photo → decklist flow,
 * including the messy parts (a card the engine cannot read, a card whose text
 * matches nothing, duplicates folding into quantities), without a browser.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildNameIndex } from './match.js';
import {
  chooseName,
  chooseQuantity,
  scanCards,
  toDecklistText,
  toQuantities,
  totalCopies,
  unrecognizedCount,
} from './pipeline.js';
import type { OcrEngine } from './ocr.js';
import type { PixelImage, Rect } from './detect.js';
import type { CardStack } from './stacks.js';

const NAMES = ['Lightning Bolt', 'Serra Angel', 'Mountain', 'Llanowar Elves'];
const index = buildNameIndex(NAMES);

/** A blank image big enough for the crops to be non-degenerate. */
function image(): PixelImage {
  const width = 400;
  const height = 400;
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function band(x: number, y: number): Rect {
  return { x, y, width: 40, height: 12 };
}

/** Piles of one — the shape of a photo of loose cards laid out in a grid. */
function cells(count: number): CardStack[] {
  return Array.from({ length: count }, (_, i) => ({
    bounds: { x: i * 10, y: 0, width: 63, height: 88 },
    count: 1,
    titleBands: [band(i * 10, 0)],
  }));
}

/** One pile of `qty` copies, fanned — one title band per copy. */
function pile(qty: number, x = 0): CardStack {
  return {
    bounds: { x, y: 0, width: 63, height: (qty - 1) * 12 + 88 },
    count: qty,
    titleBands: Array.from({ length: qty }, (_, i) => band(x, i * 12)),
  };
}

/** An OCR engine that returns scripted text, one entry per call. */
function fakeEngine(texts: readonly string[]): OcrEngine {
  let call = 0;
  return {
    recognize: vi.fn(async () => {
      const text = texts[call] ?? '';
      call += 1;
      if (text === '__throw__') throw new Error('engine blew up on this crop');
      return text;
    }),
    terminate: vi.fn(async () => {}),
  };
}

describe('scanCards', () => {
  it('reads each card and preselects its best match', async () => {
    const scanned = await scanCards(
      image(),
      cells(2),
      fakeEngine(['Lightning Bolt', 'Serra Angel']),
      index,
    );

    expect(scanned.map((card) => card.chosenName)).toEqual(['Lightning Bolt', 'Serra Angel']);
    expect(scanned.every((card) => card.confident)).toBe(true);
  });

  it('corrects OCR noise into the right card', async () => {
    const scanned = await scanCards(image(), cells(1), fakeEngine(['Llghtnlng Bolt']), index);

    expect(scanned[0]!.chosenName).toBe('Lightning Bolt');
    // The raw text is kept so the user can see what the engine actually read.
    expect(scanned[0]!.ocrText).toBe('Llghtnlng Bolt');
  });

  it('flags a weak match for review instead of accepting it quietly', async () => {
    const scanned = await scanCards(image(), cells(1), fakeEngine(['Ligtnin Bol']), index);

    expect(scanned[0]!.chosenName).toBe('Lightning Bolt');
    expect(scanned[0]!.confident).toBe(false);
  });

  it('leaves an unreadable card unmatched rather than guessing', async () => {
    const scanned = await scanCards(image(), cells(1), fakeEngine(['qqqq zzzz wwww']), index);

    expect(scanned[0]!.chosenName).toBeNull();
    expect(scanned[0]!.matches).toEqual([]);
    expect(unrecognizedCount(scanned)).toBe(1);
  });

  it('survives the engine throwing on one card and finishes the rest', async () => {
    const scanned = await scanCards(
      image(),
      cells(3),
      fakeEngine(['Mountain', '__throw__', 'Mountain']),
      index,
    );

    expect(scanned).toHaveLength(3);
    expect(scanned[1]!.chosenName).toBeNull();
    expect(scanned[0]!.chosenName).toBe('Mountain');
    expect(scanned[2]!.chosenName).toBe('Mountain');
  });

  it('reports progress once per card', async () => {
    const seen: number[] = [];
    await scanCards(image(), cells(3), fakeEngine(['Mountain', 'Mountain', 'Mountain']), index, {
      onProgress: (progress) => seen.push(progress.done),
    });

    expect(seen).toEqual([1, 2, 3]);
  });

  it('builds thumbnails when a renderer is supplied', async () => {
    const scanned = await scanCards(image(), cells(1), fakeEngine(['Mountain']), index, {
      makeThumbnail: () => 'data:image/jpeg;base64,FAKE',
    });

    expect(scanned[0]!.thumbnailUrl).toBe('data:image/jpeg;base64,FAKE');
  });

  it('carries a pile’s copy count through as its quantity', async () => {
    const scanned = await scanCards(image(), [pile(4)], fakeEngine(['Mountain']), index);

    expect(scanned[0]!.qty).toBe(4);
    expect(toDecklistText(scanned)).toBe('4 Mountain');
  });

  /**
   * Every copy in a pile is the SAME card, so a weak read of the bottom one gets
   * a second opinion from the copies above it — free accuracy on exactly the
   * piles that need it.
   */
  it('re-reads a pile’s other copies when the first read is weak', async () => {
    const engine = fakeEngine(['Ligtnin Bol', 'Lightning Bolt']);

    const scanned = await scanCards(image(), [pile(3)], engine, index);

    expect(scanned[0]!.chosenName).toBe('Lightning Bolt');
    expect(scanned[0]!.confident).toBe(true);
    expect(engine.recognize).toHaveBeenCalledTimes(2);
  });

  it('does not pay for extra reads when the first one is already confident', async () => {
    const engine = fakeEngine(['Lightning Bolt', 'Serra Angel']);

    const scanned = await scanCards(image(), [pile(4)], engine, index);

    expect(scanned[0]!.chosenName).toBe('Lightning Bolt');
    expect(engine.recognize).toHaveBeenCalledTimes(1);
  });

  it('keeps the best read it got even when no re-read is convincing', async () => {
    const scanned = await scanCards(
      image(),
      [pile(3)],
      fakeEngine(['Ligtnin Bol', 'qqqq zzzz', 'wwww vvvv']),
      index,
    );

    expect(scanned[0]!.chosenName).toBe('Lightning Bolt');
    expect(scanned[0]!.confident).toBe(false);
  });
});

describe('folding a scan into a decklist', () => {
  it('counts physical copies into quantities, most-played first', async () => {
    const scanned = await scanCards(
      image(),
      cells(4),
      fakeEngine(['Mountain', 'Lightning Bolt', 'Mountain', 'Mountain']),
      index,
    );

    expect(toQuantities(scanned)).toEqual([
      { name: 'Mountain', qty: 3 },
      { name: 'Lightning Bolt', qty: 1 },
    ]);
    expect(toDecklistText(scanned)).toBe('3 Mountain\n1 Lightning Bolt');
  });

  it('omits unrecognized cards from the list but keeps them countable', async () => {
    const scanned = await scanCards(
      image(),
      cells(2),
      fakeEngine(['Mountain', 'qqqq zzzz wwww']),
      index,
    );

    expect(toQuantities(scanned)).toEqual([{ name: 'Mountain', qty: 1 }]);
    expect(unrecognizedCount(scanned)).toBe(1);
  });

  it('lets the user correct a card, which changes the resulting list', async () => {
    const scanned = await scanCards(
      image(),
      cells(2),
      fakeEngine(['Mountain', 'Mountain']),
      index,
    );

    const corrected = chooseName(scanned, 1, 'Serra Angel');

    expect(toQuantities(corrected)).toEqual([
      { name: 'Mountain', qty: 1 },
      { name: 'Serra Angel', qty: 1 },
    ]);
  });

  it('lets the user reject a wrong guess entirely', async () => {
    const scanned = await scanCards(image(), cells(1), fakeEngine(['Mountain']), index);

    const cleared = chooseName(scanned, 0, null);

    expect(toQuantities(cleared)).toEqual([]);
    expect(unrecognizedCount(cleared)).toBe(1);
  });

  it('sums the same card found in more than one pile', async () => {
    const scanned = await scanCards(
      image(),
      [pile(4, 0), pile(3, 100)],
      fakeEngine(['Mountain', 'Mountain']),
      index,
    );

    expect(toQuantities(scanned)).toEqual([{ name: 'Mountain', qty: 7 }]);
  });

  it('lets the user fix a miscounted pile, and never below one copy', async () => {
    const scanned = await scanCards(image(), [pile(4)], fakeEngine(['Mountain']), index);

    expect(toDecklistText(chooseQuantity(scanned, 0, 3))).toBe('3 Mountain');
    expect(toDecklistText(chooseQuantity(scanned, 0, 0))).toBe('1 Mountain');
  });

  it('counts copies, not piles, for the total the user checks against sixty', async () => {
    const scanned = await scanCards(
      image(),
      [pile(4, 0), pile(2, 100)],
      fakeEngine(['Mountain', 'Serra Angel']),
      index,
    );

    expect(totalCopies(scanned)).toBe(6);
    expect(totalCopies(chooseName(scanned, 1, null))).toBe(4);
  });
});
