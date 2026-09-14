/**
 * "HOVERING OVER ANY ABILITY LIKE VIGILANCE, ON ANY CARD" — the REACH half
 * (§3.143 wave 3 / GAP-E, UX-17.4).
 *
 * The state this file exists to change, established by the wave-3 re-audit:
 *
 *   - a glossary pop opens from an `onMouseEnter` on a `PopTrigger` span
 *     (`CardFace.tsx`), i.e. from JS, not from a CSS `:hover`;
 *   - `card-hover.css` set `.card-hover-preview { pointer-events: none }`, so a
 *     span inside the preview received no `mouseenter` and the pops in there
 *     could NEVER open — not "were awkward to reach", could not open;
 *   - the battlefield tile renders `rules: 'aftermarketOnly'`, so a PRINTED
 *     keyword has no trigger on the tile at all;
 *   - `CardZoomOverlay` — the other pointer-live face — is reachable from the
 *     graveyard/exile lists and a peeked prisoner, never from a creature in play.
 *
 * Net: on a battlefield creature, "vigilance" had no reachable explanation
 * anywhere, and three waves of green tests said nothing, because every one of
 * them asserted that markup or a CSS property EXISTED.
 *
 * ⚠️ WHAT THIS FILE CANNOT DO, stated so it is not mistaken for proof. The suite
 * has no DOM, so nothing here dispatches a `mousemove`, runs a cascade or
 * resolves `pointer-events`. What is PROVEN here is the pure region rule — the
 * part that is arithmetic — plus structural guards on the exact declarations
 * that were wrong. Whether a human can actually put the cursor on the word
 * "vigilance" in a live preview is BROWSER-UNVERIFIED and needs a person to look.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CARD_PREVIEW_CURSOR_GAP_PX } from './card-hover-config.js';
import { hoverRegionContains, type HoverBox } from './CardHover.js';
import { CardFace } from './play/CardFace.js';
import { getCardByName } from '../lib/cards.js';

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const hoverSource = read('./CardHover.tsx');
const hoverCss = read('./card-hover.css');
const faceCss = read('./play/card-face.css');

/* -------------------------------------------------------------------------- */
/* 1. The pure region rule                                                     */
/* -------------------------------------------------------------------------- */

/** A 96px battlefield tile at the board's left. */
const TILE: HoverBox = { left: 200, top: 300, right: 296, bottom: 434 };
/** The preview `previewPlacement` opens to its right, across the cursor gap. */
const PANEL: HoverBox = {
  left: 296 + CARD_PREVIEW_CURSOR_GAP_PX,
  top: 120,
  right: 296 + CARD_PREVIEW_CURSOR_GAP_PX + 340,
  bottom: 595,
};

describe('the hover region is the anchor, the panel, AND the gap between them', () => {
  it('the pointer on the tile is inside', () => {
    expect(hoverRegionContains({ x: 250, y: 350 }, TILE, PANEL)).toBe(true);
  });

  it('the pointer on the panel is inside — this is the whole fix', () => {
    // Before GAP-E the panel was not part of the region and could not be, since
    // it was pointer-transparent. A word in the text box lives here.
    expect(hoverRegionContains({ x: 500, y: 500 }, TILE, PANEL)).toBe(true);
  });

  it('the pointer CROSSING the cursor gap is inside', () => {
    // The regression this pins: a bare "is the target inside the anchor" test
    // closes the preview here, one pixel of bare board from the panel, and the
    // player never reaches the word they were going for.
    const midGap = 296 + CARD_PREVIEW_CURSOR_GAP_PX / 2;
    expect(hoverRegionContains({ x: midGap, y: 350 }, TILE, PANEL)).toBe(true);
    // …including a diagonal reach toward the panel's top or bottom, which the
    // band covers because the panel is far taller than the tile.
    expect(hoverRegionContains({ x: midGap, y: 150 }, TILE, PANEL)).toBe(true);
  });

  it('the pointer anywhere ELSE is outside, so the preview still closes', () => {
    expect(hoverRegionContains({ x: 250, y: 700 }, TILE, PANEL)).toBe(false); // below
    expect(hoverRegionContains({ x: 40, y: 350 }, TILE, PANEL)).toBe(false); // the other way
    expect(hoverRegionContains({ x: 900, y: 350 }, TILE, PANEL)).toBe(false); // past the panel
  });

  it('the corridor is only as wide as the gap, so a neighbouring tile is not swallowed', () => {
    // The reason widening the region does not become "the preview never closes":
    // the corridor is a band a couple of dozen pixels across, not the bounding
    // box of the two elements. A point level with the tile but well to its left
    // is outside even though it is inside that bounding box.
    const bandWidth = PANEL.left - TILE.right;
    expect(bandWidth).toBe(CARD_PREVIEW_CURSOR_GAP_PX);
    expect(hoverRegionContains({ x: TILE.left - 1, y: 200 }, TILE, PANEL)).toBe(false);
  });

  it('works when the panel FLIPS to the anchor’s left near the viewport edge', () => {
    const tile: HoverBox = { left: 1200, top: 300, right: 1296, bottom: 434 };
    const panel: HoverBox = { left: 830, top: 120, right: 1200 - CARD_PREVIEW_CURSOR_GAP_PX, bottom: 595 };
    const midGap = tile.left - CARD_PREVIEW_CURSOR_GAP_PX / 2;
    expect(hoverRegionContains({ x: midGap, y: 350 }, tile, panel)).toBe(true);
    expect(hoverRegionContains({ x: 400, y: 350 }, tile, panel)).toBe(false);
  });

  it('overlapping boxes need no corridor and grow no phantom one', () => {
    const panel: HoverBox = { left: 250, top: 120, right: 590, bottom: 595 };
    expect(hoverRegionContains({ x: 260, y: 350 }, TILE, panel)).toBe(true);
    expect(hoverRegionContains({ x: 700, y: 350 }, TILE, panel)).toBe(false);
  });

  it('a box that measured NOTHING contributes nothing rather than a strip at x=0', () => {
    // "I could not measure this" must not resolve to "the pointer is in it" —
    // a collapsed rect is all zeroes, and treating it as live would keep every
    // preview open for a cursor near the top-left corner.
    const collapsed: HoverBox = { left: 0, top: 0, right: 0, bottom: 0 };
    expect(hoverRegionContains({ x: 0, y: 0 }, collapsed, undefined)).toBe(false);
    expect(hoverRegionContains({ x: 500, y: 500 }, TILE, collapsed)).toBe(false);
    expect(hoverRegionContains({ x: 250, y: 350 }, TILE, undefined)).toBe(true);
    expect(hoverRegionContains({ x: 500, y: 500 }, undefined, PANEL)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The declaration that was wrong, pinned                                   */
/* -------------------------------------------------------------------------- */

/** The `.card-hover-preview` rule's declarations, comments stripped. */
function previewRule(): string {
  const stripped = hoverCss.replace(/\/\*[\s\S]*?\*\//gu, '');
  const start = stripped.indexOf('.card-hover-preview {');
  expect(start, 'no .card-hover-preview rule at all').toBeGreaterThanOrEqual(0);
  return stripped.slice(start, stripped.indexOf('}', start));
}

describe('the preview accepts the pointer, or the glossary in it is decoration', () => {
  it('`.card-hover-preview` is `pointer-events: auto`', () => {
    // Flip this back to `none` and every pop inside the preview silently stops
    // opening, with nothing else in the suite noticing. That is exactly how it
    // shipped in wave 1 and again in wave 2.
    const rule = previewRule();
    expect(rule).toContain('pointer-events: auto');
    expect(rule).not.toContain('pointer-events: none');
  });

  it('the tooltips themselves stay inert, so they never eat their own trigger', () => {
    // The pops are portaled to <body> and float over everything; making THEM
    // pointer-live would put a box between the cursor and the word it explains.
    expect(faceCss).toContain('pointer-events: none');
  });

  it('the component measures the panel and treats it as part of the hover', () => {
    expect(hoverSource).toContain('panelRef={panelEl}');
    expect(hoverSource).toContain('panelEl.current?.getBoundingClientRect()');
    // The anchor's own `mouseleave` no longer closes unconditionally — it fires
    // the instant the pointer crosses the tile's edge toward the panel.
    expect(hoverSource).not.toMatch(/onMouseLeave=\{clear\}\s*\n\s*\/\/ Keyboard parity/u);
    expect(hoverSource).toContain('if (!inRegion({ x: event.clientX, y: event.clientY })) clear();');
  });

  it('the stuck-preview safety net is still armed', () => {
    // Bug 20260901_205453 (a Forest preview stuck over the whole board) matters
    // MORE now that the panel captures the pointer: a stuck panel would block
    // the board. Every dismissal signal is still listened for, and the region
    // only widens which MOVES are ignored.
    for (const listener of ['mousemove', 'pointerdown', 'scroll', 'wheel', 'keydown']) {
      expect(hoverSource, `no ${listener} listener`).toContain(`'${listener}'`);
    }
    expect(hoverSource).toContain('hoverShouldClose');
    // Leaving the panel itself is the direct close, not just a geometric miss.
    expect(hoverSource).toContain('onMouseLeave={onLeave}');
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The word has to be big enough to point at — from ONE declaration         */
/* -------------------------------------------------------------------------- */

describe('the two READING surfaces size their text from one token', () => {
  it('`--card-face-read-text-size` is declared exactly once', () => {
    const declarations = faceCss.match(/--card-face-read-text-size:/gu) ?? [];
    expect(declarations).toHaveLength(1);
    expect(hoverCss).not.toContain('--card-face-read-text-size:');
  });

  it('the zoom overlay and the hover preview both READ it, and neither restates it', () => {
    // Two literal `clamp(...)` values that must stay equal is the fork rule 12
    // forbids; before this wave the zoom carried its own copy.
    expect(faceCss).toContain('.card-face--zoomed .card-face__textbox');
    expect(hoverCss).toContain('.card-hover-preview__face .card-face__textbox');
    expect(faceCss).toContain('font-size: var(--card-face-read-text-size)');
    expect(hoverCss).toContain('font-size: var(--card-face-read-text-size)');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. What is actually being reached: a PRINTED keyword's explanation          */
/* -------------------------------------------------------------------------- */

describe('the preview is the surface that carries a printed keyword’s glossary', () => {
  /** Elite Inquisitor prints "First strike, vigilance" — Caleb's own example word. */
  function eliteInquisitorFace(size: 'tile' | 'full'): string {
    const card = getCardByName('Elite Inquisitor');
    expect(card, 'the pool no longer has Elite Inquisitor').toBeDefined();
    return renderToStaticMarkup(
      createElement(CardFace, { cardId: card!.id, name: card!.name, isCreature: true, size }),
    );
  }

  it('a full-size face gives "vigilance" a focusable, described trigger', () => {
    const html = eliteInquisitorFace('full');
    expect(html).toContain('vigilance');
    expect(html).toContain('card-face__tok--printed');
    // A trigger is a focusable span pointing at its own tooltip — that pairing is
    // what makes the pop openable at all.
    expect(html).toMatch(/tabindex="0"[^>]*aria-describedby="/u);
  });

  it('the TILE has no such trigger, which is why the preview had to be fixed', () => {
    // `rules: 'aftermarketOnly'` — the deliberate choice a ~96px tile forces, and
    // the reason "hover the ability on the battlefield" has to be answered
    // somewhere else. If this ever starts passing, the preview is no longer the
    // only route and this file's premise should be re-read.
    expect(eliteInquisitorFace('tile')).not.toContain('vigilance');
  });

  it('the preview mounts that same full-size face', () => {
    const panel = hoverSource.slice(hoverSource.indexOf('function CardHoverPanel'));
    expect(panel).toContain('<CardFace');
    expect(panel).toContain('size="full"');
  });
});
