import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { CardTile } from './CardTile.js';
import { registerStateSection } from '../lib/bugreport/state-dump.js';
import {
  FALLBACK_GRID_METRICS,
  cardGridMetricsAreMeasured,
  gridMetricsFrom,
  parseGridColumns,
  planIndices,
  planRender,
  rowPitchPx,
  samePlan,
  type GridMetrics,
  type RenderPlan,
} from '../lib/grid-virtual.js';
import { CARD_GRID_MEASURE_SAMPLE } from '../lib/card-grid-config.js';
import './card-grid.css';

interface CardGridProps {
  cards: readonly NormalizedCard[];
  onSelect: (card: NormalizedCard) => void;
  /** Optional per-card deck-control factory (deck-builder context). */
  deckControls?: (card: NormalizedCard) => {
    count: number;
    canAdd: boolean;
    onAdd: (card: NormalizedCard) => void;
    onRemove: (card: NormalizedCard) => void;
  };
}

/**
 * Responsive grid of {@link CardTile}s — **virtualised**: it renders the rows
 * near the viewport, not the pool.
 *
 * ## Why (§ the card browser was the slowest thing in the app)
 *
 * Caleb: *"jonny boi is running really slow on cards and deck builder tabs"*,
 * and on being told the grid rendered every card: *"ew thats awful"*. It did:
 * this component mapped the entire result list to tiles, so the app's LANDING
 * VIEW built 5,651 tiles — ~5 MB of DOM after §3.146's inline-`all` fix took it
 * down from 42 MB — and fired one lazy cross-origin Scryfall image request per
 * tile. That is also why `verify-bug-reporter.mjs` carries a 90 s
 * `LAUNCHER_WAIT_MS`: the Cards view is the app's worst case and the harness had
 * to wait for it.
 *
 * The pool is being grown toward the 32,276-card corpus. A renders-everything
 * grid does not get slower at that size, it stops working — so the fix had to
 * scale with the pool rather than be tuned for 5,651. What is rendered here is
 * a function of the VIEWPORT; `card-grid-virtual.test.ts` pins that by
 * rendering a 20,000-card pool and a 5,000-card pool and requiring the same
 * number of tiles out of both.
 *
 * ## What is NOT virtualised, deliberately
 *
 * The QUERY. `queryCards` still runs over the whole pool in `CardsView` and
 * `DeckBuilderView`, and this component receives the complete result list and
 * only chooses which part of it to draw. Searching, filtering and sorting
 * therefore still reach every card, including the ones with no element on the
 * page — the same guard test proves it by finding a card that lives at index
 * 19,000 of a 20,000-card pool through the search box.
 *
 * ## Measured, not assumed
 *
 * Column count, row height and gap come from the browser's own resolved values
 * for THIS grid, so `styles.css` stays the single source of truth for the
 * layout and the phone media query needs no counterpart here. The documented
 * fallbacks in `card-grid-config.ts` are used only where there is nothing to
 * measure — the first paint, a server render, a DOM-free test — and the bug
 * report's state dump prints which of the two is in force, so a fallback that
 * fires is never silent.
 *
 * ## Focus survives scrolling
 *
 * A virtualiser that unmounts the focused tile hands focus back to `<body>` and
 * the next Tab restarts at the top of the page. The row holding focus, plus one
 * row either side, is kept rendered wherever the user scrolls (see
 * `CARD_GRID_FOCUS_KEEP_ROWS`), which is why `planRender` returns SEGMENTS.
 */
export function CardGrid({ cards, onSelect, deckControls }: CardGridProps): ReactElement {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [metrics, setMetrics] = useState<GridMetrics>(FALLBACK_GRID_METRICS);
  const [plan, setPlan] = useState<RenderPlan>(() =>
    planRender({
      itemCount: cards.length,
      metrics: FALLBACK_GRID_METRICS,
      scrollTopPx: 0,
      viewportPx: 0,
    }),
  );

  // The live result count, read by the scroll handler without re-subscribing it
  // on every query change.
  const countRef = useRef(cards.length);
  countRef.current = cards.length;
  // What the state dump reports. A ref so the registered section closure always
  // sees the current frame rather than the one it was created in.
  const debugRef = useRef({ plan, metrics, scrollTopPx: 0, viewportPx: 0, focusIndex: null as number | null });

  /**
   * Read the grid's real geometry and decide what to render. The ONE place that
   * touches layout, so a selector or CSS change breaks one function rather than
   * every number that depends on it.
   */
  const sync = useCallback(() => {
    const grid = gridRef.current;
    if (!grid || typeof window === 'undefined') return;

    const style = window.getComputedStyle(grid);
    const columns = parseGridColumns(style.gridTemplateColumns);
    const rowGapPx = Number.parseFloat(style.rowGap);
    // The MAX of a sample, not the first tile: one tile that happens to be a
    // pixel taller than the track would spill into the row below it, and the
    // symptom (tiles overlapping at one scroll position) is exactly the kind of
    // thing that is dismissed as a rendering glitch.
    const tiles = grid.querySelectorAll('.card-tile');
    let rowHeightPx = 0;
    for (let i = 0; i < Math.min(tiles.length, CARD_GRID_MEASURE_SAMPLE); i++) {
      rowHeightPx = Math.max(rowHeightPx, tiles[i]!.getBoundingClientRect().height);
    }
    const nextMetrics =
      columns === null
        ? FALLBACK_GRID_METRICS
        : gridMetricsFrom({
            columns,
            rowHeightPx,
            rowGapPx: Number.isFinite(rowGapPx) ? rowGapPx : 0,
          });

    // The page is the scroller (the grid sits in normal flow, under a sticky
    // header, beside the deck builder's sticky panel), so "how far has the grid
    // scrolled past the top of the window" is exactly `-rect.top`.
    const rect = grid.getBoundingClientRect();
    const scrollTopPx = Math.max(0, -rect.top);
    const viewportPx = window.innerHeight;

    // Whoever holds focus is read back from the DOM rather than tracked in
    // state: the DOM already knows, and a second copy would be a second answer
    // to one question that could disagree after a re-query.
    const active = document.activeElement;
    const cell =
      active instanceof HTMLElement && grid.contains(active)
        ? active.closest<HTMLElement>('[data-card-index]')
        : null;
    const parsedFocus = cell ? Number.parseInt(cell.dataset.cardIndex ?? '', 10) : Number.NaN;
    const focusIndex = Number.isFinite(parsedFocus) ? parsedFocus : null;

    const nextPlan = planRender({
      itemCount: countRef.current,
      metrics: nextMetrics,
      scrollTopPx,
      viewportPx,
      focusIndex,
    });

    debugRef.current = { plan: nextPlan, metrics: nextMetrics, scrollTopPx, viewportPx, focusIndex };
    setMetrics((prev) =>
      prev.columns === nextMetrics.columns &&
      prev.rowHeightPx === nextMetrics.rowHeightPx &&
      prev.rowGapPx === nextMetrics.rowGapPx &&
      prev.measured === nextMetrics.measured
        ? prev
        : nextMetrics,
    );
    // Only re-render when the WINDOW moves. Scrolling fires continuously and a
    // setState per pixel would spend the frame budget this change exists to
    // save; most scroll events leave the plan identical.
    setPlan((prev) => (samePlan(prev, nextPlan) ? prev : nextPlan));
  }, []);

  // Measure before the browser paints, so the first frame's fallback metrics are
  // corrected without a visible reflow. Re-runs when the query changes the list.
  useLayoutEffect(() => {
    sync();
  }, [sync, cards]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // rAF-coalesced: scroll and resize both fire faster than the screen draws,
    // and doing the layout reads once per frame is the point.
    let frame = 0;
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    // Focus moving in or out changes which rows must stay mounted.
    const grid = gridRef.current;
    grid?.addEventListener('focusin', schedule);
    grid?.addEventListener('focusout', schedule);
    // The grid's own width changes without a window resize — the deck panel, a
    // scrollbar appearing, a rotation — and the column count changes with it.
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (observer && grid) observer.observe(grid);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      grid?.removeEventListener('focusin', schedule);
      grid?.removeEventListener('focusout', schedule);
      observer?.disconnect();
    };
  }, [sync]);

  /**
   * Rule 3's debug seam: the grid is observable at runtime through the shared
   * registry the bug reporter already reads, not a key binding of its own. It
   * is also where a fallback ANNOUNCES itself — "metrics fallback (unmeasured)"
   * in a report is the difference between a five-minute diagnosis and a week.
   */
  useEffect(() => {
    return registerStateSection('card_grid', () => {
      const { plan: p, metrics: m, scrollTopPx, viewportPx, focusIndex } = debugRef.current;
      return [
        `results ${countRef.current}`,
        `rendered ${p.renderedCount} tiles in ${p.segments.length} segment(s)`,
        `segments ${p.segments.map(([s, e]) => `[${s},${e})`).join(' ') || '(none)'}`,
        `rows ${p.rowCount} of ${Math.round(p.totalHeightPx)}px`,
        `metrics ${cardGridMetricsAreMeasured(m) ? 'measured' : 'FALLBACK (unmeasured)'}`,
        `columns ${m.columns} row_height ${Math.round(m.rowHeightPx)}px gap ${Math.round(m.rowGapPx)}px pitch ${Math.round(rowPitchPx(m))}px`,
        `scroll_top ${Math.round(scrollTopPx)}px viewport ${Math.round(viewportPx)}px`,
        `focus_anchor ${focusIndex === null ? 'none' : focusIndex}`,
      ].join('\n');
    });
  }, []);

  if (cards.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__title">No cards match.</div>
        <p>Try clearing the search or loosening the color and type filters.</p>
      </div>
    );
  }

  const columns = Math.max(1, metrics.columns);
  // Clamped against the CURRENT list: a re-query shrinks `cards` in the same
  // render that still carries the previous frame's plan (the layout effect
  // corrects it before paint), and an index past the end must not be a crash.
  const indices = planIndices(plan).filter((index) => index < cards.length);

  return (
    <div
      ref={gridRef}
      className="card-grid card-grid--virtual"
      style={{
        height: plan.totalHeightPx > 0 ? `${plan.totalHeightPx}px` : undefined,
        gridAutoRows: `${plan.rowHeightPx}px`,
      }}
    >
      {indices.map((index) => {
        const card = cards[index]!;
        return (
          <div
            key={card.id}
            className="card-grid__cell"
            data-card-index={index}
            // Row placement only — the COLUMN is left to the grid's own
            // auto-placement. Pinning the column too would mean trusting the
            // measured column count to be exactly right, and a stale one would
            // create an implicit extra column and shove the grid sideways;
            // letting the browser place within the row degrades to "a few too
            // many or too few tiles rendered" instead.
            style={{ gridRowStart: Math.floor(index / columns) + 1 }}
          >
            <CardTile
              card={card}
              onSelect={onSelect}
              deck={deckControls ? deckControls(card) : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}
