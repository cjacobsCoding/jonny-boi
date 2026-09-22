/**
 * THE SECOND REAL PHOTO — the one the scanner CANNOT READ, pinned as a failing
 * measurement rather than as a passing claim.
 *
 * Caleb photographed a second physical deck on 2026-09-21 and asked for it in
 * the deck builder. `detectStacks` returns **zero piles** for that image, so the
 * transcription had to be done by a human eye (`docs/decks/boros-prison.txt`),
 * which is +/-1 copy per pile and therefore a decklist somewhere between 55 and
 * 70 cards. That is exactly the work the scanner exists to remove.
 *
 * ## What was ruled OUT, by measurement and not by argument
 *
 *  - **Orientation.** `stacks.ts` says in its own header that it "assumes the
 *    fan runs downward", so a rotated photo was the first theory. It is wrong:
 *    all four quarter turns detect zero.
 *  - **Scale.** Zero at 800, 1000, 1200, 1500 and 2000 px on the long edge.
 *  - **Brightness.** Mean luminance 58.8 against the working photo's 66.8 — not
 *    a meaningful gap, and the detector works off VARIANCE, not absolute level.
 *
 * What is left, and what a fixing lane should start from: the two photos differ
 * in LAYOUT, not in exposure. The photo that works is a dense 2x8 landscape
 * grid with piles shoulder to shoulder; this one is sparse and STAGGERED — the
 * piles sit at unrelated x-positions across seven loose rows, separated by wide
 * bands of bare table, and are sleeved in glossy top-loaders. `detectStacks`
 * begins by finding COLUMN bands in an x-variance profile, and on a staggered
 * layout there are no columns to find: nearly every x has some pile at some y.
 * It fails at the first step, before OCR is ever reached.
 *
 * ## Why this test asserts the FAILURE
 *
 * Because the alternative is silence. A scanner that reads one of a user's two
 * photos, with no test covering the other, looks finished. Pinning the failure
 * means the number is visible, the fixing lane has a target that is red before
 * it starts, and — the part that matters — **when someone fixes it, this test
 * fails and forces them to come here and write down what they achieved.**
 *
 * ⚠️ So a failure of THIS file is good news. Read the message, then move the
 * card to the success side and say what the new reading is.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { detectStacks } from './stacks.js';
import type { PixelImage } from './detect.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadPhoto(name: string): PixelImage {
  const raw = jpeg.decode(readFileSync(join(fixtures, name)), {
    useTArray: true,
    formatAsRGBA: true,
  });
  // `jpeg-js` hands back a Uint8Array; PixelImage wants a CLAMPED one, exactly
  // as `real-photo.test.ts` converts it. Caught by the build rather than by a
  // reviewer, because `apps/web` is the one workspace that type-checks its
  // tests — the `packages/*` tsconfigs all exclude theirs.
  return { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data) };
}

/** Rotate by quarter turns, to rule orientation in or out rather than assume it. */
function rotate(image: PixelImage, turns: number): PixelImage {
  const n = ((turns % 4) + 4) % 4;
  if (n === 0) return image;
  const swap = n % 2 === 1;
  const width = swap ? image.height : image.width;
  const height = swap ? image.width : image.height;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const from = (y * image.width + x) * 4;
      const tx = n === 1 ? image.height - 1 - y : n === 2 ? image.width - 1 - x : y;
      const ty = n === 1 ? x : n === 2 ? image.height - 1 - y : image.width - 1 - x;
      const to = (ty * width + tx) * 4;
      data[to] = image.data[from]!;
      data[to + 1] = image.data[from + 1]!;
      data[to + 2] = image.data[from + 2]!;
      data[to + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('the scanner on the SECOND real photo (DESIGN §3.182)', () => {
  it('the first photo still reads, so this file measures the photo and not a regression', () => {
    const result = detectStacks(loadPhoto('user-deck-photo.jpg'));
    // The control. If THIS ever fails, the scanner broke generally and the
    // failure below says nothing about staggered layouts.
    expect(result.stacks.length, 'the known-good photo must still read').toBeGreaterThan(0);
  });

  it('⚠️ KNOWN FAILURE: finds no piles at all, at any orientation', () => {
    const photo = loadPhoto('user-deck-photo-2.jpg');
    const found = [0, 1, 2, 3].map((turns) => detectStacks(rotate(photo, turns)).stacks.length);
    // Pinned as it stands TODAY. When a lane fixes staggered layouts this
    // assertion fails — that is the point. Replace it with the real reading and
    // update DESIGN §3.182 to say what the scanner now does.
    expect(
      found,
      'The scanner now reads the staggered photo. Good — put the real numbers here and update §3.182.',
    ).toEqual([0, 0, 0, 0]);
  });
});
