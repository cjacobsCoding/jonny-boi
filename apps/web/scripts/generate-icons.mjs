/**
 * jonny-boi app-icon generator — "The Rake".
 *
 * Something enormous has clawed through the dark from the other side. Three
 * gashes rip across the plane and the light of the five colors of magic bleeds
 * out of them: wild, visceral, and unmistakably *fantastic*.
 *
 * The mark is 100% original vector geometry — nothing here is traced from, or
 * derived from, Wizards/Scryfall artwork, and no trademarked symbol (mana pips,
 * the planeswalker sigil, tap symbols) is used. The only borrowed idea is the
 * five colors of magic *as colors*, which is a game concept, not IP.
 *
 * Every dimension, angle, and color below is a NAMED constant (DESIGN.md §1:
 * no magic numbers), and all three icon variants are composed from the SAME
 * geometry, so tuning the mark tunes every output at once.
 *
 * Run:  node apps/web/scripts/generate-icons.mjs
 *
 * Always emits the SVG variants. PNGs (needed by iOS `apple-touch-icon`, which
 * does not accept SVG) are emitted only when `sharp` resolves — it is
 * deliberately NOT a repo dependency, since the rendered PNGs are committed and
 * only need regenerating when the art changes (`npm i -D sharp` to do so).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

/** Icon artboard is square; all geometry below is in these user units. */
const CANVAS = 512;
const CENTER = CANVAS / 2;

/** Corner rounding for the standalone (non-masked) icon — a soft squircle. */
const CORNER_RADIUS = 112;

/**
 * Maskable icons may be cropped to a circle of 80% of the artboard, so the mark
 * is shrunk until its farthest spark sits inside that safe zone.
 */
const MASKABLE_CONTENT_SCALE = 0.82;

// ---------------------------------------------------------------------------
// Palette (icon-local; mirrors the app tokens in styles.css)
// ---------------------------------------------------------------------------

const PLANE_CORE = '#19212c'; // lit center of the dark plane
const PLANE_EDGE = '#080b0f'; // vignetted rim, just under the app's --color-bg
const CHAR = '#05070a'; // charred lip of a tear, separating light from plane
const GOLD = '#e0c45a'; // --color-accent-soft: frame and tear rim

/**
 * How far the light *inside* a tear is blown out toward white. The core keeps a
 * trace of its local spectrum color so the openings and their glow read as one
 * light source, rather than as ivory claws laid over a rainbow.
 */
const TEAR_CORE_WHITEN = 0.74;

/**
 * The five colors of magic, brightened into *emitted light* rather than the
 * UI's surface tints, and refracted along the rake so every gash shows the whole
 * spectrum. Black is the one real departure: `--mana-b` (#3a3340) is invisible
 * as a glow, so its band is the violet that dark mana reads as.
 *
 * `at` is the position along the gash (0 = trailing tip, 1 = leading tip). The
 * order is a consecutive walk around the color wheel (R→G→W→U→B), which keeps
 * every neighbour pair harmonious and puts white at the hot middle of the tear.
 */
const MANA_SPECTRUM = [
  { id: 'r', color: '#ff5a3c', at: 0 },
  { id: 'g', color: '#3fc673', at: 0.26 },
  { id: 'w', color: '#fff6df', at: 0.5 },
  { id: 'u', color: '#3f9bff', at: 0.74 },
  { id: 'b', color: '#a45cf0', at: 1 },
];

/** Length of the spectrum's axis, centered on the artboard, along the rake. */
const SPECTRUM_SPAN = 372;

// ---------------------------------------------------------------------------
// The rake — three gashes torn across the plane
// ---------------------------------------------------------------------------

/**
 * Screen direction the claws travelled, in degrees (0 = right, +y is down), so
 * a negative angle rakes up and to the right.
 */
const RAKE_ANGLE_DEG = -58;

/**
 * One entry per gash, positioned in rake-local coordinates:
 *  - `across`     perpendicular distance from the artboard center
 *  - `along`      shift along the rake, staggering the tips like a real rake
 *  - `length`     tip-to-tip distance
 *  - `halfWidth`  widest half-thickness, at the middle of the gash
 *  - `bow`        how far the gash curves away from its own chord
 *  - `angleDelta` per-gash fan, so the claws are not perfectly parallel
 */
const GASHES = [
  { across: -112, along: -22, length: 296, halfWidth: 14, bow: 26, angleDelta: -5 },
  { across: -14, along: 6, length: 376, halfWidth: 20, bow: 31, angleDelta: 0 },
  { across: 88, along: 30, length: 318, halfWidth: 16, bow: 27, angleDelta: 4 },
];

/** Charred lip drawn just outside the hot core, so each tear reads as depth. */
const CHAR_WIDTH = 9;
/** Thin burning rim on top of the char. */
const RIM_WIDTH = 3;
const RIM_OPACITY = 0.85;

// ---------------------------------------------------------------------------
// Bleed — the five-color light escaping the tears
// ---------------------------------------------------------------------------

/**
 * The glow is the rake itself, stroked ever wider and blurred: a tight hot edge,
 * a mid bleed, and a broad wash thrown onto the plane. Widest first, so each
 * layer stacks on top of the softer one beneath it.
 */
const BLEED_LAYERS = [
  { strokeWidth: 168, blur: 44, opacity: 0.34, withSparks: false },
  { strokeWidth: 76, blur: 19, opacity: 0.6, withSparks: false },
  // Sparks join only the tightest layer — the broad washes would smear them into
  // blobs instead of leaving them as pinpricks of light.
  { strokeWidth: 30, blur: 7, opacity: 0.85, withSparks: true },
];

// ---------------------------------------------------------------------------
// Sparks — embers thrown off the ends of the gashes
// ---------------------------------------------------------------------------

/**
 * `gash` indexes GASHES, `atEnd` picks the leading (1) or trailing (-1) tip,
 * `gap` is the distance past that tip, `drift` the sideways offset.
 */
const SPARKS = [
  { gash: 0, atEnd: 1, gap: 30, drift: 11, size: 7 },
  { gash: 0, atEnd: -1, gap: 24, drift: -9, size: 4.5 },
  { gash: 1, atEnd: 1, gap: 27, drift: -13, size: 7.5 },
  { gash: 1, atEnd: 1, gap: 58, drift: 5, size: 4 },
  { gash: 1, atEnd: -1, gap: 32, drift: 10, size: 5.5 },
  { gash: 2, atEnd: 1, gap: 25, drift: 14, size: 6 },
  { gash: 2, atEnd: -1, gap: 36, drift: -11, size: 4 },
];
/** Sparks are stretched along the rake, like motion streaks. */
const SPARK_STRETCH = 2.6;

// ---------------------------------------------------------------------------
// Frame — a thin inset border, a nod to a card's bevel
// ---------------------------------------------------------------------------

const FRAME_INSET = 24;
const FRAME_RADIUS = CORNER_RADIUS - FRAME_INSET;
const FRAME_WIDTH = 4;
const FRAME_OPACITY = 0.2;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const toRad = (deg) => (deg * Math.PI) / 180;
const round = (n) => Number(n.toFixed(2));

/** Blend a `#rrggbb` toward white by `amount` (0 = unchanged, 1 = white). */
function whiten(hex, amount) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `#${channels
    .map((c) =>
      Math.round(c + (255 - c) * amount)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

const unit = (deg) => [Math.cos(toRad(deg)), Math.sin(toRad(deg))];
/** Perpendicular of a screen direction, rotated a quarter turn. */
const perpOf = ([dx, dy]) => [-dy, dx];

/**
 * Outline of one gash: a leaf/lens bowed off its chord, pointed at both tips.
 *
 * Each side is a quadratic Bézier. A quadratic's midpoint sits halfway between
 * its chord and its control point, so a control offset of `2 * d` yields an
 * actual deviation of `d` — hence the doubling below.
 */
function gashPath(gash, widthScale = 1) {
  const dir = unit(RAKE_ANGLE_DEG + gash.angleDelta);
  const perp = perpOf(dir);
  const cx = CENTER + perp[0] * gash.across + dir[0] * gash.along;
  const cy = CENTER + perp[1] * gash.across + dir[1] * gash.along;
  const half = gash.length / 2;

  const tail = [cx - dir[0] * half, cy - dir[1] * half];
  const head = [cx + dir[0] * half, cy + dir[1] * half];
  const width = gash.halfWidth * widthScale;

  const control = (deviation) => [
    round(cx + perp[0] * 2 * deviation),
    round(cy + perp[1] * 2 * deviation),
  ];
  const outer = control(gash.bow + width);
  const inner = control(gash.bow - width);

  return (
    `M${round(tail[0])} ${round(tail[1])}` +
    ` Q${outer[0]} ${outer[1]} ${round(head[0])} ${round(head[1])}` +
    ` Q${inner[0]} ${inner[1]} ${round(tail[0])} ${round(tail[1])} Z`
  );
}

const rakePaths = (widthScale) => GASHES.map((gash) => gashPath(gash, widthScale));

/** Ember diamonds, stretched along the rake so they read as flying sparks. */
function sparkPaths() {
  return SPARKS.map((spark) => {
    const gash = GASHES[spark.gash];
    const dir = unit(RAKE_ANGLE_DEG + gash.angleDelta);
    const perp = perpOf(dir);
    const reach = gash.length / 2 + spark.gap;
    const x =
      CENTER + perp[0] * (gash.across + spark.drift) + dir[0] * (gash.along + spark.atEnd * reach);
    const y =
      CENTER + perp[1] * (gash.across + spark.drift) + dir[1] * (gash.along + spark.atEnd * reach);
    const long = spark.size * SPARK_STRETCH;
    const wide = spark.size * 0.5;
    const p = (a, b) =>
      `${round(x + dir[0] * a + perp[0] * b)} ${round(y + dir[1] * a + perp[1] * b)}`;
    return `M${p(-long, 0)} L${p(0, -wide)} L${p(long, 0)} L${p(0, wide)} Z`;
  });
}

// ---------------------------------------------------------------------------
// SVG composition
// ---------------------------------------------------------------------------

/** The spectrum gradient's axis: along the rake, centered on the artboard. */
function spectrumAxis() {
  const dir = unit(RAKE_ANGLE_DEG);
  const half = SPECTRUM_SPAN / 2;
  return {
    x1: round(CENTER - dir[0] * half),
    y1: round(CENTER - dir[1] * half),
    x2: round(CENTER + dir[0] * half),
    y2: round(CENTER + dir[1] * half),
  };
}

function defsMarkup(rounded) {
  const axis = spectrumAxis();
  const stopsFor = (transform) =>
    MANA_SPECTRUM.map(
      (band) => `<stop offset="${band.at}" stop-color="${transform(band.color)}" />`,
    ).join('\n      ');
  const blurFilters = BLEED_LAYERS.map(
    (layer, i) => `<filter id="bleed-blur-${i}" x="-45%" y="-45%" width="190%" height="190%">
      <feGaussianBlur stdDeviation="${layer.blur}" />
    </filter>`,
  ).join('\n    ');

  return `<defs>
    <clipPath id="plane-clip">
      <rect width="${CANVAS}" height="${CANVAS}"${rounded ? ` rx="${CORNER_RADIUS}"` : ''} />
    </clipPath>
    <radialGradient id="plane" gradientUnits="userSpaceOnUse"
        cx="${CENTER}" cy="${CENTER}" r="${CENTER}">
      <stop offset="0" stop-color="${PLANE_CORE}" />
      <stop offset="1" stop-color="${PLANE_EDGE}" />
    </radialGradient>
    <linearGradient id="spectrum" gradientUnits="userSpaceOnUse"
        x1="${axis.x1}" y1="${axis.y1}" x2="${axis.x2}" y2="${axis.y2}">
      ${stopsFor((color) => color)}
    </linearGradient>
    <linearGradient id="tear-core" gradientUnits="userSpaceOnUse"
        x1="${axis.x1}" y1="${axis.y1}" x2="${axis.x2}" y2="${axis.y2}">
      ${stopsFor((color) => whiten(color, TEAR_CORE_WHITEN))}
    </linearGradient>
    ${blurFilters}
  </defs>`;
}

/**
 * Compose one icon variant.
 *
 * @param {object} options
 * @param {boolean} options.rounded    Round the plane's corners (off for maskable —
 *                                     the launcher supplies its own mask).
 * @param {number}  options.scale      Content scale about the center (safe zone).
 * @param {boolean} options.detail     Draw the sparks. Off below ~48px, where they
 *                                     turn to mud.
 * @param {boolean} options.frame      Draw the inset border. Off for maskable, whose
 *                                     artboard edges are cropped away by the launcher.
 * @param {number}  options.gashWidth  Gash fattening factor.
 * @param {string}  options.label      Accessible name.
 */
function renderIcon({ rounded, scale, detail, frame: withFrame, gashWidth, label }) {
  const rake = rakePaths(gashWidth);
  const plane = rounded
    ? `<rect width="${CANVAS}" height="${CANVAS}" rx="${CORNER_RADIUS}" fill="url(#plane)" />`
    : `<rect width="${CANVAS}" height="${CANVAS}" fill="url(#plane)" />`;

  const contentTransform =
    scale === 1
      ? ''
      : ` transform="translate(${round(CENTER * (1 - scale))} ${round(CENTER * (1 - scale))}) scale(${scale})"`;

  const embers = detail ? sparkPaths() : [];
  const bleed = BLEED_LAYERS.map((layer, i) => {
    const lit = layer.withSparks ? [...rake, ...embers] : rake;
    return `<g filter="url(#bleed-blur-${i})" opacity="${layer.opacity}">
        ${lit
          .map(
            (d) =>
              `<path d="${d}" fill="url(#spectrum)" stroke="url(#spectrum)" stroke-width="${layer.strokeWidth}" stroke-linejoin="round" />`,
          )
          .join('\n        ')}
      </g>`;
  }).join('\n      ');

  const tears = rake
    .map(
      (d) => `<path d="${d}" fill="none" stroke="${CHAR}" stroke-width="${CHAR_WIDTH}" />
      <path d="${d}" fill="none" stroke="${GOLD}" stroke-width="${RIM_WIDTH}" stroke-opacity="${RIM_OPACITY}" />
      <path d="${d}" fill="url(#tear-core)" />`,
    )
    .join('\n      ');

  const sparks = embers.length
    ? `\n      <g fill="url(#tear-core)">
        ${embers.map((d) => `<path d="${d}" />`).join('\n        ')}
      </g>`
    : '';

  const frame = withFrame
    ? `\n    <rect x="${FRAME_INSET}" y="${FRAME_INSET}"
      width="${CANVAS - FRAME_INSET * 2}" height="${CANVAS - FRAME_INSET * 2}"
      rx="${FRAME_RADIUS}" fill="none"
      stroke="${GOLD}" stroke-opacity="${FRAME_OPACITY}" stroke-width="${FRAME_WIDTH}" />`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${CANVAS}" height="${CANVAS}" role="img" aria-label="${label}">
  <title>${label}</title>
  ${defsMarkup(rounded)}
  ${plane}
  <g clip-path="url(#plane-clip)">
    <g${contentTransform}>
      ${bleed}
      ${tears}${sparks}
    </g>
  </g>${frame}
</svg>
`;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

const LABEL = 'jonny-boi';

/** SVG variants, each tuned for where it is displayed. */
const SVG_VARIANTS = [
  {
    file: 'icon.svg',
    options: { rounded: true, scale: 1, detail: true, frame: true, gashWidth: 1, label: LABEL },
  },
  {
    // Full-bleed plane, mark inside the 80% safe circle — Android adaptive icons.
    file: 'icon-maskable.svg',
    options: {
      rounded: false,
      scale: MASKABLE_CONTENT_SCALE,
      detail: true,
      frame: false,
      gashWidth: 1,
      label: `${LABEL} (maskable)`,
    },
  },
  {
    // Browser-tab size: no hairlines, fatter gashes, so the rake survives 16px.
    file: 'favicon.svg',
    options: { rounded: true, scale: 1, detail: false, frame: false, gashWidth: 1.5, label: LABEL },
  },
];

/**
 * Smooth gradients over a dark plane are pathological for PNG's filters — a
 * truecolor render of the 512px icon lands near half a megabyte. Palette
 * quantization brings it under ~60KB with no visible banding at icon sizes.
 */
const PNG_PALETTE_COLORS = 220;

/** Raster fallbacks. iOS ignores SVG icons entirely, so these carry the install. */
const PNG_VARIANTS = [
  { file: 'icon-192.png', from: 'icon.svg', size: 192 },
  { file: 'icon-512.png', from: 'icon.svg', size: 512 },
  { file: 'icon-maskable-512.png', from: 'icon-maskable.svg', size: 512 },
  { file: 'apple-touch-icon.png', from: 'icon.svg', size: 180 },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const svgByFile = new Map();
  for (const { file, options } of SVG_VARIANTS) {
    const svg = renderIcon(options);
    svgByFile.set(file, svg);
    await writeFile(join(OUT_DIR, file), svg, 'utf8');
    console.log(`wrote icons/${file}`);
  }

  let sharp;
  try {
    ({ default: sharp } = await import('sharp'));
  } catch {
    console.log('\nsharp not installed — skipped PNGs (npm i -D sharp to regenerate them).');
    return;
  }

  for (const { file, from, size } of PNG_VARIANTS) {
    const png = await sharp(Buffer.from(svgByFile.get(from)), { density: 384 })
      .resize(size, size)
      .png({ compressionLevel: 9, palette: true, colors: PNG_PALETTE_COLORS })
      .toBuffer();
    await writeFile(join(OUT_DIR, file), png);
    console.log(`wrote icons/${file} (${(png.length / 1024).toFixed(1)} KB)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
