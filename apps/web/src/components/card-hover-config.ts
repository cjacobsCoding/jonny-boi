/**
 * Tunable geometry for the hover card preview (DESIGN §1 — no magic numbers).
 * A designer retunes the preview's size and spacing here; the component reads
 * these and never hard-codes a pixel.
 */

/**
 * Rendered width of the floating preview. Sized so the rules text on a standard
 * Scryfall card face is comfortably readable on a desktop display — the whole
 * point of the preview, since the board tiles are art crops.
 */
export const CARD_PREVIEW_WIDTH_PX = 340;

/**
 * Height/width ratio of a Magic card (88mm × 63mm). The preview derives its
 * height from the width via this ratio so the panel is never letterboxed.
 */
export const CARD_PREVIEW_ASPECT = 88 / 63;

/** Gap between the cursor and the preview, so the panel never sits under it. */
export const CARD_PREVIEW_CURSOR_GAP_PX = 18;

/** Minimum breathing room kept between the preview and the viewport edges. */
export const CARD_PREVIEW_VIEWPORT_MARGIN_PX = 12;
