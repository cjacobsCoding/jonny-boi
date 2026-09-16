/**
 * The virtualiser's arithmetic — the half of the card grid that can be reasoned
 * about without a browser.
 *
 * `card-grid-virtual.test.ts` pins the FIRST PAINT through the real component;
 * this file pins the scrolled, measured, focused cases that `renderToStaticMarkup`
 * cannot reach because it has no layout. Between them they cover the invariant
 * the whole change rests on: **what gets rendered is a function of the viewport,
 * never of the pool size.**
 */
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_GRID_METRICS,
  cardGridMetricsAreMeasured,
  gridMetricsFrom,
  tileShapeIsBelievable,
  deriveColumnCount,
  planIndices,
  planRender,
  rowCountFor,
  rowPitchPx,
  samePlan,
  totalHeightFor,
  type GridMetrics,
} from './grid-virtual.js';
import {
  CARD_GRID_FALLBACK_COLUMNS,
  CARD_GRID_FOCUS_KEEP_ROWS,
  CARD_GRID_INITIAL_ROWS,
  CARD_GRID_MIN_BELIEVABLE_ROW_PITCH_PX,
  CARD_GRID_MIN_TILE_ASPECT,
  CARD_GRID_OVERSCAN_ROWS,
} from './card-grid-config.js';

/** A believable desktop measurement: 6 columns of 320px tiles over a 16px gap. */
const DESKTOP: GridMetrics = gridMetricsFrom({
  columns: 6,
  rowHeightPx: 320,
  rowGapPx: 16,
  tileWidthPx: 186,
});

describe('the measurement gate is CLOSED — an unbelievable metric reports, never widens', () => {
  it('accepts a real measurement and says it is measured', () => {
    expect(cardGridMetricsAreMeasured(DESKTOP)).toBe(true);
    expect(DESKTOP.columns).toBe(6);
    expect(rowPitchPx(DESKTOP)).toBe(336);
  });

  it('refuses a collapsed tile, and says it fell back', () => {
    // A tile that has not been laid out reports single-digit heights. Divide a
    // scroll offset by that and the grid is asked for tens of thousands of rows
    // — the unbounded render this system exists to prevent, arriving through
    // the back door.
    const collapsed = gridMetricsFrom({ columns: 6, rowHeightPx: 2, rowGapPx: 0, tileWidthPx: 186 });
    expect(cardGridMetricsAreMeasured(collapsed)).toBe(false);
    expect(collapsed).toEqual(FALLBACK_GRID_METRICS);
    // Pinned against the named threshold, so moving the constant moves the test.
    const justUnder = gridMetricsFrom({
      columns: 6,
      rowHeightPx: CARD_GRID_MIN_BELIEVABLE_ROW_PITCH_PX - 1,
      rowGapPx: 0,
      // Narrow enough that the PITCH floor is the thing being tested here, not
      // the tile-shape rule below it.
      tileWidthPx: 1,
    });
    expect(cardGridMetricsAreMeasured(justUnder)).toBe(false);
    const justOver = gridMetricsFrom({
      columns: 6,
      rowHeightPx: CARD_GRID_MIN_BELIEVABLE_ROW_PITCH_PX,
      rowGapPx: 0,
      tileWidthPx: 1,
    });
    expect(cardGridMetricsAreMeasured(justOver)).toBe(true);
  });

  it('refuses a zero or nonsense column count', () => {
    expect(cardGridMetricsAreMeasured(gridMetricsFrom({ columns: 0, rowHeightPx: 320, rowGapPx: 16, tileWidthPx: 186 }))).toBe(false);
    expect(cardGridMetricsAreMeasured(gridMetricsFrom({ columns: Number.NaN, rowHeightPx: 320, rowGapPx: 16, tileWidthPx: 186 }))).toBe(false);
  });
});

describe('a tile that has not laid out is refused — the React #185 loop', () => {
  /*
   * THE DEFECT. `.card-tile__art-btn` is a <button>, which is shrink-to-fit
   * sized whatever its `display` says. Its only content was an `<img>` with no
   * intrinsic width until it loaded, so a COLD tile's art box was 0 wide, its
   * `aspect-ratio: 488 / 680` made it 0 TALL, and the tile measured its body
   * alone: 94px at 192px wide.
   *
   * Nothing above caught that. 94 + 16 is far over the 40px pitch floor, so the
   * grid pinned a 94px row track — and `planRender` divides the viewport by that
   * pitch, so the window went from 5 rows to 10, mounting thirty more cold tiles
   * that also measured 94px. The measurement chose what to measure. Each hop was
   * a setState from a layout effect; React unmounted the app at fifty, and it
   * took about fifteen searches to get there.
   *
   * The numbers below are the ones actually read out of Chrome on 2026-09-15.
   */
  const COLD_TILE_HEIGHT_PX = 94;
  const LAID_OUT_TILE_HEIGHT_PX = 358.75;
  const TILE_WIDTH_PX = 192;

  it('the 94px-at-192px reading that crashed the browser is not believed', () => {
    const cold = gridMetricsFrom({
      columns: 6,
      rowHeightPx: COLD_TILE_HEIGHT_PX,
      rowGapPx: 16,
      tileWidthPx: TILE_WIDTH_PX,
    });
    expect(cardGridMetricsAreMeasured(cold)).toBe(false);
    expect(cold).toEqual(FALLBACK_GRID_METRICS);
    // And it is NOT the pitch floor that catches it — that floor passes this
    // reading. Without the shape rule the check could not fail.
    expect(COLD_TILE_HEIGHT_PX + 16).toBeGreaterThan(CARD_GRID_MIN_BELIEVABLE_ROW_PITCH_PX);
  });

  it('the same tile once it HAS laid out is believed', () => {
    const warm = gridMetricsFrom({
      columns: 6,
      rowHeightPx: LAID_OUT_TILE_HEIGHT_PX,
      rowGapPx: 16,
      tileWidthPx: TILE_WIDTH_PX,
    });
    expect(cardGridMetricsAreMeasured(warm)).toBe(true);
    expect(warm.rowHeightPx).toBe(LAID_OUT_TILE_HEIGHT_PX);
  });

  it('the rule is the named ratio, so moving the constant moves the test', () => {
    const width = 200;
    expect(tileShapeIsBelievable(width * CARD_GRID_MIN_TILE_ASPECT, width)).toBe(true);
    expect(tileShapeIsBelievable(width * CARD_GRID_MIN_TILE_ASPECT - 0.01, width)).toBe(false);
  });

  it('a phone column is still portrait, so the rule does not fire on a real phone', () => {
    // 375px / 2 columns of 140px-min tracks: a ~165px tile, art 165 x 680/488
    // = 230, plus a ~92px body. Narrower than desktop and still far past 1:1.
    const phone = gridMetricsFrom({ columns: 2, rowHeightPx: 322, rowGapPx: 12, tileWidthPx: 165 });
    expect(cardGridMetricsAreMeasured(phone)).toBe(true);
  });

  it('no width to offer is not a failed measurement — DOM-free callers still work', () => {
    // Answering false here would make every server render and every test a
    // permanent fallback, which is a different bug wearing this fix's clothes.
    expect(tileShapeIsBelievable(320, 0)).toBe(true);
    expect(tileShapeIsBelievable(320, Number.NaN)).toBe(true);
  });

  it('THE LOOP ITSELF: a cold reading must not widen the window', () => {
    // The mechanism, in one assertion. Feed planRender the cold pitch and the
    // laid-out pitch at the same viewport and the cold one renders strictly
    // more rows — that is the feedback edge. Because the cold metrics are
    // refused above, the grid never plans from them.
    const viewportPx = 800;
    const cold = gridMetricsFrom({
      columns: 6,
      rowHeightPx: COLD_TILE_HEIGHT_PX,
      rowGapPx: 16,
      tileWidthPx: TILE_WIDTH_PX,
    });
    const warm = gridMetricsFrom({
      columns: 6,
      rowHeightPx: LAID_OUT_TILE_HEIGHT_PX,
      rowGapPx: 16,
      tileWidthPx: TILE_WIDTH_PX,
    });
    const rendered = (metrics: GridMetrics): number =>
      planRender({ itemCount: 5_651, metrics, scrollTopPx: 0, viewportPx }).renderedCount;
    // If the cold metrics had been believed, the raw pitch would have rendered
    // twice the tiles. Shown explicitly so the claim is not taken on trust.
    const unguarded = planRender({
      itemCount: 5_651,
      metrics: { columns: 6, rowHeightPx: COLD_TILE_HEIGHT_PX, rowGapPx: 16, measured: true },
      scrollTopPx: 0,
      viewportPx,
    });
    expect(unguarded.renderedCount).toBeGreaterThan(rendered(warm));
    // Guarded, the cold reading is the fallback, which renders a first
    // screenful — never a window sized from a collapsed tile.
    expect(cardGridMetricsAreMeasured(cold)).toBe(false);
    expect(rendered(cold)).toBeLessThan(unguarded.renderedCount);
  });
});

describe('deriving the column count from what was laid out', () => {
  it('counts the columns that fit a real desktop grid', () => {
    // 1233px of content, 192px tiles, 16px gap -> exactly 6.
    expect(deriveColumnCount(1233, 192, 16)).toBe(6);
  });

  it('counts the columns that fit a real phone grid', () => {
    // 343px of content, 165.5px tiles, 12px gap -> 2.
    expect(deriveColumnCount(343, 165.5, 12)).toBe(2);
  });

  it('RECOVERS from a grid that is currently laid out with too many columns', () => {
    // The trap this replaced `parseGridColumns` for. Six items were placed in a
    // row on a phone that declares two, so CSS Grid invented four implicit
    // columns — and `getComputedStyle` reports implicit tracks as though they
    // were declared, so reading the count back gave six again, forever.
    // A tile's WIDTH comes from the explicit 1fr track it sits in, so the two
    // real tiles still measure ~165px while the surplus collapse to nothing,
    // and the widest tile still says how wide a column really is.
    const widestRealTile = 165.5;
    expect(deriveColumnCount(343, widestRealTile, 12)).toBe(2);
  });

  it('never returns zero, so a row can always hold something', () => {
    // A container narrower than one tile still has one column; `auto-fill` with
    // a `minmax(180px, …)` floor overflows rather than producing none.
    expect(deriveColumnCount(100, 192, 16)).toBe(1);
  });

  it('refuses to answer when there is nothing real to measure', () => {
    expect(deriveColumnCount(0, 192, 16)).toBeNull();
    expect(deriveColumnCount(1233, 0, 16)).toBeNull();
    expect(deriveColumnCount(Number.NaN, 192, 16)).toBeNull();
    expect(deriveColumnCount(1233, Number.NaN, 16)).toBeNull();
  });

  it('survives sub-pixel track widths rather than losing a column to them', () => {
    // Fractional device ratios make the exact quotient land a hair under the
    // whole number it should be; flooring that raw would drop a whole column
    // and leave a visibly empty strip down the right of the grid.
    expect(deriveColumnCount(1232.99, 192.0006, 16)).toBe(6);
  });
});

describe('the rendered count is a function of the viewport, not the pool', () => {
  const viewportPx = 800;
  const scrollTopPx = 0;

  it('quadrupling the pool leaves the rendered count untouched', () => {
    const small = planRender({ itemCount: 5_000, metrics: DESKTOP, scrollTopPx, viewportPx });
    const huge = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx, viewportPx });
    expect(small.renderedCount).toBeGreaterThan(0);
    expect(huge.renderedCount).toBe(small.renderedCount);
  });

  it('…all the way to the 32,276-card corpus the pool is being grown toward', () => {
    const now = planRender({ itemCount: 5_651, metrics: DESKTOP, scrollTopPx, viewportPx });
    const corpus = planRender({ itemCount: 32_276, metrics: DESKTOP, scrollTopPx, viewportPx });
    expect(corpus.renderedCount).toBe(now.renderedCount);
    // …while the runway grows with it, so the scrollbar keeps telling the truth.
    expect(corpus.rowCount).toBeGreaterThan(now.rowCount * 5);
    expect(corpus.totalHeightPx).toBeGreaterThan(now.totalHeightPx * 5);
  });

  it('a TALLER window renders more — which is what "function of the viewport" means', () => {
    const short = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx, viewportPx: 400 });
    const tall = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx, viewportPx: 1600 });
    expect(tall.renderedCount).toBeGreaterThan(short.renderedCount);
  });

  it('the rendered count is the visible rows plus the configured overscan', () => {
    const plan = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx: 10_000, viewportPx });
    const pitch = rowPitchPx(DESKTOP);
    const firstVisible = Math.floor(10_000 / pitch);
    const lastVisible = Math.floor((10_000 + viewportPx) / pitch);
    const expectedRows = lastVisible - firstVisible + 1 + 2 * CARD_GRID_OVERSCAN_ROWS;
    expect(plan.renderedCount).toBe(expectedRows * DESKTOP.columns);
  });
});

describe('scrolling moves the window and nothing else', () => {
  it('scrolling down renders LATER indices, not more of them', () => {
    const top = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx: 0, viewportPx: 800 });
    const deep = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx: 500_000, viewportPx: 800 });
    // The window at the top is clipped by row 0, so it is legitimately smaller.
    expect(deep.renderedCount).toBeLessThanOrEqual(top.renderedCount + DESKTOP.columns * CARD_GRID_OVERSCAN_ROWS);
    expect(planIndices(deep)[0]).toBeGreaterThan(planIndices(top).at(-1)!);
    expect(deep.rowCount).toBe(top.rowCount);
  });

  it('scrolling past the end clamps rather than running off the list', () => {
    const plan = planRender({ itemCount: 100, metrics: DESKTOP, scrollTopPx: 10_000_000, viewportPx: 800 });
    for (const index of planIndices(plan)) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(100);
    }
  });

  it('a negative scroll offset (rubber-banding) is treated as the top', () => {
    const rubber = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx: -300, viewportPx: 800 });
    const top = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx: 0, viewportPx: 800 });
    expect(samePlan(rubber, top)).toBe(true);
  });

  it('the last row is partial and the plan stops at the real item count', () => {
    // 20,003 cards in 6 columns: the final row holds three.
    const plan = planRender({ itemCount: 20_003, metrics: DESKTOP, scrollTopPx: 10_000_000, viewportPx: 800 });
    expect(plan.rowCount).toBe(rowCountFor(20_003, 6));
    expect(planIndices(plan).at(-1)).toBe(20_002);
  });
});

describe('keyboard focus survives a scroll away from it', () => {
  const far = { itemCount: 20_000, metrics: DESKTOP, scrollTopPx: 500_000, viewportPx: 800 };

  it('the focused row is kept rendered even when the viewport is elsewhere', () => {
    const anchored = planRender({ ...far, focusIndex: 12 });
    expect(planIndices(anchored)).toContain(12);
    // …and it arrives as a SECOND segment, not by rendering the gap between.
    expect(anchored.segments.length).toBe(2);
  });

  it('keeping it costs a bounded handful of tiles, not the gap', () => {
    const plain = planRender(far);
    const anchored = planRender({ ...far, focusIndex: 12 });
    const keptRows = 1 + 2 * CARD_GRID_FOCUS_KEEP_ROWS;
    expect(anchored.renderedCount).toBe(plain.renderedCount + keptRows * DESKTOP.columns);
    // The failure mode this exists to prevent: widening ONE range to cover both
    // would render every row in between — tens of thousands of tiles.
    expect(anchored.renderedCount).toBeLessThan(plain.renderedCount * 2);
  });

  it('a neighbour to Tab to in both directions is rendered with it', () => {
    const anchored = planRender({ ...far, focusIndex: 600 });
    const indices = planIndices(anchored);
    expect(indices).toContain(600 - DESKTOP.columns); // the row above
    expect(indices).toContain(600 + DESKTOP.columns); // the row below
  });

  it('a focus already inside the visible window adds nothing', () => {
    const plan = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx: 0, viewportPx: 800 });
    const anchored = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx: 0, viewportPx: 800, focusIndex: 3 });
    expect(anchored.segments.length).toBe(1);
    expect(anchored.renderedCount).toBe(plan.renderedCount);
  });

  it('an out-of-range focus index is ignored rather than crashing the plan', () => {
    const plan = planRender({ ...far, focusIndex: 999_999 });
    expect(plan.segments.length).toBe(1);
    expect(planRender({ ...far, focusIndex: -1 }).segments.length).toBe(1);
  });
});

describe('the unmeasured first paint', () => {
  it('renders a fixed screenful whatever the pool size', () => {
    const a = planRender({ itemCount: 5_000, metrics: FALLBACK_GRID_METRICS, scrollTopPx: 0, viewportPx: 0 });
    const b = planRender({ itemCount: 32_276, metrics: FALLBACK_GRID_METRICS, scrollTopPx: 0, viewportPx: 0 });
    expect(a.renderedCount).toBe(CARD_GRID_INITIAL_ROWS * CARD_GRID_FALLBACK_COLUMNS);
    expect(b.renderedCount).toBe(a.renderedCount);
  });

  it('still claims the whole runway, so the scrollbar is not a lie for a frame', () => {
    const plan = planRender({ itemCount: 32_276, metrics: FALLBACK_GRID_METRICS, scrollTopPx: 0, viewportPx: 0 });
    expect(plan.rowCount).toBe(rowCountFor(32_276, CARD_GRID_FALLBACK_COLUMNS));
    expect(plan.totalHeightPx).toBe(totalHeightFor(plan.rowCount, FALLBACK_GRID_METRICS));
  });

  it('a measured grid with a zero-height viewport is treated as unmeasured too', () => {
    // A view mounted in a hidden tab reports `innerHeight` normally but can
    // report a zero band; rendering nothing there would be a blank grid.
    const plan = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx: 0, viewportPx: 0 });
    expect(plan.renderedCount).toBeGreaterThan(0);
  });
});

describe('the padding stands in for the rows that are not rendered', () => {
  const viewportPx = 800;

  it('the geometry adds up to the same total height as the full list', () => {
    // padding-top + the rendered rows + padding-bottom must equal exactly what
    // an un-virtualised grid of this many rows would occupy, or the scrollbar
    // lies and the page jumps under the hand.
    for (const scrollTopPx of [0, 5_000, 250_000, 1_000_000]) {
      const plan = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx, viewportPx });
      const renderedRows = plan.renderedCount / plan.columns;
      const occupied =
        plan.paddingTopPx +
        renderedRows * DESKTOP.rowHeightPx +
        (renderedRows - 1) * DESKTOP.rowGapPx +
        plan.paddingBottomPx;
      expect(Math.round(occupied)).toBe(Math.round(plan.totalHeightPx));
    }
  });

  it('cells are placed RELATIVE to the window, so the track count stays small', () => {
    // The O(pool)-layout trap: placing a cell at its ABSOLUTE row makes the
    // browser materialise an implicit track for every row above it.
    const deep = planRender({ itemCount: 32_276, metrics: DESKTOP, scrollTopPx: 1_500_000, viewportPx });
    const rows = planIndices(deep).map((index) => Math.floor(index / deep.columns) - deep.originRow + 1);
    expect(Math.min(...rows)).toBe(1);
    // A screenful of tracks, not five thousand.
    expect(Math.max(...rows)).toBeLessThan(20);
  });

  it('the plan carries the column count it was computed with', () => {
    const plan = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx: 0, viewportPx });
    expect(plan.columns).toBe(DESKTOP.columns);
    const narrow = gridMetricsFrom({ columns: 2, rowHeightPx: 260, rowGapPx: 12, tileWidthPx: 165 });
    expect(planRender({ itemCount: 20_000, metrics: narrow, scrollTopPx: 0, viewportPx }).columns).toBe(2);
  });

  it('at the very top there is no leading padding, and at the end no trailing', () => {
    const top = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx: 0, viewportPx });
    expect(top.paddingTopPx).toBe(0);
    expect(top.paddingBottomPx).toBeGreaterThan(0);
    const end = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx: 10_000_000, viewportPx });
    expect(end.paddingBottomPx).toBe(0);
    expect(end.paddingTopPx).toBeGreaterThan(0);
  });
});

describe('edges', () => {
  it('an empty list plans nothing and claims no height', () => {
    const plan = planRender({ itemCount: 0, metrics: DESKTOP, scrollTopPx: 0, viewportPx: 800 });
    expect(plan.segments).toEqual([]);
    expect(plan.renderedCount).toBe(0);
    expect(plan.totalHeightPx).toBe(0);
  });

  it('one card is one row, and the height carries no trailing gap', () => {
    expect(rowCountFor(1, 6)).toBe(1);
    expect(totalHeightFor(1, DESKTOP)).toBe(320);
    expect(totalHeightFor(2, DESKTOP)).toBe(320 * 2 + 16);
  });

  it('samePlan distinguishes plans that differ, so the scroll handler can trust it', () => {
    const a = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx: 0, viewportPx: 800 });
    const b = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx: 0, viewportPx: 800 });
    const c = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx: 5_000, viewportPx: 800 });
    expect(samePlan(a, b)).toBe(true);
    expect(samePlan(a, c)).toBe(false);
    // A pool that grew must NOT compare equal, or the grid would keep a stale
    // runway and refuse to scroll to the new cards.
    const grown = planRender({ itemCount: 32_276, metrics: DESKTOP, scrollTopPx: 0, viewportPx: 800 });
    expect(samePlan(a, grown)).toBe(false);
  });

  it('segments never overlap, so no card is rendered twice', () => {
    const plan = planRender({ itemCount: 20_000, metrics: DESKTOP, scrollTopPx: 500_000, viewportPx: 800, focusIndex: 12 });
    const indices = planIndices(plan);
    expect(new Set(indices).size).toBe(indices.length);
    // …and they come out in ascending order, which is what keeps the grid's own
    // auto-placement putting each cell in the column it belongs in.
    expect([...indices].sort((x, y) => x - y)).toEqual(indices);
  });
});
