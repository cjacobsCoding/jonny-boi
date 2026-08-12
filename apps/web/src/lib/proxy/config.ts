/**
 * Named configuration for the Proxies print feature. Every physical dimension,
 * grid size, rate-limit, and batch size lives here (CLAUDE.md rule #1 — no magic
 * numbers). The print CSS and the proxy logic read these named tokens; nothing
 * inlines a literal millimeter or a card-per-page count.
 *
 * The physical sizes are the crux: an MTG card is exactly 63mm × 88mm
 * (2.5in × 3.5in). Printed at that size the cut-out proxy slides into a real
 * sleeve, so these are non-negotiable and expressed in true `mm` units.
 */

/** Exact MTG card width for a cut-to-size proxy (millimeters). */
export const CARD_WIDTH_MM = 63;

/** Exact MTG card height for a cut-to-size proxy (millimeters). */
export const CARD_HEIGHT_MM = 88;

/** A print page size the user can target. Dimensions are the printable sheet. */
export interface PageSize {
  id: 'a4' | 'letter';
  label: string;
  /** CSS `@page size` keyword (drives the true physical page). */
  cssSize: string;
  widthMm: number;
  heightMm: number;
}

/** A4 and US Letter — the two sheet sizes we support (user-selectable). */
export const PAGE_SIZES: readonly PageSize[] = [
  { id: 'a4', label: 'A4', cssSize: 'A4', widthMm: 210, heightMm: 297 },
  // US Letter is 8.5in × 11in; expressed in mm for a single consistent unit.
  { id: 'letter', label: 'US Letter', cssSize: 'letter', widthMm: 215.9, heightMm: 279.4 },
] as const;

export type PageSizeId = PageSize['id'];

/** The default sheet if the user hasn't chosen one. */
export const DEFAULT_PAGE_SIZE_ID: PageSizeId = 'a4';

/** Look up a page size by id, falling back to the default. */
export function getPageSize(id: PageSizeId): PageSize {
  return PAGE_SIZES.find((p) => p.id === id) ?? PAGE_SIZES[0]!;
}

/**
 * Grid density options. 3×3 (9/page) is the universal proxy layout — it fills
 * both A4 and Letter at exact card size — and is the default. A denser or looser
 * option is offered but the physical card size never changes.
 */
export interface GridDensity {
  id: string;
  label: string;
  columns: number;
  rows: number;
}

export const GRID_DENSITIES: readonly GridDensity[] = [
  { id: '3x3', label: '3 × 3 (9 / page)', columns: 3, rows: 3 },
  { id: '2x3', label: '2 × 3 (6 / page)', columns: 2, rows: 3 },
  { id: '2x2', label: '2 × 2 (4 / page)', columns: 2, rows: 2 },
] as const;

/** The default grid density (standard 3×3 = 9 cards per page). */
export const DEFAULT_DENSITY_ID = '3x3';

/** Look up a density by id, falling back to the default 3×3. */
export function getDensity(id: string): GridDensity {
  return GRID_DENSITIES.find((d) => d.id === id) ?? GRID_DENSITIES[0]!;
}

/** Cards per page for a density. */
export function perPageFor(density: GridDensity): number {
  return density.columns * density.rows;
}

/** Page margin around the card grid (millimeters) — keeps cards off the edge. */
export const PAGE_MARGIN_MM = 6;

/** Gap between adjacent cards in the grid (millimeters). A small gutter gives
 * scissors room and prevents ink bleed from one card touching the next. */
export const CARD_GAP_MM = 1.5;

/** Hairline weight for the cut guides (millimeters). Thin + black = print-safe. */
export const CUT_GUIDE_WIDTH_MM = 0.2;

/**
 * Minimum interval between Scryfall requests (milliseconds). Mirrors the
 * data-tools etiquette floor: Scryfall asks for ≤10 req/sec (≥100ms apart).
 */
export const MIN_REQUEST_INTERVAL_MS = 100;

/** Scryfall's `/cards/collection` hard cap: ≤75 identifiers per request. */
export const COLLECTION_BATCH_SIZE = 75;

/** Descriptive User-Agent per Scryfall etiquette (they reject anonymous bots). */
export const SCRYFALL_USER_AGENT =
  'jonny-boi/0.1 (MTG deck-tuning lab; contact via repo)';

/** Base URL for the public Scryfall REST API (no key required). */
export const SCRYFALL_API_BASE = 'https://api.scryfall.com';

/** Collection endpoint path — bulk name resolution. */
export const SCRYFALL_COLLECTION_PATH = '/cards/collection';

/** localStorage key for the resolved-card cache (name → best image). */
export const PROXY_CACHE_STORAGE_KEY = 'jonny-boi.proxyCache.v1';

/** Scryfall attribution line (etiquette — card images © Wizards, via Scryfall). */
export const SCRYFALL_ATTRIBUTION =
  'Card images © Wizards of the Coast, sourced via the Scryfall API.';
