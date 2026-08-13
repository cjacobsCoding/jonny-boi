/**
 * Where the hover card preview is drawn — the one part of the preview with real
 * logic, kept pure and DOM-free so it can be unit-tested without a browser.
 *
 * The panel follows the cursor, but a naive "cursor + gap" placement runs off the
 * screen for any card near the right or bottom edge of the board — exactly where
 * a battlefield's later permanents sit. So it flips to the cursor's other side
 * when it would overflow horizontally, and rides inside the viewport vertically.
 */

import {
  CARD_PREVIEW_ASPECT,
  CARD_PREVIEW_CURSOR_GAP_PX,
  CARD_PREVIEW_VIEWPORT_MARGIN_PX,
  CARD_PREVIEW_WIDTH_PX,
} from './card-hover-config.js';

/** A point in viewport coordinates (the cursor, or a focused tile's corner). */
export interface PreviewAnchor {
  readonly x: number;
  readonly y: number;
}

/** The viewport the panel must stay inside. */
export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** Resolved placement, in viewport pixels. */
export interface PreviewPlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** True when the panel was flipped to the anchor's left to stay on screen. */
  readonly flipped: boolean;
}

/**
 * Place the preview beside `anchor`, clamped inside `viewport`.
 *
 * Horizontal: prefer the anchor's right; flip to its left when the panel would
 * cross the right margin. Vertical: centre on the anchor, then clamp so neither
 * edge crosses the margin. When the viewport is shorter than the panel the top
 * margin wins, so the card's title stays visible rather than its bottom edge.
 */
export function previewPlacement(
  anchor: PreviewAnchor,
  viewport: Viewport,
  width: number = CARD_PREVIEW_WIDTH_PX,
): PreviewPlacement {
  const height = width * CARD_PREVIEW_ASPECT;

  const rightEdge = anchor.x + CARD_PREVIEW_CURSOR_GAP_PX + width;
  const flipped = rightEdge > viewport.width - CARD_PREVIEW_VIEWPORT_MARGIN_PX;
  const left = flipped
    ? Math.max(CARD_PREVIEW_VIEWPORT_MARGIN_PX, anchor.x - CARD_PREVIEW_CURSOR_GAP_PX - width)
    : anchor.x + CARD_PREVIEW_CURSOR_GAP_PX;

  const lowestTop = viewport.height - height - CARD_PREVIEW_VIEWPORT_MARGIN_PX;
  const top = Math.max(
    CARD_PREVIEW_VIEWPORT_MARGIN_PX,
    Math.min(anchor.y - height / 2, lowestTop),
  );

  return { left, top, width, height, flipped };
}
