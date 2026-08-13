/**
 * jonny-boi app-icon pipeline.
 *
 * The mark is AI-generated key art (`public/icons/source-art.png`) — a horned
 * beast skull with gold horns, molten eyes, and an ember flourish — produced with
 * Pollinations/FLUX via the same recipe as Treadlight's `tools/gen_icon.py`. The
 * prompt is recorded in `SOURCE_PROMPT` below so the art is reproducible, and it
 * describes generic dark fantasy only: no Wizards/Scryfall artwork was used as
 * input or reference, and no trademarked symbol appears in the result.
 *
 * This script does NOT generate the art. It takes that one square source image
 * and derives every icon the PWA ships, each framed for where it is actually
 * displayed. To change the icon, drop a new square PNG at `SOURCE_ART` and re-run
 * — the whole set follows. All framing constants are named (DESIGN.md §1).
 *
 * Run:  npm run icons -w @jonny-boi/web
 *
 * Needs `sharp` (raster compositing). It is deliberately NOT a repo dependency:
 * the outputs are committed and only need regenerating when the art changes, so
 * install it on demand with `npm i -D sharp`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const SOURCE_ART = join(ICONS_DIR, 'source-art.png');

/** Recorded so the key art can be regenerated or re-rolled with a new seed. */
const SOURCE_PROMPT =
  'game app icon, horned demon beast skull crowned with antique gold filigree, ' +
  'blazing molten eyes, dark fantasy emblem, centered, bold thick shapes, ' +
  'high contrast, deep dark background, clean vector-like, no text ' +
  '[Pollinations flux, 768x768, seed 22]';

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/** Working resolution; every output is derived from a render at this size. */
const CANVAS = 512;

/** Corner rounding for the standalone icon — matches a platform squircle. */
const CORNER_RADIUS = 112;

/**
 * Maskable icons may be cropped to a circle 80% of the artboard wide, so the
 * emblem is scaled to sit inside that safe zone. The remaining margin is filled
 * with a blurred, darkened copy of the same art, which extends the background
 * seamlessly instead of butting the emblem against a flat plate.
 */
const MASKABLE_ART_SCALE = 0.8;
const MASKABLE_BACKDROP_BLUR = 34;
const MASKABLE_BACKDROP_DARKEN = 0.55;

/**
 * At favicon sizes the full emblem collapses into a smudge, so small outputs
 * punch in on the centre — a bigger subject with less dead margin survives 16px.
 */
const SMALL_CROP = 0.66;
/** Outputs at or below this size use the punched-in crop. */
const SMALL_SIZE_THRESHOLD = 64;

/** Gradient-heavy dark art compresses badly as truecolor PNG; quantize it. */
const PNG_PALETTE_COLORS = 220;

// ---------------------------------------------------------------------------

const roundedMask = (size, radius) =>
  Buffer.from(
    `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="#fff"/></svg>`,
  );

/**
 * Outputs.
 *
 *  - `rounded`  apply the squircle mask (transparent corners). Off for iOS and
 *               for maskable, where the platform supplies its own mask and a
 *               pre-rounded image would be double-rounded or cropped.
 *  - `maskable` full-bleed backdrop with the emblem inside the safe zone.
 */
const OUTPUTS = [
  { file: 'icon-512.png', size: 512, rounded: true },
  { file: 'icon-192.png', size: 192, rounded: true },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'favicon-32.png', size: 32 },
  { file: 'favicon-16.png', size: 16 },
];

async function main() {
  await mkdir(ICONS_DIR, { recursive: true });

  let sharp;
  try {
    ({ default: sharp } = await import('sharp'));
  } catch {
    console.error(
      'sharp is required to build the icons from the source art.\n' +
        'Install it on demand:  npm i -D sharp',
    );
    process.exitCode = 1;
    return;
  }

  const source = sharp(SOURCE_ART);
  const { width, height } = await source.metadata();
  const square = Math.min(width, height);

  /** Centre-crop to a square so nothing is distorted, optionally punching in. */
  const cropped = (zoom) => {
    const side = Math.round(square * zoom);
    return sharp(SOURCE_ART).extract({
      left: Math.round((width - side) / 2),
      top: Math.round((height - side) / 2),
      width: side,
      height: side,
    });
  };

  /** Emblem inside the safe zone, over a blurred full-bleed copy of itself. */
  async function renderMaskable() {
    const backdrop = await cropped(1)
      .resize(CANVAS, CANVAS)
      .blur(MASKABLE_BACKDROP_BLUR)
      .modulate({ brightness: MASKABLE_BACKDROP_DARKEN })
      .toBuffer();
    const art = Math.round(CANVAS * MASKABLE_ART_SCALE);
    const emblem = await cropped(1).resize(art, art).toBuffer();
    const offset = Math.round((CANVAS - art) / 2);
    return sharp(backdrop).composite([{ input: emblem, left: offset, top: offset }]);
  }

  console.log(`source: icons/source-art.png (${width}x${height})`);

  for (const { file, size, rounded, maskable } of OUTPUTS) {
    let image;
    if (maskable) {
      image = (await renderMaskable()).resize(size, size);
    } else {
      image = cropped(size <= SMALL_SIZE_THRESHOLD ? SMALL_CROP : 1).resize(size, size);
    }

    if (rounded) {
      // Scale the radius with the output so the curve stays proportional.
      const radius = Math.round((CORNER_RADIUS * size) / CANVAS);
      image = sharp(await image.png().toBuffer()).composite([
        { input: roundedMask(size, radius), blend: 'dest-in' },
      ]);
    }

    const png = await image
      .png({ compressionLevel: 9, palette: true, colors: PNG_PALETTE_COLORS })
      .toBuffer();
    await writeFile(join(ICONS_DIR, file), png);
    console.log(`wrote icons/${file} (${size}px, ${(png.length / 1024).toFixed(1)} KB)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

export { SOURCE_PROMPT };
