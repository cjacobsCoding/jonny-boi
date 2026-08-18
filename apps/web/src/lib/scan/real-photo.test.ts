/**
 * THE ACCEPTANCE GATE FOR THE SCANNER: a real photo, decoded end to end.
 *
 * The fixture is an actual phone photo of a real deck — sixteen sleeved piles
 * fanned on dark cloth, glare and tilt and washed-out edges included — with the
 * true decklist recorded below. The scanner was originally verified only on
 * synthetic images and failed badly on this photo, which is exactly the
 * verification failure this repo keeps getting burned by; this test exists so
 * the pipeline can never again be "green" without reading a real photo.
 *
 * Two tests, split by cost: detection (fast, exact) and OCR (slow — a real
 * Tesseract worker — and held to a floor rather than perfection, because two
 * of the sixteen bottom cards are genuinely marginal at this resolution; what
 * matters is that the review flow gets the right names preselected for the
 * rest and honest low-confidence flags for the misses).
 *
 * The OCR test needs Tesseract's English data (~5 MB): first run downloads it
 * into `fixtures/` (gitignored) and later runs use the cache.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { detectStacks } from './stacks.js';
import { scanCards } from './pipeline.js';
import { buildNameIndex } from './match.js';
import type { PixelImage } from './detect.js';
import type { MutablePixelImage } from './crop.js';
import type { OcrEngine } from './ocr.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

/**
 * The deck in the photo, in reading order (left to right, top row then
 * bottom row) — transcribed from the physical deck, 59 cards in 16 piles.
 */
const GROUND_TRUTH: ReadonlyArray<readonly [string, number]> = [
  ['Strionic Resonator', 4],
  ['Plains', 5],
  ['Gatecreeper Vine', 4],
  ['Banisher Priest', 4],
  ['Acidic Slime', 4],
  ['Temple Garden', 4],
  ['Fiend Hunter', 2],
  ['Sunpetal Grove', 4],
  ["Avacyn's Pilgrim", 4],
  ['Angel of Serenity', 3],
  ['Forest', 6],
  ['Restoration Angel', 3],
  ['Elvish Visionary', 4],
  ['Cloudshift', 2],
  ["Conjurer's Closet", 3],
  ['Thragtusk', 3],
];

/**
 * How many of the sixteen names OCR must resolve exactly. The current pipeline
 * resolves 15 (Gatecreeper Vine's bottom title is buried in glare at this
 * resolution and lands on a wrong, LOW-CONFIDENCE guess the review UI flags);
 * the floor sits at 14 so a legitimate refactor has one name of slack while a
 * real OCR regression still fails loudly.
 */
const MIN_RESOLVED_NAMES = 14;

function loadPhoto(): PixelImage {
  const raw = jpeg.decode(readFileSync(join(fixtures, 'user-deck-photo.jpg')), {
    useTArray: true,
    formatAsRGBA: true,
  });
  return { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data) };
}

function loadNameIndex() {
  const catalog = JSON.parse(
    readFileSync(join(fixtures, 'card-names-catalog.json'), 'utf8'),
  ) as { data: string[] };
  return buildNameIndex(catalog.data);
}

/** Tesseract running in Node: crops go in as losslessly-encoded JPEG buffers. */
async function createNodeOcrEngine(): Promise<OcrEngine> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng', undefined, { cachePath: fixtures });
  await worker.setParameters({
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ',-",
    tessedit_pageseg_mode: '6' as never,
  });
  return {
    async recognize(image: MutablePixelImage) {
      const rgba = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
      const encoded = jpeg.encode({ width: image.width, height: image.height, data: rgba }, 100);
      const { data } = await worker.recognize(encoded.data);
      return data.text.trim();
    },
    async terminate() {
      await worker.terminate();
    },
  };
}

describe('real deck photo', () => {
  it('detects every pile with its exact copy count', () => {
    const { stacks, rows, columns } = detectStacks(loadPhoto());

    expect(rows).toBe(2);
    expect(columns).toBe(8);
    expect(stacks).toHaveLength(GROUND_TRUTH.length);
    // Reading order, pile by pile — the counts must be RIGHT, not merely sum
    // right, because quantities are folded per name into the decklist.
    expect(stacks.map((stack) => stack.count)).toEqual(GROUND_TRUTH.map(([, qty]) => qty));
    expect(stacks.reduce((sum, stack) => sum + stack.count, 0)).toBe(59);
  }, 60_000);

  it('OCR resolves the names well enough to rescue the decklist', async () => {
    const image = loadPhoto();
    const { stacks } = detectStacks(image);
    const engine = await createNodeOcrEngine();
    try {
      const scanned = await scanCards(image, stacks, engine, loadNameIndex());

      const resolved = scanned.filter(
        (card, i) => card.chosenName === GROUND_TRUTH[i]![0],
      );
      expect(resolved.length).toBeGreaterThanOrEqual(MIN_RESOLVED_NAMES);

      // Every miss must be flagged for review, never silently accepted: a
      // wrong name the user is not pointed at is worse than no scan at all.
      for (const [i, card] of scanned.entries()) {
        if (card.chosenName !== GROUND_TRUTH[i]![0]) {
          expect(card.confident).toBe(false);
        }
      }

      // The quantities ride along with the resolved names.
      for (const [i, card] of scanned.entries()) {
        expect(card.qty).toBe(GROUND_TRUTH[i]![1]);
      }
    } finally {
      await engine.terminate();
    }
  }, 300_000);
});
