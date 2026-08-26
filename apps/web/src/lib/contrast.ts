/**
 * WCAG 2.1 contrast math, from the spec's own definitions:
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance and #dfn-contrast-ratio.
 *
 * This exists so the design tokens in `styles.css` can be HELD to the floors
 * the app claims to meet: a reviewer measures a ratio on a screenshot, and a
 * unit test pins the same ratio on the palette values, so a token edit that
 * silently drops readable text below the floor fails in CI instead of in a
 * player's hands (TMB-JB-0003, TMB-JB-0004).
 *
 * Pure and dependency-free on purpose (CLAUDE.md: pure-core + mandatory
 * tests): no DOM, no canvas — just the arithmetic.
 */

/** sRGB channels at or below this are linearized by division… */
const SRGB_LINEAR_THRESHOLD = 0.03928;
/** …by this divisor (the spec's low-end linear segment). */
const SRGB_LINEAR_DIVISOR = 12.92;
/** Offset and scale of the sRGB gamma curve's high segment. */
const SRGB_GAMMA_OFFSET = 0.055;
const SRGB_GAMMA_SCALE = 1.055;
/** Exponent of the sRGB gamma curve's high segment. */
const SRGB_GAMMA_EXPONENT = 2.4;

/** Rec. 709 luma coefficients — how much each channel contributes to brightness. */
const LUMINANCE_RED_WEIGHT = 0.2126;
const LUMINANCE_GREEN_WEIGHT = 0.7152;
const LUMINANCE_BLUE_WEIGHT = 0.0722;

/** The spec's ambient-flare term: added to both luminances before dividing. */
const AMBIENT_FLARE = 0.05;

/** WCAG 2.1 SC 1.4.3 — minimum ratio for normal ("body") text, AA. */
export const WCAG_AA_BODY_TEXT_MIN = 4.5;
/** WCAG 2.1 SC 1.4.11 — minimum ratio for non-text UI components and graphics. */
export const WCAG_AA_NON_TEXT_MIN = 3;

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const MAX_CHANNEL = 255;

/**
 * Parse `#rgb` or `#rrggbb` into [r, g, b] bytes. Throws on anything else:
 * every caller here feeds it literals lifted from a stylesheet, so a bad
 * value is a bug in the test or the stylesheet, not user data to tolerate.
 */
export function parseHexColor(hex: string): readonly [number, number, number] {
  if (!HEX_COLOR_PATTERN.test(hex)) {
    throw new Error(`Not a hex color: "${hex}" (expected #rgb or #rrggbb)`);
  }
  const digits = hex.slice(1);
  const wide = digits.length === 6 ? digits : [...digits].map((d) => d + d).join('');
  return [
    Number.parseInt(wide.slice(0, 2), 16),
    Number.parseInt(wide.slice(2, 4), 16),
    Number.parseInt(wide.slice(4, 6), 16),
  ];
}

/** One sRGB channel byte → its linear-light value, per the WCAG formula. */
function linearizeChannel(byte: number): number {
  const proportion = byte / MAX_CHANNEL;
  return proportion <= SRGB_LINEAR_THRESHOLD
    ? proportion / SRGB_LINEAR_DIVISOR
    : ((proportion + SRGB_GAMMA_OFFSET) / SRGB_GAMMA_SCALE) ** SRGB_GAMMA_EXPONENT;
}

/** WCAG relative luminance of a hex color: 0 = black, 1 = white. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHexColor(hex);
  return (
    LUMINANCE_RED_WEIGHT * linearizeChannel(r) +
    LUMINANCE_GREEN_WEIGHT * linearizeChannel(g) +
    LUMINANCE_BLUE_WEIGHT * linearizeChannel(b)
  );
}

/**
 * WCAG contrast ratio between two hex colors, 1 (identical) to 21 (black on
 * white). Order-independent — the spec always puts the lighter color on top.
 */
export function contrastRatio(colorA: string, colorB: string): number {
  const luminanceA = relativeLuminance(colorA);
  const luminanceB = relativeLuminance(colorB);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + AMBIENT_FLARE) / (darker + AMBIENT_FLARE);
}
