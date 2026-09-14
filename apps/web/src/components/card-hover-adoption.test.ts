/**
 * ONE HOVER FUNNEL, AND EVERY CARD SURFACE IS IN IT (§3.143 / UX-10, wave 2 GAP-21).
 *
 * Caleb asked for *"hovering over any card ever"* — **any**, which includes the
 * thousands of cards in the browser and the deck builder, not just the twenty on
 * a play surface. `CardHover` has existed since §3.53 and the card grid never
 * used it: you could hover a 4/5 on the battlefield and read its whole text box,
 * and hover the same card in the deck builder and get nothing.
 *
 * ## Why this guard is shaped as "who is inside whom"
 *
 * Wave 1's lesson is that a component can be written, unit-tested and imported
 * and still reach no screen. A test that renders `CardHover` in isolation proves
 * the funnel WORKS; only a test that asks *which surfaces are inside it* proves
 * the funnel is USED. So there are two kinds of assertion here and both are
 * required:
 *
 *  - a RENDER assertion, on the real markup a grid tile produces;
 *  - a STRUCTURAL sweep, which fails if any card renderer in this lane's files
 *    is ever mounted outside the funnel — including one added tomorrow by
 *    someone who has never read this file. That is the CLASS; the grid tile was
 *    only the instance.
 *
 * A second hover mechanism would satisfy neither: the sweep asks for
 * `CardHover` by name, because "one component with one props contract, adopted
 * by every site — not a sixth renderer" (spec §2.4) is the actual requirement.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CARD_POOL } from '@jonny-boi/cards';
import { getCard } from '../lib/cards.js';
import { CardTile } from './CardTile.js';

/* -------------------------------------------------------------------------- */
/* The render half                                                             */
/* -------------------------------------------------------------------------- */

const SUBJECT = (() => {
  for (const card of CARD_POOL) {
    const record = getCard(card.id);
    if (record !== undefined) return record;
  }
  throw new Error('the pool must contain at least one displayable card');
})();

describe('the card browser / deck-builder grid is inside the funnel', () => {
  it('the tile’s art is wrapped in a CardHover anchor', () => {
    const html = renderToStaticMarkup(
      createElement(CardTile, { card: SUBJECT, onSelect: () => {} }),
    );
    // `CardHover` with no className renders a bare <span> around its children.
    // Matching it positionally is the point: drop the wrapper and this reddens.
    // The class is `card-tile__art-btn`, not `card-tile__art`: the button used to
    // wear the art box’s class while an inline `all: unset` unset every one of
    // its declarations, so the name said nothing. It now wears its own reset
    // class and the art box stays on `CardArt`’s div — see `inline-style-reset.test.ts`.
    expect(html).toMatch(/<span><button type="button" class="card-tile__art-btn"/);
  });

  it('the grid’s own art stays LAZY — the funnel must not cost the grid its budget', () => {
    const html = renderToStaticMarkup(
      createElement(CardTile, { card: SUBJECT, onSelect: () => {} }),
    );
    // Rule 7. The eager-image rule (`play-surface-images.test.ts`) is scoped to
    // play surfaces, where nothing is ever off-screen; this grid is thousands of
    // cards long and the preview loads one card, on demand.
    expect(html).toContain('loading="lazy"');
  });
});

/* -------------------------------------------------------------------------- */
/* The structural sweep                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every card renderer this lane mounts, and the file it is mounted in.
 *
 * A TABLE, so covering a new surface is a ROW. `CardBack` is deliberately
 * absent: a face-down card has nothing to magnify, and wrapping it would be a
 * hover that opens on nothing.
 */
const CARD_MOUNT_SITES: readonly { readonly file: string; readonly element: string }[] = [
  { file: './CardTile.tsx', element: '<CardArt' },
  { file: './online/OnlineBoard.tsx', element: '<PlayCard' },
  // The opened graveyard AND the opened exile, one component (UX-10): the zone
  // panel is the surface that had no preview at all, and it is the one whose
  // card list grows a zone at a time, so it is exactly where an unfunnelled
  // renderer would arrive next.
  { file: './play/ZonePanel.tsx', element: '<PlayCard' },
];

/** Source with comments stripped — a tag named in prose is not a mount site. */
function codeOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/** How many `CardHover` elements are still OPEN at `index` (JSX tags balance). */
function hoverDepthAt(code: string, index: number): number {
  const before = code.slice(0, index);
  const opens = (before.match(/<CardHover\b/g) ?? []).length;
  const closes = (before.match(/<\/CardHover>/g) ?? []).length;
  return opens - closes;
}

describe('no card renderer in this lane escapes the funnel', () => {
  for (const site of CARD_MOUNT_SITES) {
    it(`every ${site.element} in ${site.file} is inside a CardHover`, () => {
      const code = codeOf(site.file);
      const indices = [...code.matchAll(new RegExp(site.element.replace('<', '<'), 'g'))].map(
        (m) => m.index ?? -1,
      );
      expect(indices.length, `${site.file} renders no ${site.element} at all`).toBeGreaterThan(0);
      for (const index of indices) {
        expect(
          hoverDepthAt(code, index),
          `a ${site.element} at offset ${index} in ${site.file} is mounted outside CardHover`,
        ).toBeGreaterThan(0);
      }
    });
  }

  it('the funnel is CardHover itself, not a local re-implementation', () => {
    for (const site of CARD_MOUNT_SITES) {
      const code = codeOf(site.file);
      expect(code).toMatch(/import \{[^}]*CardHover[^}]*\} from/);
      // A second preview built out of a raw <img> and mouse handlers is the
      // shape rule 12 forbids; the funnel already owns dismissal, placement and
      // the keyboard path (see CardHover's header).
      expect(code).not.toMatch(/onMouseEnter=\{[^}]*[Pp]review/);
    }
  });
});
