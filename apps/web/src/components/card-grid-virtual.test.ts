/**
 * THE CARD GRID RENDERS A WINDOW, NOT A POOL — and searching still reaches the
 * cards that window leaves out.
 *
 * ## The defect this was written for
 *
 * Caleb: *"jonny boi is running really slow on cards and deck builder tabs"*,
 * and on hearing why: *"ew thats awful - who the heck thought that was a good
 * idea"*. `CardGrid` mapped its ENTIRE result list to `CardTile`s, so the app's
 * landing view built one tile per pool card — 5,651 of them, ~5 MB of DOM and
 * one lazy cross-origin Scryfall request each.
 *
 * ## Why the assertion is a RATIO and not a threshold
 *
 * A test that said "fewer than 500 tiles" would pass today and pass again at a
 * 32,276-card pool if someone re-broke this by raising a limit — and the pool
 * IS being grown toward that corpus. What actually has to hold is that the
 * rendered count is a function of the VIEWPORT and not of `cards.length`, so
 * the test renders two pools that differ by 4x and requires the SAME number of
 * tiles out of both. That is the invariant that keeps this fixed as the pool
 * grows, which is the whole point of the change.
 *
 * ## What this can and cannot see
 *
 * `renderToStaticMarkup` has no DOM, so what it exercises is the FIRST PAINT
 * path: `planRender` with the documented `card-grid-config.ts` fallbacks,
 * before any layout effect has measured anything. That is the right thing to
 * pin here — it is the frame the user waits on, and it is the one that used to
 * contain the whole pool. The measured path (real column counts, real row
 * heights, scrolling, focus) is arithmetic and is pinned in
 * `lib/grid-virtual.test.ts`; that it holds together in a real browser is
 * `apps/web/scripts/verify-card-browser-perf.mjs`, which measures node count,
 * frame time and blank-band coverage in Chrome.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { CARD_POOL } from '@jonny-boi/cards';
import { getCard } from '../lib/cards.js';
import { queryCards, EMPTY_QUERY } from '../lib/filter.js';
import { CardGrid } from './CardGrid.js';
import { CARD_GRID_FALLBACK_COLUMNS, CARD_GRID_INITIAL_ROWS } from '../lib/card-grid-config.js';

/** A real, displayable pool record — so a synthetic tile renders like a real one. */
const TEMPLATE: NormalizedCard = (() => {
  for (const card of CARD_POOL) {
    const record = getCard(card.id);
    if (record !== undefined) return record;
  }
  throw new Error('the pool must contain at least one displayable card');
})();

/**
 * A pool of `size` cards built from one real record, each with a unique id and
 * name. Synthetic rather than the real pool for two reasons: the real pool is
 * one fixed size, so it cannot answer a question about SCALING; and both sides
 * of the comparison below are built the same way, so any per-tile difference
 * between a synthetic card and a real one cancels out exactly.
 */
function poolOf(size: number): NormalizedCard[] {
  const out: NormalizedCard[] = new Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = { ...TEMPLATE, id: `synthetic-${i}`, name: `Synthetic Card ${i}` };
  }
  return out;
}

/** Count rendered tiles. Pinned below, so a typo here cannot make this vacuous. */
function tileCount(html: string): number {
  return (html.match(/class="card-tile"/g) ?? []).length;
}

function renderGrid(cards: readonly NormalizedCard[]): string {
  return renderToStaticMarkup(createElement(CardGrid, { cards, onSelect: () => {} }));
}

describe('the tile-counting the rest of this file depends on', () => {
  it('actually counts the tiles in real CardGrid markup', () => {
    // Rule 10's guard-with-the-fix: pin the DETECTOR, or every assertion below
    // is a test that can never fail.
    const html = renderGrid(poolOf(1));
    expect(tileCount(html)).toBe(1);
    expect(tileCount('')).toBe(0);
    // And the shape it looks for is really what CardTile emits.
    expect(html).toContain('class="card-tile"');
  });
});

describe('the rendered node count does not scale with the pool', () => {
  const small = renderGrid(poolOf(5_000));
  const huge = renderGrid(poolOf(20_000));

  it('a 20,000-card pool renders the same number of tiles as a 5,000-card one', () => {
    expect(tileCount(small)).toBeGreaterThan(0);
    expect(tileCount(huge)).toBe(tileCount(small));
  });

  it('and that number is a screenful, set by the config — not a slice of the pool', () => {
    // The first paint's window is `CARD_GRID_INITIAL_ROWS` rows at the fallback
    // column count. Naming both here means raising either one is a deliberate,
    // visible edit rather than a number that drifted.
    expect(tileCount(huge)).toBe(CARD_GRID_INITIAL_ROWS * CARD_GRID_FALLBACK_COLUMNS);
  });

  it('the markup itself stays the same size — the DOM, not just the tile count', () => {
    // The two differ only by the inline runway height (a few characters), so
    // anything more than a rounding-sized gap means per-card markup crept back.
    expect(Math.abs(huge.length - small.length)).toBeLessThan(200);
  });

  it('a pool four times larger claims four times the scroll runway', () => {
    // The COUNTERWEIGHT to the assertions above: a grid that renders a fixed
    // window and forgets the rest would pass every one of them and give the
    // user a page that will not scroll. The runway must still know the pool.
    const runway = (html: string): number =>
      Number(/style="height:(\d+(?:\.\d+)?)px/.exec(html)?.[1] ?? '0');
    expect(runway(small)).toBeGreaterThan(0);
    expect(runway(huge) / runway(small)).toBeCloseTo(4, 1);
  });

  it('every tile the deck builder adds is inside the window too', () => {
    // The pool grid in the Deck Builder is the same component with steppers, and
    // it is the OTHER tab Caleb named. A deckControls factory must not reopen
    // the per-card cost.
    const html = renderToStaticMarkup(
      createElement(CardGrid, {
        cards: poolOf(20_000),
        onSelect: () => {},
        deckControls: () => ({ count: 0, canAdd: true, onAdd: () => {}, onRemove: () => {} }),
      }),
    );
    expect(tileCount(html)).toBe(tileCount(huge));
    // …and it really did render the stepper, so this is the heavier tile.
    expect(html).toContain('stepper__btn');
  });
});

describe('search still spans the WHOLE pool, not the rendered window', () => {
  const pool = poolOf(20_000);
  /** A card far past anything the first screenful could contain. */
  const NEEDLE_INDEX = 19_000;
  const needle: NormalizedCard = { ...pool[NEEDLE_INDEX]!, name: 'Zzyzx Deep Needle' };
  pool[NEEDLE_INDEX] = needle;

  it('the needle is genuinely OUTSIDE the rendered window to begin with', () => {
    // Without this the next assertion proves nothing: a card that happened to be
    // on the first screenful would "be found" by a grid that never searched.
    const html = renderGrid(pool);
    expect(html).not.toContain('Zzyzx Deep Needle');
  });

  it('searching for it finds it and the grid renders it', () => {
    const results = queryCards(pool, { ...EMPTY_QUERY, search: 'zzyzx' });
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe('Zzyzx Deep Needle');
    expect(renderGrid(results)).toContain('Zzyzx Deep Needle');
  });

  it('a filter reaches it too — virtualising narrows the DRAWING, never the QUERY', () => {
    const byType = queryCards(pool, {
      ...EMPTY_QUERY,
      search: 'zzyzx',
      types: new Set(TEMPLATE.typeLine.types),
    });
    expect(byType.map((card) => card.name)).toContain('Zzyzx Deep Needle');
  });

  it('the result count the toolbar shows is the whole match set, not the window', () => {
    // `CardsView`/`DeckBuilderView` pass `results.length` to the toolbar and the
    // same `results` here, so the denominator a user reads stays honest.
    const results = queryCards(pool, EMPTY_QUERY);
    expect(results).toHaveLength(20_000);
    expect(tileCount(renderGrid(results))).toBeLessThan(results.length);
  });
});

describe('the empty state survived virtualisation', () => {
  it('no cards still says so, rather than rendering an empty runway', () => {
    const html = renderGrid([]);
    expect(html).toContain('No cards match.');
    expect(tileCount(html)).toBe(0);
  });
});
