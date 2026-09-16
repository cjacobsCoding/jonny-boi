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
  deriveColumnCount,
  planIndices,
  planRender,
  rowPitchPx,
  samePlan,
  type GridMetrics,
  type RenderPlan,
} from '../lib/grid-virtual.js';
import './card-grid.css';

/**
 * `useLayoutEffect` in the browser, `useEffect` on the server.
 *
 * The timing genuinely matters here: the first paint is sized from the
 * documented FALLBACK metrics, and correcting it after the browser has painted
 * shows a visible jump on the app's landing view. A layout effect corrects it
 * in the same frame.
 *
 * But React warns about `useLayoutEffect` on every server render, and this grid
 * IS asserted through `renderToStaticMarkup` (`card-grid-virtual.test.ts`) —
 * the same collision `CardFace.tsx` resolved by dropping to `useEffect`, which
 * it could afford because its pop fades in anyway. This one cannot, so it picks
 * the hook instead of the semantics. There is no effect to run on a server
 * render regardless: `sync` returns immediately with no `window`.
 */
const useMeasureEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

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
  // ⚠️ THE MEASURED METRICS ARE NOT STATE, AND THAT IS THE FIX FOR #185.
  //
  // They were, and nothing ever read them: `syncInner` derives the next plan
  // from the measurement it just took, not from a previous render's metrics.
  // The only thing the state did was re-run the layout effect that had just set
  // it, which re-measured a window that had changed BECAUSE it was set, which
  // set it again — a `setState` per hop, every one of them scheduled from
  // inside React's commit phase. React caps nested updates at fifty and
  // unmounts the tree; a handful of searches got there. The measurement now
  // lands in one place, `plan`, and reaches the debug dump through `debugRef`.
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
  // The ResizeObserver, and the tile it is currently watching. See the effect
  // below for why a TILE is watched and not only the grid.
  const observerRef = useRef<ResizeObserver | null>(null);
  // Guards `sync` against re-entering itself. See the focus listeners below.
  const syncingRef = useRef(false);
  const watchedTilesRef = useRef<Set<Element>>(new Set());
  // What the state dump reports. A ref so the registered section closure always
  // sees the current frame rather than the one it was created in.
  const debugRef = useRef({
    plan,
    metrics: FALLBACK_GRID_METRICS as GridMetrics,
    scrollTopPx: 0,
    viewportPx: 0,
    focusIndex: null as number | null,
  });

  /**
   * Read the grid's real geometry and decide what to render. The ONE place that
   * touches layout, so a selector or CSS change breaks one function rather than
   * every number that depends on it.
   */
  const sync = useCallback(() => {
    const grid = gridRef.current;
    if (!grid || typeof window === 'undefined') return;
    // ⚠️ RE-ENTRANCY GUARD, and it is load-bearing.
    //
    // `sync` sets state, which re-renders, which unmounts the tiles that left
    // the window — and unmounting the focused element fires `focusout`
    // SYNCHRONOUSLY, inside React's commit. A focus listener that called `sync`
    // straight back therefore re-entered it mid-commit; the app threw, the tree
    // came down, and the harness found a page with no nav buttons and 94px
    // tiles. One frame of recursion is enough to do that.
    if (syncingRef.current) return;
    syncingRef.current = true;
    try {
      syncInner(grid);
    } finally {
      syncingRef.current = false;
    }
  }, []);

  const syncInner = useCallback((grid: HTMLDivElement) => {
    if (typeof window === 'undefined') return;

    const style = window.getComputedStyle(grid);
    const rowGapPx = Number.parseFloat(style.rowGap);
    const columnGapPx = Number.parseFloat(style.columnGap);
    // The MAX over EVERY rendered tile, not a sample. A sample of eight pinned
    // the row track 3px under the tallest of the thirty on screen, and a track
    // shorter than the tile it holds is how rows start overlapping. There are
    // only ever a screenful of tiles here — that is the entire point of this
    // component — so measuring all of them costs nothing worth saving.
    const tiles = grid.querySelectorAll('.card-tile');
    let rowHeightPx = 0;
    let tileWidthPx = 0;
    for (const tile of tiles) {
      const rect = tile.getBoundingClientRect();
      rowHeightPx = Math.max(rowHeightPx, rect.height);
      tileWidthPx = Math.max(tileWidthPx, rect.width);
    }
    const columns = deriveColumnCount(grid.clientWidth, tileWidthPx, columnGapPx);
    const nextMetrics =
      columns === null
        ? FALLBACK_GRID_METRICS
        : gridMetricsFrom({
            columns,
            rowHeightPx,
            rowGapPx: Number.isFinite(rowGapPx) ? rowGapPx : 0,
            // The width is what lets `gridMetricsFrom` refuse a tile that has
            // not laid out. A card is portrait; a box 192px wide and 94px tall
            // is a tile whose art box collapsed, and pinning the row track to
            // one of those is what fed the update loop that unmounted the app.
            tileWidthPx,
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

    // ⚠️ RE-MEASURE WHEN THE MEASURED THING CHANGES SIZE.
    //
    // The first layout pass after mount reported a tile height of 94px — the
    // body alone, with the art box contributing nothing — and the grid then
    // pinned `grid-auto-rows: 94px` and never looked again, because the metrics
    // had "converged". Tiles are 359px tall, so every row overlapped the two
    // above it: art clipped to a third, names and mana costs hidden. Measured in
    // Chrome: `grid-auto-rows` read 94px at load and 358.75px after a single
    // scroll event, which is exactly the shape of a one-shot measurement taken
    // a frame too early.
    //
    // Watching the TILE closes that hole at the source: whatever makes the first
    // frame's tile short — an art box before its aspect-ratio box is resolved, a
    // font, a decoded image — ends with the tile changing size, and that is the
    // signal to measure again. The grid's own observer cannot see it: the grid's
    // size is dominated by the padding this component sets, so it changes for
    // reasons that have nothing to do with how tall a tile is.
    //
    // ⚠️ THERE IS A LOOP, AND THIS COMMENT USED TO DENY IT. It said: "a tile's
    // height is its own content, never the row track we pin from it, so
    // re-measuring cannot move what is being measured." The first half is true
    // and the conclusion does not follow. Re-measuring does not change a given
    // tile's height — it changes WHICH TILES EXIST, because the pitch measured
    // here is what `planRender` divides the viewport by. Halve the measured
    // height and the window doubles; the new tiles are cold, measure short too,
    // and the next pass reads a different number again.
    //
    // Two things stop it, and they are deliberately at different levels:
    //   1. the reading itself is now refused when it cannot be a laid-out tile
    //      (`gridMetricsFrom` takes the width), and the CSS that produced the
    //      94px reading is fixed at source (`.card-tile__art-btn` has a width);
    //   2. re-measuring is never SYNCHRONOUS with the commit that caused it —
    //      see the layout effect below. A cycle that turns once per frame
    //      converges visibly; one that turns inside React's commit phase hits
    //      the nested-update limit and takes the app down.
    // EVERY rendered tile, not just the first one. The row track is pinned to
    // the TALLEST tile on screen, so watching one of them answers a different
    // question than the one being asked: a later tile growing by 3px left the
    // track 3px under the tile it was holding, with nothing to trigger a
    // re-measure. Reconciled rather than re-observed wholesale — observing an
    // element fires an immediate callback, so disconnecting and re-attaching
    // every frame would spin a permanent animation-frame loop.
    const observer = observerRef.current;
    if (observer) {
      const watched = watchedTilesRef.current;
      const present = new Set<Element>(tiles);
      for (const gone of watched) {
        if (!present.has(gone)) {
          observer.unobserve(gone);
          watched.delete(gone);
        }
      }
      for (const tile of present) {
        if (!watched.has(tile)) {
          observer.observe(tile);
          watched.add(tile);
        }
      }
    }

    // The measurement reaches the bug report through the ref, not through
    // state. It is diagnostic output: nothing renders from it, so making it
    // state only bought a re-render — and, until #185, a re-entry.
    debugRef.current = { plan: nextPlan, metrics: nextMetrics, scrollTopPx, viewportPx, focusIndex };
    // THE ONLY setState HERE, and only when the WINDOW moves. Scrolling fires
    // continuously and a setState per pixel would spend the frame budget this
    // component exists to save; most scroll events leave the plan identical.
    //
    // One state, one writer: whatever the measurement said is already folded
    // into `nextPlan`, so there is no second value that can disagree with it
    // and no second update that can re-trigger this function (rule 12).
    setPlan((prev) => (samePlan(prev, nextPlan) ? prev : nextPlan));
  }, []);

  // Measure before the browser paints, so the first frame's fallback metrics are
  // corrected without a visible reflow. Re-runs when the query changes the list.
  //
  // ⚠️ THE DEPENDENCY LIST IS THE FIX. It used to carry the measured `metrics`
  // too, on the theory that the first pass measures against the FALLBACK row
  // height and a second pass is needed to apply the corrected one. The theory
  // was wrong — `syncInner` derives its plan from the measurement it just took,
  // so the corrected height is already applied by the pass that found it — and
  // what the dependency actually bought was a guaranteed re-entry: set the
  // metrics, re-run this effect, measure the window that setting them produced,
  // set them again. Every hop was a `setState` from inside React's commit
  // phase. React counts those as nested updates, resets the count only on a
  // commit that leaves no synchronous work behind, and throws #185 at fifty;
  // a handful of searches got there and the app unmounted.
  //
  // What is left is one synchronous measurement per query, which cannot feed
  // itself because nothing it writes is in this list. A tile that changes size
  // after it mounts — the real reason a second look is ever needed — is what
  // the ResizeObserver below is for, and that path re-syncs through `schedule`:
  // next animation frame, its own task, where a re-measure is not a nested
  // update.
  useMeasureEffect(() => {
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
    // Focus moving in or out changes which rows must stay mounted — and this one
    // is NOT rAF-coalesced.
    //
    // Tabbing to the last tile in the window has to extend the window before the
    // next Tab, or focus walks straight out of the grid and the rest of the pool
    // is unreachable from the keyboard. Measured: 16 of 45 Tab presses left the
    // grid while this went through `schedule`. Focus changes are user-paced and
    // rare, so doing the layout read on the spot costs nothing.
    const grid = gridRef.current;
    // focusIN is immediate, focusOUT is not, and the asymmetry is the point.
    //
    // Tabbing onto the last tile in the window has to extend the window before
    // the next Tab, or focus walks out of the grid and the rest of the pool is
    // unreachable from the keyboard (measured: 16 of 45 Tab presses left the
    // grid when this went through `schedule`). But focusOUT fires during
    // React's own commit as tiles unmount, so answering it immediately re-enters
    // the render — which took the whole app down once. It can wait a frame:
    // nothing about losing focus needs to be acted on before the next paint.
    const syncOnFocusIn = (): void => sync();
    grid?.addEventListener('focusin', syncOnFocusIn);
    grid?.addEventListener('focusout', schedule);
    // Watches TWO things: the grid, whose width decides the column count (the
    // deck panel, a scrollbar appearing, a rotation — none of which fire a
    // window resize), and the first rendered TILE, whose height decides the row
    // track. `sync` re-targets the tile side as the rendered set changes.
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observerRef.current = observer;
    if (observer && grid) observer.observe(grid);
    // One more pass on the next frame. The layout effect measures as early as it
    // is possible to measure, which turned out to be a frame too early; this
    // costs one extra measurement per mount and removes the dependence on that
    // first frame being representative.
    const settle = window.requestAnimationFrame(() => sync());
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(settle);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      grid?.removeEventListener('focusin', syncOnFocusIn);
      grid?.removeEventListener('focusout', schedule);
      observer?.disconnect();
      observerRef.current = null;
      watchedTilesRef.current = new Set();
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

  // From the PLAN, not from `metrics`: the two are set together and agree, but
  // reading the column count from the same object that sized the padding means
  // they cannot disagree even for one frame.
  const columns = Math.max(1, plan.columns);
  // Clamped against the CURRENT list: a re-query shrinks `cards` in the same
  // render that still carries the previous frame's plan (the layout effect
  // corrects it before paint), and an index past the end must not be a crash.
  const indices = planIndices(plan).filter((index) => index < cards.length);

  return (
    <div
      ref={gridRef}
      className="card-grid card-grid--virtual"
      // The rows above and below the window are stood in for by PADDING, not by
      // elements, so the page scrolls the full distance the pool deserves while
      // the grid holds a screenful. Padding rather than an explicit height
      // because cells are placed relative to `originRow` — see RenderPlan.
      style={{
        paddingTop: `${plan.paddingTopPx}px`,
        paddingBottom: `${plan.paddingBottomPx}px`,
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
            style={{ gridRowStart: Math.floor(index / columns) - plan.originRow + 1 }}
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
