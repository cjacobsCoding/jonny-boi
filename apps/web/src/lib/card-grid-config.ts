/**
 * Named configuration for the VIRTUALISED card grid (CLAUDE.md rule 1: no
 * magic numbers; rule 2: the behaviour that varies lives in named data).
 *
 * A module of its own rather than more rows in `lib/config.ts`, matching the
 * pattern the app already uses for a self-contained system's tunables
 * (`lib/lab-config.ts`, `lib/replay-config.ts`, `components/card-hover-config.ts`).
 *
 * ## The one thing NOT configured here: the grid's shape
 *
 * Column count, tile height and gap are deliberately absent. They are decided by
 * `styles.css` — `repeat(auto-fill, minmax(180px, 1fr))`, narrowing to 140px
 * under the phone media query — and the virtualiser MEASURES what the browser
 * resolved instead of keeping a second copy of those numbers here. Two places
 * answering "how wide is a column?" would eventually disagree, and the grid
 * would render the wrong window with no test able to see it (rule 12).
 *
 * The fallbacks below are the exception, and they are honest about being one:
 * they are used only where there is no layout to measure — server rendering, a
 * unit test with no DOM, the very first paint before a layout effect has run —
 * and every one of them is replaced by a real measurement as soon as one
 * exists. `cardGridMetricsAreMeasured` in `grid-virtual.ts` reports which of the
 * two a live grid is using, and the bug-report state dump prints it, so a
 * fallback that fires is never silent (DESIGN.md: robust, but never quiet).
 */

/**
 * Rows rendered above and below the visible band.
 *
 * Two, not zero: one row absorbs a single wheel notch arriving between a scroll
 * event and the next paint, and the second covers a fling on a phone. More rows
 * buy diminishing smoothness for a linear cost in nodes, which is the entire
 * thing this system exists to bound.
 */
export const CARD_GRID_OVERSCAN_ROWS = 2;

/**
 * Rows kept rendered on each side of the row holding keyboard focus, when that
 * row has scrolled out of the visible band.
 *
 * Without this, wheel-scrolling away from a focused tile unmounts the focused
 * element, the browser resets focus to `<body>`, and the next Tab restarts at
 * the top of the document — a virtualised grid that loses your place is worse
 * than a slow one. One row on each side is what makes Tab and Shift+Tab from
 * the focused tile land on a real neighbour, whose own `focus()` then scrolls
 * the visible band back to it.
 */
export const CARD_GRID_FOCUS_KEEP_ROWS = 1;

/**
 * How many rows the FIRST paint renders, before any layout exists to measure.
 *
 * This is the number that makes the first frame cheap no matter how large the
 * pool is, and it is what `renderToStaticMarkup` produces in the unit suite —
 * which is why the node-count guard can be a plain, DOM-free test. Six rows
 * covers a 1280x800 window's worth of 180px tiles with room to spare; the
 * layout effect corrects it within the first frame.
 */
export const CARD_GRID_INITIAL_ROWS = 6;

/**
 * Column count assumed only where no grid has been laid out yet.
 *
 * Chosen to over-render rather than under-render: a first paint with more
 * columns than the window really has shows a full screen and then settles,
 * whereas one with too few shows a half-empty screen for a frame. Six is
 * `1280px / 180px` rounded down, the widest case the desktop CSS produces at
 * the window this app is used in.
 */
export const CARD_GRID_FALLBACK_COLUMNS = 6;

/**
 * Row pitch assumed only where no grid has been laid out yet, in px — a tile's
 * height plus the grid gap. Measured once on a 1280x800 desktop window (a
 * 186px-wide tile: 259px of art plus a 61px body, over a 16px `--space-4` gap)
 * and used purely to size the scroll runway for the frame before the real
 * measurement lands.
 */
export const CARD_GRID_FALLBACK_ROW_PITCH_PX = 336;

/**
 * How many rendered tiles are measured to decide the row track height.
 *
 * The MAX of a sample rather than the first tile's height: every tile in one
 * grid is built from the same template, but a tile a pixel taller than the
 * pinned track spills into the row beneath it, and "some cards overlap at one
 * scroll position" is the kind of symptom that gets written off as a rendering
 * glitch. Eight is more than a row on any viewport this app runs at, and the
 * measurement happens once per layout pass, not per frame.
 */
export const CARD_GRID_MEASURE_SAMPLE = 8;

/**
 * A measured row pitch below this is not believable — a collapsed, hidden or
 * not-yet-laid-out tile reports single-digit heights, and dividing a scroll
 * offset by one of those asks the grid to render tens of thousands of rows.
 * Below this the fallback pitch is used and the metrics report themselves as
 * unmeasured.
 */
export const CARD_GRID_MIN_BELIEVABLE_ROW_PITCH_PX = 40;
