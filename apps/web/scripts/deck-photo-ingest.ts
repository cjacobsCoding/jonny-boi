/**
 * Ingest a deck photo ONCE, durably, and leave everything a later pass needs.
 *
 * The ad-hoc version of this — decode the JPEG, rotate it, crop some bands,
 * squint at them — got written three times in one evening and thrown away
 * three times, and each rewrite re-learned the same two things the hard way
 * (a phone writes EXIF-rotated JPEGs; `jpeg-js` ignores EXIF). So it lives
 * here instead, and every photo lands in the same shape:
 *
 *   <archive>/<slug>/
 *     photo.jpg        the ORIGINAL bytes, byte-for-byte — never re-encoded
 *     upright.jpg      the same photo with EXIF orientation actually applied
 *     manifest.json    source path, dimensions, EXIF orientation, tile grid
 *     tiles/r<c>.jpg   overlapping crops, sized so a card TITLE is readable
 *     decklist.txt     what the scanner made of it (when --scan is passed)
 *     scan.json        per-pile detail: chosen name, confidence, OCR text
 *
 * Why tiles at all, when the scanner exists: the scanner is the machine path
 * and it can be wrong or (today) fail outright on a 12 MP phone photo. The
 * tiles are the HUMAN path — small enough to read a title strip, overlapping
 * so a pile split by a tile edge is whole in its neighbour. Keeping both in
 * one folder is the point: the decklist is only trustworthy next to the
 * picture it came from.
 *
 *   npx tsx apps/web/scripts/deck-photo-ingest.ts --photo <file> [--slug name]
 *   npx tsx apps/web/scripts/deck-photo-ingest.ts --photo <file> --scan
 *
 * `--archive <dir>` overrides where it all lands (default below).
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import jpeg from 'jpeg-js';

/**
 * Where ingested photos live. OUTSIDE the repo on purpose: these are the
 * user's own photos, they are megabytes each, and a fixture that belongs in
 * git gets copied in deliberately rather than by accident.
 */
const DEFAULT_ARCHIVE = 'D:\\Cool Stuff\\Claude\\deck-photos';

/** A card title must survive the downscale, so tiles stay near this wide. */
const TILE_TARGET_WIDTH = 1500;
/** Tiles overlap so a pile cut by one tile's edge is whole in the next. */
const TILE_OVERLAP = 0.15;

interface Img {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Read EXIF orientation out of the JPEG's APP1/TIFF header.
 *
 * `jpeg-js` decodes pixels and drops EXIF entirely, and a phone almost always
 * stores the sensor's landscape frame plus a rotate flag. Every consumer that
 * forgets this analyses a sideways photo — which is exactly how a deck laid
 * out in portrait reached the pile detector rotated 90°.
 */
function exifOrientation(bytes: Buffer): number {
  if (bytes.readUInt16BE(0) !== 0xffd8) return 1; // not a JPEG
  let offset = 2;
  while (offset + 4 < bytes.length) {
    const marker = bytes.readUInt16BE(offset);
    const size = bytes.readUInt16BE(offset + 2);
    if (marker === 0xffe1 && bytes.toString('ascii', offset + 4, offset + 10) === 'Exif\0\0') {
      const tiff = offset + 10;
      const little = bytes.toString('ascii', tiff, tiff + 2) === 'II';
      const u16 = (at: number) => (little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
      const u32 = (at: number) => (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
      const ifd = tiff + u32(tiff + 4);
      const count = u16(ifd);
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (u16(entry) === 0x0112) return u16(entry + 8); // Orientation
      }
      return 1;
    }
    if ((marker & 0xff00) !== 0xff00) break;
    offset += 2 + size;
  }
  return 1;
}

/** Apply an EXIF orientation so downstream code can forget it ever existed. */
function upright(img: Img, orientation: number): Img {
  if (orientation === 1) return img;
  const { width: w, height: h, data } = img;
  const swaps = orientation >= 5; // 5..8 transpose the axes
  const nw = swaps ? h : w;
  const nh = swaps ? w : h;
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx = x;
      let ny = y;
      switch (orientation) {
        case 2: nx = w - 1 - x; break;
        case 3: nx = w - 1 - x; ny = h - 1 - y; break;
        case 4: ny = h - 1 - y; break;
        case 5: nx = y; ny = x; break;
        case 6: nx = h - 1 - y; ny = x; break;         // the phone default
        case 7: nx = h - 1 - y; ny = w - 1 - x; break;
        case 8: nx = y; ny = w - 1 - x; break;
        default: break;
      }
      const si = (y * w + x) * 4;
      const di = (ny * nw + nx) * 4;
      out[di] = data[si]!;
      out[di + 1] = data[si + 1]!;
      out[di + 2] = data[si + 2]!;
      out[di + 3] = 255;
    }
  }
  return { width: nw, height: nh, data: out };
}

/** Nearest-neighbour crop. Deliberately allocation-modest: one tile at a time. */
function crop(img: Img, x0: number, y0: number, w: number, h: number): Img {
  const cx = Math.max(0, Math.min(x0, img.width - 1));
  const cy = Math.max(0, Math.min(y0, img.height - 1));
  const cw = Math.min(w, img.width - cx);
  const ch = Math.min(h, img.height - cy);
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = ((cy + y) * img.width + (cx + x)) * 4;
      const di = (y * cw + x) * 4;
      out[di] = img.data[si]!;
      out[di + 1] = img.data[si + 1]!;
      out[di + 2] = img.data[si + 2]!;
      out[di + 3] = 255;
    }
  }
  return { width: cw, height: ch, data: out };
}

function writeJpeg(path: string, img: Img, quality = 92): void {
  const encoded = jpeg.encode(
    { width: img.width, height: img.height, data: Buffer.from(img.data) },
    quality,
  );
  writeFileSync(path, encoded.data);
}

function argOf(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const photoArg = argOf('--photo');
  if (!photoArg) {
    console.error(
      'usage: npx tsx apps/web/scripts/deck-photo-ingest.ts --photo <file> [--slug <name>] [--archive <dir>] [--scan]',
    );
    process.exitCode = 1;
    return;
  }
  const source = resolve(photoArg);
  const slug = argOf('--slug') ?? basename(source, extname(source));
  const archive = argOf('--archive') ?? DEFAULT_ARCHIVE;
  const dir = join(archive, slug);
  const tilesDir = join(dir, 'tiles');
  mkdirSync(tilesDir, { recursive: true });

  // The original bytes are copied, never re-encoded: this folder has to be
  // able to answer "what did the camera actually produce?" later.
  copyFileSync(source, join(dir, 'photo.jpg'));

  const bytes = readFileSync(source);
  const orientation = exifOrientation(bytes);
  const raw = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  const decoded: Img = {
    width: raw.width,
    height: raw.height,
    data: new Uint8ClampedArray(raw.data),
  };
  const straight = upright(decoded, orientation);
  writeJpeg(join(dir, 'upright.jpg'), straight, 90);

  // A tile grid sized so each tile lands near TILE_TARGET_WIDTH — that is the
  // width at which a card's title strip is still legible after the viewer
  // downsamples it.
  const columns = Math.max(1, Math.round(straight.width / TILE_TARGET_WIDTH));
  const rows = Math.max(1, Math.round(straight.height / TILE_TARGET_WIDTH));
  const tileW = Math.ceil(straight.width / columns);
  const tileH = Math.ceil(straight.height / rows);
  const padX = Math.round(tileW * TILE_OVERLAP);
  const padY = Math.round(tileH * TILE_OVERLAP);

  const tiles: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const tile = crop(
        straight,
        c * tileW - (c > 0 ? padX : 0),
        r * tileH - (r > 0 ? padY : 0),
        tileW + padX,
        tileH + padY,
      );
      const name = `r${r + 1}c${c + 1}.jpg`;
      writeJpeg(join(tilesDir, name), tile);
      tiles.push(`tiles/${name}`);
    }
  }

  const manifest = {
    slug,
    source,
    ingestedAt: new Date().toISOString(),
    exifOrientation: orientation,
    decoded: { width: decoded.width, height: decoded.height },
    upright: { width: straight.width, height: straight.height },
    tiles: { rows, columns, overlap: TILE_OVERLAP, files: tiles },
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`archived: ${dir}`);
  console.log(`  photo.jpg      ${decoded.width}x${decoded.height} (EXIF orientation ${orientation})`);
  console.log(`  upright.jpg    ${straight.width}x${straight.height}`);
  console.log(`  tiles/         ${rows}x${columns} = ${tiles.length} readable crops`);

  if (process.argv.includes('--scan')) {
    // Imported lazily: scanning pulls in Tesseract and the 35k-name catalog,
    // and archiving a photo must not pay for that when --scan is not asked.
    const { scanPhotoToArchive } = await import('./scan-photo.js');
    await scanPhotoToArchive(straight, dir);
  } else {
    console.log('\n(no --scan: run with --scan once the pile detector handles this photo)');
  }
}

await main();
