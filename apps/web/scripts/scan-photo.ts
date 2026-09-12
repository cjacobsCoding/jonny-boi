/**
 * Scan a deck photo into a decklist, headlessly.
 *
 * The PWA already does this in the browser (DESIGN §3.12): lay the deck out in
 * fanned piles, photograph it, get a decklist. This is the same pipeline driven
 * from a terminal — same `detectStacks`, same `scanCards`, same name index — so
 * a photo can be turned into a decklist without opening the app, and so a photo
 * that scans badly can be diagnosed by whoever is fixing the scanner.
 *
 * It is deliberately a THIN driver over the shipped pipeline rather than a
 * second implementation: if this and the app ever disagree, that is a bug in
 * one of them, and there is nothing here for them to disagree about.
 *
 *   npx tsx apps/web/scripts/scan-photo.ts --photo "D:\path\to\deck.jpg"
 *   npx tsx apps/web/scripts/scan-photo.ts --photo deck.jpg --out deck.txt
 *
 * `--json` prints the full per-pile detail (confidence, the runner-up names,
 * the raw OCR text) which is what you want when a name comes back wrong.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { detectStacks } from '../src/lib/scan/stacks.js';
import { scanCards, toDecklistText, toQuantities, totalCopies, unrecognizedCount } from '../src/lib/scan/pipeline.js';
import { buildNameIndex } from '../src/lib/scan/match.js';
import type { PixelImage } from '../src/lib/scan/detect.js';
import type { MutablePixelImage } from '../src/lib/scan/crop.js';
import type { OcrEngine } from '../src/lib/scan/ocr.js';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * The scanner's own fixtures carry BOTH things this needs: the 35k-name
 * Scryfall catalog the matcher scores against, and the cached Tesseract
 * traineddata. Reading them from there rather than re-fetching keeps this
 * script offline — and keeps it honest, since it is then matching against
 * exactly the catalog the fixture test pins the pipeline against.
 */
const fixtures = join(here, '..', 'src', 'lib', 'scan', 'fixtures');

/** JPEG only — the app accepts what a phone camera produces, and so does this. */
function loadPhoto(path: string): PixelImage {
  const raw = jpeg.decode(readFileSync(path), { useTArray: true, formatAsRGBA: true });
  return { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data) };
}

function loadNameIndex() {
  const catalog = JSON.parse(readFileSync(join(fixtures, 'card-names-catalog.json'), 'utf8')) as {
    data: string[];
  };
  return buildNameIndex(catalog.data);
}

/** Tesseract in Node: crops go in as losslessly-encoded JPEG buffers. */
async function createNodeOcrEngine(): Promise<OcrEngine> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng', undefined, { cachePath: fixtures });
  await worker.setParameters({
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ',-",
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

function argOf(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

/**
 * Scan an already-upright image and write the results beside it.
 *
 * Exported so `deck-photo-ingest.ts` runs the SAME scan the CLI does — a
 * second copy of "decode, detect, OCR, write a decklist" is exactly the kind
 * of duplicate answer that ends up disagreeing with the app.
 */
export async function scanPhotoToArchive(
  image: { width: number; height: number; data: Uint8ClampedArray },
  dir: string,
): Promise<void> {
  const { stacks } = detectStacks(image);
  const engine = await createNodeOcrEngine();
  try {
    const scanned = await scanCards(image, stacks, engine, loadNameIndex());
    const unsure = scanned.filter((card) => !card.confident);
    writeFileSync(join(dir, 'scan.json'), `${JSON.stringify(scanned, null, 2)}
`, 'utf8');
    writeFileSync(join(dir, 'decklist.txt'), `${toDecklistText(scanned)}
`, 'utf8');
    console.log(
      `  decklist.txt   ${toQuantities(scanned).length} names, ${totalCopies(scanned)} cards, ` +
        `${unrecognizedCount(scanned)} unnamed, ${unsure.length} to CHECK`,
    );
  } finally {
    await engine.terminate();
  }
}

async function main(): Promise<void> {
  const photo = argOf('--photo');
  if (!photo) {
    console.error('usage: npx tsx apps/web/scripts/scan-photo.ts --photo <deck.jpg> [--out list.txt] [--json]');
    process.exitCode = 1;
    return;
  }

  const image = loadPhoto(resolve(photo));
  const { stacks, rows, columns } = detectStacks(image);
  console.error(`layout: ${rows}x${columns}, ${stacks.length} piles, ${stacks.reduce((n, s) => n + s.count, 0)} cards`);

  const engine = await createNodeOcrEngine();
  try {
    const scanned = await scanCards(image, stacks, engine, loadNameIndex());
    /*
     * TWO different questions, and reporting only the first is how a wrong name
     * gets imported silently. `unrecognizedCount` counts piles with NO name —
     * but the miss that actually happens is a pile whose top match is WRONG and
     * merely weak (the fixture photo's glare-buried Gatecreeper Vine comes back
     * as "Vineweft"), which has a chosenName and so counts as recognised. The
     * review signal the app's grid uses is `confident`; this mirrors it.
     */
    const unresolved = unrecognizedCount(scanned);
    const unsure = scanned.filter((card) => !card.confident);

    if (argOf('--json') !== undefined || process.argv.includes('--json')) {
      console.log(JSON.stringify(scanned, null, 2));
    }

    const list = toDecklistText(scanned);
    const out = argOf('--out');
    if (out) writeFileSync(resolve(out), `${list}\n`, 'utf8');
    console.log(list);

    // To stderr so `--out`-less runs can be piped straight into the app.
    console.error(
      `\n${toQuantities(scanned).length} distinct names, ${totalCopies(scanned)} cards, ` +
        `${unresolved} pile(s) with no name, ${unsure.length} pile(s) to CHECK.`,
    );
    for (const card of unsure) {
      const runners = card.matches
        .slice(0, 3)
        .map((match) => `${match.name} (${match.score.toFixed(2)})`)
        .join(' | ');
      console.error(
        `  ⚠️  pile ${card.index + 1} ×${card.qty}: chose "${card.chosenName ?? '—'}" ` +
          `from OCR "${card.ocrText.replace(/\s+/g, ' ').trim()}"\n      candidates: ${runners || '(none)'}`,
      );
    }
  } finally {
    await engine.terminate();
  }
}

// Only run the CLI when invoked directly — `deck-photo-ingest.ts` imports this
// module for `scanPhotoToArchive` and must not trigger a second scan.
if (process.argv[1] && process.argv[1].endsWith('scan-photo.ts')) {
  await main();
}
