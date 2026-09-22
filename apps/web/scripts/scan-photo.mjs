/**
 * READ A DECK PHOTO FROM THE COMMAND LINE — the same pipeline the app runs.
 *
 *   node apps/web/scripts/scan-photo.mjs <photo.jpg> [--json]
 *
 * Why this exists: the scanner was reachable only from inside the app, two
 * dialogs deep, so there was no way to answer "what does the scanner actually
 * read from this photo?" without clicking through a phone. That made every
 * question about a real photo — his or a fixture's — unanswerable from a
 * terminal, and it made a transcription something a person eyeballed instead of
 * something the machine read. Eyeballing fanned piles is +/-1 copy per pile,
 * which over fourteen piles is a decklist anywhere between 55 and 70 cards.
 *
 * It runs the REAL modules — `detectStacks`, `scanCards`, `buildNameIndex` —
 * not a reimplementation, so what it prints is what the app would show. If this
 * disagrees with the app, one of them is broken and that is worth knowing.
 *
 * ⚠️ Node has no canvas, so no thumbnails are produced (`makeThumbnail` is
 * omitted exactly as `real-photo.test.ts` omits it). Names and counts are
 * unaffected — those come from luminance and OCR, neither of which needs a DOM.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import jpeg from 'jpeg-js';
import { detectStacks } from '../src/lib/scan/stacks.ts';
import { scanCards } from '../src/lib/scan/pipeline.ts';
import { buildNameIndex } from '../src/lib/scan/match.ts';
import { createOcrEngine } from '../src/lib/scan/ocr.ts';
import { MAX_IMAGE_EDGE } from '../src/lib/scan/config.ts';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const path = args.find((a) => !a.startsWith('--'));
if (!path) {
  console.error('usage: node apps/web/scripts/scan-photo.mjs <photo.jpg> [--json]');
  process.exit(2);
}

/**
 * Decode and downscale exactly as the app does. The app resizes to
 * MAX_IMAGE_EDGE before detection, so scanning the full-resolution original
 * here would tune the detector against an input the app never sees.
 */
function loadPhoto(file) {
  const raw = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true });
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(raw.width, raw.height));
  if (scale === 1) return { width: raw.width, height: raw.height, data: raw.data };

  const width = Math.max(1, Math.round(raw.width * scale));
  const height = Math.max(1, Math.round(raw.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(raw.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(raw.width - 1, Math.floor(x / scale));
      const from = (sy * raw.width + sx) * 4;
      const to = (y * width + x) * 4;
      data[to] = raw.data[from];
      data[to + 1] = raw.data[from + 1];
      data[to + 2] = raw.data[from + 2];
      data[to + 3] = 255;
    }
  }
  return { width, height, data };
}

function readCatalogNames() {
  const url = new URL('../src/lib/scan/fixtures/card-names-catalog.json', import.meta.url);
  const parsed = JSON.parse(readFileSync(url, 'utf8'));
  return Array.isArray(parsed) ? parsed : parsed.data;
}

/**
 * Rotate by a quarter turn. `stacks.ts` says in its own header that it
 * "assumes the fan runs downward", which is one of the four ways a phone can be
 * held over a table — so a photo taken the other way round detects NOTHING and
 * says nothing about why.
 */
function rotateQuarterTurns(image, turns) {
  const n = ((turns % 4) + 4) % 4;
  if (n === 0) return image;
  const swap = n % 2 === 1;
  const width = swap ? image.height : image.width;
  const height = swap ? image.width : image.height;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const from = (y * image.width + x) * 4;
      let tx, ty;
      if (n === 1) { tx = image.height - 1 - y; ty = x; }
      else if (n === 2) { tx = image.width - 1 - x; ty = image.height - 1 - y; }
      else { tx = y; ty = image.width - 1 - x; }
      const to = (ty * width + tx) * 4;
      data[to] = image.data[from];
      data[to + 1] = image.data[from + 1];
      data[to + 2] = image.data[from + 2];
      data[to + 3] = 255;
    }
  }
  return { width, height, data };
}

const original = loadPhoto(path);

/**
 * Try every quarter turn and keep the one that reads best. "Best" is the most
 * piles, then the most rows — a wrong orientation does not merely score lower,
 * it usually detects nothing at all, so this is a cheap and decisive test.
 * Reported out loud, because a silent auto-rotate would hide the fact that the
 * detector only understands one orientation.
 */
let image = original;
let best = detectStacks(original);
let usedTurns = 0;
for (const turns of [1, 2, 3]) {
  if (best.stacks.length > 0 && turns > 1 && best.rows > 1) break;
  const candidate = rotateQuarterTurns(original, turns);
  const result = detectStacks(candidate);
  const better =
    result.stacks.length > best.stacks.length ||
    (result.stacks.length === best.stacks.length && result.rows > best.rows);
  if (better) { image = candidate; best = result; usedTurns = turns; }
}
const { stacks, rows, columns } = best;
if (stacks.length === 0) {
  console.error(`no piles detected in ${basename(path)} at ANY of the four orientations (${original.width}x${original.height})`);
  process.exit(1);
}
if (usedTurns !== 0 && !asJson) {
  console.error(`note: read at ${usedTurns * 90} degrees — the photo needed rotating before any pile was found`);
}

const engine = await createOcrEngine();
let scanned;
try {
  scanned = await scanCards(image, stacks, engine, buildNameIndex(readCatalogNames()), {
    onProgress: ({ done, total }) => {
      if (!asJson) process.stderr.write(`\rreading pile ${done}/${total}`);
    },
  });
} finally {
  await engine.terminate?.();
}
if (!asJson) process.stderr.write('\n');

const total = scanned.reduce((n, c) => n + c.qty, 0);
const unsure = scanned.filter((c) => !c.confident || c.chosenName === null);

if (asJson) {
  console.log(JSON.stringify({ source: basename(path), rows, columns, total, cards: scanned.map((c) => ({ name: c.chosenName, qty: c.qty, confident: c.confident, ocrText: c.ocrText })) }, null, 2));
} else {
  console.log(`# ${basename(path)} — ${stacks.length} piles in ${rows} row(s) x ${columns} column(s), ${total} cards\n`);
  for (const card of scanned) {
    // A name the pipeline is not sure of is printed WITH its raw OCR text and a
    // marker, never silently promoted to the nearest catalogue entry — a wrong
    // name that looks confident is worse than an obvious gap.
    const flag = card.confident && card.chosenName ? '' : `   <-- UNSURE, ocr read "${card.ocrText.trim()}"`;
    console.log(`${card.qty} ${card.chosenName ?? '???'}${flag}`);
  }
  console.log(`\n# ${total} cards. ${unsure.length} pile(s) need a human.`);
}
