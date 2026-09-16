/**
 * The arithmetic behind the virtualised card grid — pure, DOM-free, and
 * therefore actually testable (DESIGN.md §1.4: the pure core is where the rules
 * live; the thin DOM edge only measures and renders).
 *
 * ## What problem this solves
 *
 * The Cards browser and the Deck Builder's pool both rendered EVERY card in the
 * pool as a tile. At 5,651 cards that was ~5 MB of DOM and hundreds of
 * cross-origin Scryfall image requests on the app's landing view; the pool is
 * being grown toward a 32,276-card corpus, at which a renders-everything grid
 * is not slow but unusable. The fix has to scale with the pool, not be tuned
 * for one pool size — so what is computed here is a WINDOW, and the number of
 * tiles it names is a function of the VIEWPORT, never of `itemCount`.
 *
 * ## Why it renders SEGMENTS rather than one range
 *
 * Almost always there is exactly one segment: the rows on screen plus a little
 * overscan. The second segment exists for keyboard focus. If the user tabs to a
 * tile and then wheel-scrolls away, a single-range virtualiser unmounts the
 * focused element; the browser hands focus back to `<body>`, and the next Tab
 * restarts from the top of the document. Keeping the focused row (and one row
 * either side, so Tab and Shift+Tab have somewhere real to go) mounted costs a
 * bounded handful of tiles and keeps the grid usable without a mouse.
 *
 * Widening one range to cover both instead would render everything between
 * them — thousands of rows — which is the bug this file exists to prevent.
 */
import {
  CARD_GRID_FALLBACK_COLUMNS,
  CARD_GRID_FALLBACK_ROW_PITCH_PX,
  CARD_GRID_FOCUS_KEEP_ROWS,
  CARD_GRID_INITIAL_ROWS,
  CARD_GRID_MIN_BELIEVABLE_ROW_PITCH_PX,
  CARD_GRID_MIN_TILE_ASPECT,
  CARD_GRID_OVERSCAN_ROWS,
} from './card-grid-config.js';

/**
 * What a laid-out grid told us about itself. Every field comes from the
 * browser's own resolved values (`getComputedStyle`, `getBoundingClientRect`),
 * never from a constant that duplicates the stylesheet.
 */
export interface GridMetrics {
  /** Column tracks the CSS `auto-fill` actually resolved to. */
  readonly columns: number;
  /** A tile's own height in px, which becomes the row track height. */
  readonly rowHeightPx: number;
  /** The grid's row gap in px. */
  readonly rowGapPx: number;
  /**
   * False when these are the documented fallbacks rather than a measurement —
   * server rendering, a DOM-free test, or the first paint. Surfaced in the bug
   * report's state dump so a fallback that fires is never silent.
   */
  readonly measured: boolean;
}

/** The fallback metrics, used only where there is nothing to measure. */
export const FALLBACK_GRID_METRICS: GridMetrics = Object.freeze({
  columns: CARD_GRID_FALLBACK_COLUMNS,
  // The fallback is stated as a PITCH in config (the number anyone measuring a
  // screenshot can check); the gap is folded into it here so the two forms can
  // never drift apart.
  rowHeightPx: CARD_GRID_FALLBACK_ROW_PITCH_PX,
  rowGapPx: 0,
  measured: false,
});

/** A half-open `[start, end)` range of indices into the result list. */
export type IndexSegment = readonly [start: number, end: number];

/** Everything the grid needs in order to render one frame. */
export interface RenderPlan {
  /** Disjoint, ascending index ranges to render. Usually exactly one. */
  readonly segments: readonly IndexSegment[];
  /** How many items those segments name — the node-count driver. */
  readonly renderedCount: number;
  /** Rows the whole result list occupies. */
  readonly rowCount: number;
  /** Height the grid occupies so the scrollbar tells the truth, in px. */
  readonly totalHeightPx: number;
  /** The row track height to pin, in px. */
  readonly rowHeightPx: number;
  /**
   * The column count this plan was computed with.
   *
   * Carried ON the plan rather than read from the metrics at render time so
   * that the row a cell is placed in and the row count the padding was sized
   * from can never be computed from two different column counts. They are one
   * answer to one question (rule 12), and a frame where they disagreed would
   * place cells in the wrong rows.
   */
  readonly columns: number;
  /**
   * The row the first rendered cell sits in. Cells are placed RELATIVE to it
   * (`grid-row-start: row - originRow + 1`) rather than at their absolute row.
   *
   * ⚠️ This is not a micro-optimisation, it is the difference between O(window)
   * and O(pool) layout work. CSS Grid materialises an implicit row track for
   * every row up to the largest one an item is placed in, so placing a cell at
   * its absolute row 5,379 — where the 32,276-card corpus ends — makes the
   * browser build 5,379 track records on every layout of a grid that contains
   * about forty elements. Placing relative to the window and pushing the window
   * down with padding keeps the track count the size of the window.
   */
  readonly originRow: number;
  /** Padding that stands in for the rows above the window, in px. */
  readonly paddingTopPx: number;
  /** Padding that stands in for the rows below the window, in px. */
  readonly paddingBottomPx: number;
}

/** Distance from one row's top to the next row's top. */
export function rowPitchPx(metrics: GridMetrics): number {
  return metrics.rowHeightPx + metrics.rowGapPx;
}

/**
 * True when this grid is working from a real layout. The inverse is not an
 * error — it is the documented first-paint/no-DOM path — but it is worth being
 * able to SAY, which is why it is a function rather than a buried boolean.
 */
export function cardGridMetricsAreMeasured(metrics: GridMetrics): boolean {
  return metrics.measured;
}

/**
 * Accept a measurement only if it could plausibly have come from a laid-out
 * grid; otherwise say so and hand back the fallback.
 *
 * A hidden, collapsed or not-yet-laid-out tile reports a height of a few px,
 * and dividing a scroll offset by that asks for tens of thousands of rows —
 * i.e. exactly the unbounded render this system exists to prevent, arriving
 * through the back door. A closed check that REPORTS rather than widening to
 * whatever was passed (rule 2).
 *
 * ## ⚠️ WHY `tileWidthPx` IS REQUIRED, AND NOT OPTIONAL
 *
 * The pitch floor above is a floor against *nothing*, and there is a whole
 * class of readings that clear it and are still not a tile. The one that took
 * the card browser down: a tile whose art box has no width to work from gets a
 * zero-height art box out of its `aspect-ratio` and measures its BODY alone —
 * 94px at 192px wide. 94 + 16 sails past a floor of 40.
 *
 * What made that catastrophic rather than ugly is that `CardGrid` derives the
 * rendered window from this pitch: a 94px row track makes the window twice as
 * many rows, which mounts thirty more not-yet-laid-out tiles, which also
 * measure 94px. The measurement decided what was measured, and React unmounted
 * the app with error #185 after a handful of searches.
 *
 * So the width comes in as a REQUIRED argument rather than an optional extra: a
 * caller that has a height to offer has a width too — they come off the same
 * `getBoundingClientRect` — and an optional check is one a future caller
 * silently skips. See {@link CARD_GRID_MIN_TILE_ASPECT}.
 */
export function gridMetricsFrom(raw: {
  columns: number;
  rowHeightPx: number;
  rowGapPx: number;
  /** The widest tile measured in the same pass as `rowHeightPx`. */
  tileWidthPx: number;
}): GridMetrics {
  const columns = Math.floor(raw.columns);
  const pitch = raw.rowHeightPx + raw.rowGapPx;
  const believable =
    Number.isFinite(columns) &&
    columns >= 1 &&
    Number.isFinite(pitch) &&
    pitch >= CARD_GRID_MIN_BELIEVABLE_ROW_PITCH_PX &&
    tileShapeIsBelievable(raw.rowHeightPx, raw.tileWidthPx);
  if (!believable) return FALLBACK_GRID_METRICS;
  return {
    columns,
    rowHeightPx: raw.rowHeightPx,
    rowGapPx: raw.rowGapPx,
    measured: true,
  };
}

/**
 * Could a box this shape be a laid-out card tile?
 *
 * Exported so the thing that refuses a reading can be tested, and named, on its
 * own — "the metrics fell back" is a symptom, "that tile was wider than it was
 * tall, so it had not laid out" is a diagnosis.
 *
 * A width that is missing or nonsensical answers TRUE: this check's job is to
 * catch a collapsed tile, and a caller with no width to offer is a different
 * problem, already covered by the pitch floor. Answering false there would turn
 * every DOM-free caller into a permanent fallback.
 */
export function tileShapeIsBelievable(rowHeightPx: number, tileWidthPx: number): boolean {
  if (!Number.isFinite(tileWidthPx) || tileWidthPx <= 0) return true;
  if (!Number.isFinite(rowHeightPx)) return false;
  return rowHeightPx >= tileWidthPx * CARD_GRID_MIN_TILE_ASPECT;
}

/**
 * How many columns fit, derived from what the browser actually laid out.
 *
 * ## ⚠️ Why this is NOT read from `grid-template-columns`
 *
 * It was, and that was a trap that could not recover from itself. The
 * virtualiser groups items into rows by this count and lets the grid's own
 * auto-placement choose the column. Place one item too many in a row and CSS
 * Grid invents an IMPLICIT column for the surplus — and `getComputedStyle`
 * reports implicit tracks in `grid-template-columns` alongside the declared
 * ones. So the count fed the layout, the layout fed the count, and a six-column
 * reading survived a resize to a 375px phone that declares two: two real cards
 * beside four collapsed slivers, on every row, permanently.
 *
 * Measuring instead breaks the loop, because a tile's WIDTH comes from the
 * explicit `1fr` track it sits in and not from the count we guessed: the two
 * real tiles stay ~165px wide while the surplus collapse to nothing, so the
 * widest tile still says how wide a column is, and the next frame corrects.
 *
 * Pure, so the arithmetic is testable without a browser.
 *
 * @param contentWidthPx the grid's content box width
 * @param tileWidthPx    the widest tile currently rendered
 * @param columnGapPx    the grid's column gap
 */
export function deriveColumnCount(
  contentWidthPx: number,
  tileWidthPx: number,
  columnGapPx: number,
): number | null {
  if (!Number.isFinite(contentWidthPx) || !Number.isFinite(tileWidthPx)) return null;
  if (contentWidthPx <= 0 || tileWidthPx <= 0) return null;
  const gap = Number.isFinite(columnGapPx) && columnGapPx > 0 ? columnGapPx : 0;
  // A grid of N columns is N tiles plus N-1 gaps, so adding one gap to both
  // sides makes the division exact rather than off-by-one at the last column.
  // Rounded before flooring: sub-pixel track widths make the exact quotient
  // land a hair under the whole number it should be (6.0 arrives as 5.998).
  const exact = (contentWidthPx + gap) / (tileWidthPx + gap);
  return Math.max(1, Math.floor(Math.round(exact * 1000) / 1000));
}

/** How many rows `itemCount` items occupy at this column count. */
export function rowCountFor(itemCount: number, columns: number): number {
  if (itemCount <= 0) return 0;
  return Math.ceil(itemCount / Math.max(1, columns));
}

/** The height the grid must claim so the page scrolls the right distance. */
export function totalHeightFor(rowCount: number, metrics: GridMetrics): number {
  if (rowCount <= 0) return 0;
  return rowCount * metrics.rowHeightPx + (rowCount - 1) * metrics.rowGapPx;
}

/** Clamp a row index into `[0, rowCount]`. */
function clampRow(row: number, rowCount: number): number {
  if (!Number.isFinite(row)) return 0;
  return Math.min(rowCount, Math.max(0, Math.trunc(row)));
}

/** Turn a `[startRow, endRow)` row range into an index segment. */
function rowsToSegment(
  startRow: number,
  endRow: number,
  columns: number,
  itemCount: number,
): IndexSegment | null {
  if (endRow <= startRow) return null;
  const start = Math.min(itemCount, startRow * columns);
  const end = Math.min(itemCount, endRow * columns);
  return end > start ? [start, end] : null;
}

/** Merge overlapping or touching segments so nothing is rendered twice. */
function mergeSegments(segments: readonly IndexSegment[]): IndexSegment[] {
  const sorted = [...segments].sort((a, b) => a[0] - b[0]);
  const out: IndexSegment[] = [];
  for (const segment of sorted) {
    const last = out[out.length - 1];
    if (last && segment[0] <= last[1]) {
      out[out.length - 1] = [last[0], Math.max(last[1], segment[1])];
    } else {
      out.push(segment);
    }
  }
  return out;
}

export interface PlanInput {
  /** How many items the CURRENT query matched — the whole result list. */
  readonly itemCount: number;
  /** What the laid-out grid reported, or the fallback. */
  readonly metrics: GridMetrics;
  /** How far the grid's own top has scrolled past the viewport's top, in px. */
  readonly scrollTopPx: number;
  /** The visible height to fill, in px. */
  readonly viewportPx: number;
  /**
   * Index of the item holding keyboard focus, or null. Its row and one row
   * either side stay rendered wherever the user scrolls.
   */
  readonly focusIndex?: number | null;
  /** Rows of margin above and below. Defaults to the configured overscan. */
  readonly overscanRows?: number;
}

/**
 * Decide what to render for one frame.
 *
 * The invariant that matters, and the one the guard test pins: `renderedCount`
 * is bounded by the VIEWPORT (`viewportPx / rowPitch + overscan + focus keep`),
 * so growing the pool from 5,651 to 32,276 cards changes `rowCount` and
 * `totalHeightPx` and leaves `renderedCount` alone.
 */
export function planRender(input: PlanInput): RenderPlan {
  const { itemCount, metrics, scrollTopPx, viewportPx } = input;
  const overscanRows = input.overscanRows ?? CARD_GRID_OVERSCAN_ROWS;
  const columns = Math.max(1, metrics.columns);
  const rowCount = rowCountFor(itemCount, columns);
  const pitch = Math.max(1, rowPitchPx(metrics));
  const totalHeightPx = totalHeightFor(rowCount, metrics);

  if (rowCount === 0) {
    return {
      segments: [],
      renderedCount: 0,
      rowCount: 0,
      totalHeightPx: 0,
      rowHeightPx: metrics.rowHeightPx,
      columns,
      originRow: 0,
      paddingTopPx: 0,
      paddingBottomPx: 0,
    };
  }

  const unmeasured = !metrics.measured || viewportPx <= 0;

  let startRow: number;
  let endRow: number;
  if (unmeasured) {
    // Before a layout exists there is no scroll position to honour and no
    // viewport height to fill: render a fixed, pool-independent first screenful
    // and let the layout effect correct it in the same frame.
    //
    // Overscan is deliberately NOT added here. `CARD_GRID_INITIAL_ROWS` IS the
    // first paint's budget; adding a margin on top would make the constant mean
    // eight rows while saying six, and the node-count guard reads the constant.
    startRow = 0;
    endRow = clampRow(CARD_GRID_INITIAL_ROWS, rowCount);
  } else {
    const firstRow = Math.floor(Math.max(0, scrollTopPx) / pitch);
    const lastRow = Math.floor((Math.max(0, scrollTopPx) + Math.max(0, viewportPx)) / pitch);
    // ⚠️ NEVER LEAVE THE GRID EMPTY. Clamping both edges to `rowCount` — which
    // is what this did — renders ZERO rows for any scroll offset past the end of
    // the list, and the result is a blank grid under a full-height runway: the
    // page looks hung, with a scrollbar promising content that is not drawn.
    // It is reachable in the app, not only in a test: a result set shrinking
    // under an active scroll (type into the search box while scrolled down), a
    // restored scroll position from before a filter, and touch momentum all put
    // the offset past the new end for at least a frame. So the window is pinned
    // to at least the final row instead.
    startRow = Math.min(clampRow(firstRow - overscanRows, rowCount), Math.max(0, rowCount - 1));
    endRow = Math.max(clampRow(lastRow + 1 + overscanRows, rowCount), startRow + 1);
  }

  const segments: IndexSegment[] = [];
  const visible = rowsToSegment(startRow, endRow, columns, itemCount);
  if (visible) segments.push(visible);

  const focusIndex = input.focusIndex ?? null;
  if (focusIndex !== null && focusIndex >= 0 && focusIndex < itemCount) {
    const focusRow = Math.floor(focusIndex / columns);
    const keptStart = clampRow(focusRow - CARD_GRID_FOCUS_KEEP_ROWS, rowCount);
    const keptEnd = clampRow(focusRow + CARD_GRID_FOCUS_KEEP_ROWS + 1, rowCount);
    const kept = rowsToSegment(keptStart, keptEnd, columns, itemCount);
    if (kept) segments.push(kept);
  }

  const merged = mergeSegments(segments);
  const renderedCount = merged.reduce((sum, [start, end]) => sum + (end - start), 0);
  // The rows the window actually spans, which is what the padding stands in for.
  // Read off the MERGED segments, not off `startRow`/`lastRow` above: with a
  // focus anchor the rendered span can begin above the visible one and end
  // below it, and padding sized from the visible rows alone would misplace the
  // whole grid by the difference.
  const originRow = merged.length > 0 ? Math.floor(merged[0]![0] / columns) : 0;
  const lastRenderedRow =
    merged.length > 0 ? Math.floor((merged[merged.length - 1]![1] - 1) / columns) : originRow;
  const paddingTopPx = originRow * pitch;
  const paddingBottomPx = Math.max(0, rowCount - 1 - lastRenderedRow) * pitch;
  return {
    segments: merged,
    renderedCount,
    rowCount,
    totalHeightPx,
    rowHeightPx: metrics.rowHeightPx,
    columns,
    originRow,
    paddingTopPx,
    paddingBottomPx,
  };
}

/** Expand a plan's segments into the concrete indices to render, in order. */
export function planIndices(plan: RenderPlan): number[] {
  const out: number[] = [];
  for (const [start, end] of plan.segments) {
    for (let index = start; index < end; index++) out.push(index);
  }
  return out;
}

/** Two plans render the same thing when their segments match exactly. */
export function samePlan(a: RenderPlan, b: RenderPlan): boolean {
  if (a.rowCount !== b.rowCount) return false;
  if (a.totalHeightPx !== b.totalHeightPx) return false;
  if (a.rowHeightPx !== b.rowHeightPx) return false;
  if (a.columns !== b.columns) return false;
  if (a.originRow !== b.originRow) return false;
  if (a.paddingTopPx !== b.paddingTopPx) return false;
  if (a.paddingBottomPx !== b.paddingBottomPx) return false;
  if (a.segments.length !== b.segments.length) return false;
  return a.segments.every(
    (segment, i) => segment[0] === b.segments[i]?.[0] && segment[1] === b.segments[i]?.[1],
  );
}
