/**
 * Placement tests for the hover card preview. The failure this guards against is
 * a preview that opens partly off-screen — which happens for exactly the cards a
 * player most wants to inspect: the ones at the right and bottom of a board.
 */

import { describe, expect, it } from 'vitest';
import { previewPlacement } from './card-hover-position.js';
import {
  CARD_PREVIEW_ASPECT,
  CARD_PREVIEW_CURSOR_GAP_PX,
  CARD_PREVIEW_VIEWPORT_MARGIN_PX,
  CARD_PREVIEW_WIDTH_PX,
} from './card-hover-config.js';

const DESKTOP = { width: 1280, height: 800 };
const PANEL_HEIGHT = CARD_PREVIEW_WIDTH_PX * CARD_PREVIEW_ASPECT;

/** Every edge of the panel sits inside the viewport's margin. */
function isFullyOnScreen(
  placement: ReturnType<typeof previewPlacement>,
  viewport: { width: number; height: number },
): boolean {
  return (
    placement.left >= CARD_PREVIEW_VIEWPORT_MARGIN_PX &&
    placement.top >= CARD_PREVIEW_VIEWPORT_MARGIN_PX &&
    placement.left + placement.width <= viewport.width - CARD_PREVIEW_VIEWPORT_MARGIN_PX &&
    placement.top + placement.height <= viewport.height - CARD_PREVIEW_VIEWPORT_MARGIN_PX
  );
}

describe('card hover preview placement', () => {
  it('sits to the right of the cursor with room to spare', () => {
    const placement = previewPlacement({ x: 100, y: 400 }, DESKTOP);
    expect(placement.flipped).toBe(false);
    expect(placement.left).toBe(100 + CARD_PREVIEW_CURSOR_GAP_PX);
    expect(isFullyOnScreen(placement, DESKTOP)).toBe(true);
  });

  it('is vertically centred on the cursor when there is room', () => {
    const placement = previewPlacement({ x: 100, y: 400 }, DESKTOP);
    expect(placement.top).toBeCloseTo(400 - PANEL_HEIGHT / 2);
  });

  it('FLIPS to the cursor’s left rather than running off the right edge', () => {
    const nearRightEdge = { x: DESKTOP.width - 40, y: 400 };
    const placement = previewPlacement(nearRightEdge, DESKTOP);
    expect(placement.flipped).toBe(true);
    expect(placement.left).toBeLessThan(nearRightEdge.x);
    expect(isFullyOnScreen(placement, DESKTOP)).toBe(true);
  });

  it('clamps upward instead of overflowing the bottom edge', () => {
    const placement = previewPlacement({ x: 100, y: DESKTOP.height - 10 }, DESKTOP);
    expect(isFullyOnScreen(placement, DESKTOP)).toBe(true);
  });

  it('clamps downward instead of overflowing the top edge', () => {
    const placement = previewPlacement({ x: 100, y: 5 }, DESKTOP);
    expect(placement.top).toBe(CARD_PREVIEW_VIEWPORT_MARGIN_PX);
    expect(isFullyOnScreen(placement, DESKTOP)).toBe(true);
  });

  it('stays on screen from every corner of a desktop viewport', () => {
    const corners = [
      { x: 0, y: 0 },
      { x: DESKTOP.width, y: 0 },
      { x: 0, y: DESKTOP.height },
      { x: DESKTOP.width, y: DESKTOP.height },
      { x: DESKTOP.width / 2, y: DESKTOP.height / 2 },
    ];
    for (const corner of corners) {
      expect(isFullyOnScreen(previewPlacement(corner, DESKTOP), DESKTOP), JSON.stringify(corner)).toBe(true);
    }
  });

  it('keeps the card’s TOP visible when the viewport is shorter than the panel', () => {
    // A short window can't fit the card at all; showing its title beats showing
    // its bottom edge, so the top margin must win over the bottom clamp.
    const short = { width: 1280, height: Math.floor(PANEL_HEIGHT / 2) };
    const placement = previewPlacement({ x: 100, y: 10 }, short);
    expect(placement.top).toBe(CARD_PREVIEW_VIEWPORT_MARGIN_PX);
  });

  it('never lets the flipped panel cross the left margin on a narrow viewport', () => {
    const narrow = { width: CARD_PREVIEW_WIDTH_PX, height: 800 };
    const placement = previewPlacement({ x: narrow.width - 5, y: 400 }, narrow);
    expect(placement.left).toBeGreaterThanOrEqual(CARD_PREVIEW_VIEWPORT_MARGIN_PX);
  });
});
