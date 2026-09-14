/**
 * THE BOARD'S RIGHT EDGE HAS AN OWNER — and every overlay pinned to it must say so.
 *
 * §3.143 wave 3 moved the game log off the midline into `.board-rail`, which now
 * occupies the board's right edge. Two absolutely-positioned overlays were already
 * pinned there with a bare `right: var(--space-2)` and both landed ON the rail:
 * `.opp-feed` printed its toasts over the words "GAME LOG" (visible in three
 * separate harness screenshots before anyone noticed), and `.stack-panel--floating`
 * shares the identical inset.
 *
 * That is one defect wearing two costumes, so the remedy is one token —
 * `--play-board-right-overlay-inset`, declared once in `board-fit.css` beside the
 * rail that motivates it and zeroed in the phone block where the rail folds under
 * the table — and this test, which is the GUARD that stops a third costume.
 *
 * ## Why a source sweep rather than a render assertion
 * The collision is a LAYOUT fact: two elements in the same stacking context whose
 * boxes intersect. jsdom has no viewport, no flexbox and no `dvh`, so it cannot
 * see an overlap — this exact class of bug has now escaped a 22,000-test suite
 * three times on this branch and been caught by a PNG each time. What a source
 * sweep *can* prove is the thing that actually went wrong: an author writing a new
 * right-pinned overlay and not knowing the edge was taken. So the sweep is the
 * honest guard, and the honest limitation is stated here rather than implied away:
 * it proves every overlay ASKS for the shared inset, never that the resulting
 * pixels clear the rail. Re-run `verify-board-fits.mjs` and LOOK at the PNG for
 * that.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PLAY_CSS_DIR = dirname(fileURLToPath(import.meta.url));

/** The token every right-pinned overlay on the play board must resolve through. */
const SHARED_INSET = '--play-board-right-overlay-inset';

/**
 * Overlays allowed to pin right WITHOUT the shared inset — because their
 * containing block is NOT the board.
 *
 * This is the part a source sweep cannot infer: `right` is resolved against the
 * nearest positioned ancestor, and which ancestor that is lives in the JSX, not in
 * the stylesheet. So the table is CLOSED and each row names the box the overlay is
 * actually pinned to. An overlay that is neither listed here nor using the shared
 * token fails — which is the correct default, because the two originals were not
 * deliberate decisions at all, they were written before the rail existed and never
 * revisited.
 *
 * Adding a row is cheap and must stay a conscious act: the question it forces —
 * "pinned to what?" — is exactly the question nobody asked about `.opp-feed`.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  ['.board-rail', 'it IS the right edge — the thing the others clear, not a thing that clears it'],
  ['.perm__combat', 'pinned inside its own battlefield tile (.perm), not the board'],
  ['.card-face__textbox', 'pinned inside its own CardFace'],
  ['.card-face__pt', 'pinned inside its own CardFace'],
  ['.card-face__chips', 'pinned inside its own CardFace'],
  ['.hand-card-slot__choose-mana', 'pinned inside its own hand slot'],
]);

interface RightPin {
  readonly file: string;
  readonly selector: string;
  readonly declaration: string;
}

/** Every CSS file that styles the play surface. */
function playStylesheets(): readonly string[] {
  return readdirSync(PLAY_CSS_DIR)
    .filter((name) => name.endsWith('.css'))
    .map((name) => join(PLAY_CSS_DIR, name));
}

/**
 * Find every rule that BOTH positions absolutely/fixed AND pins a `right`.
 *
 * Deliberately crude block-splitting rather than a CSS parser: the repo ships no
 * parser, and a regex that misses a rule would make this test vacuous. So the
 * detector is pinned by its own test below — if the sweep ever stops finding the
 * two overlays it was written for, it has broken, and that is a failure.
 */
function rightPinnedOverlays(): readonly RightPin[] {
  const found: RightPin[] = [];
  for (const file of playStylesheets()) {
    const css = readFileSync(file, 'utf8');
    // Strip comments so a `right:` inside prose cannot be mistaken for a rule.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (match[1] ?? '').trim().replace(/\s+/g, ' ');
      const body = match[2] ?? '';
      if (!/position\s*:\s*(absolute|fixed)/.test(body)) continue;
      const right = /(^|[;\s])right\s*:\s*([^;]+)/.exec(body);
      if (!right) continue;
      found.push({ file, selector, declaration: (right[2] ?? '').trim() });
    }
  }
  return found;
}

describe('overlays pinned to the play board’s right edge', () => {
  it('the sweep is not vacuous — it finds the two overlays it exists for', () => {
    const selectors = rightPinnedOverlays().map((p) => p.selector);
    // If a refactor renames these, this assertion is the thing that should fail
    // first — a silent zero-match sweep would pass every other test here forever.
    expect(selectors.some((s) => s.includes('.opp-feed'))).toBe(true);
    expect(selectors.some((s) => s.includes('.stack-panel--floating'))).toBe(true);
  });

  it('every right-pinned overlay clears the log rail through the shared token', () => {
    const offenders = rightPinnedOverlays().filter((pin) => {
      if ([...EXEMPT.keys()].some((sel) => pin.selector.includes(sel))) return false;
      // `right: auto` / `inset: auto` un-pins rather than pinning; nothing to clear.
      if (/^auto$/.test(pin.declaration)) return false;
      return !pin.declaration.includes(SHARED_INSET);
    });

    expect(
      offenders.map((o) => `${o.selector} { right: ${o.declaration} }`),
      `These overlays pin to the play board's right edge without reserving for the log rail, ` +
        `so they will paint on top of it. Use right: var(${SHARED_INSET}, var(--space-2, 8px)) ` +
        `(declared in board-fit.css), or add a row to EXEMPT with the reason it genuinely does not ` +
        `need to clear the rail.`,
    ).toEqual([]);
  });

  it('the shared token is declared, and is zeroed where the rail folds under', () => {
    const boardFit = readFileSync(join(PLAY_CSS_DIR, 'board-fit.css'), 'utf8');
    const declarations = [...boardFit.matchAll(new RegExp(`${SHARED_INSET}\\s*:`, 'g'))];
    // Two: the default that reserves the rail, and the phone override that does
    // not — a 17rem clearance on a 375px screen pushes the overlay off the board.
    expect(declarations.length).toBe(2);
    expect(boardFit).toContain('--play-log-rail-w');
  });
});
