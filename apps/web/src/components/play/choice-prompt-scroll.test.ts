/**
 * A SCROLLER INSIDE A FLEX COLUMN NEEDS `min-height: 0`, OR IT IS NOT A SCROLLER.
 *
 * ## The two bugs this exists for — one cause
 * Caleb, 2026-09-14: *"The option list for Cloudshift doesnt scroll and just clips
 * offscreen"*, and, separately, an Angel of Serenity whose three picked creatures
 * were never exiled.
 *
 * `.choice-prompt__card` is `max-height: 90vh; display: flex; flex-direction:
 * column`, and `.choice-prompt__options` carried `overflow-y: auto` with no
 * `min-height`. A flex item's default `min-height: auto` refuses to shrink below
 * its content, so the overflow never engages: the list grows past the card and
 * pushes `.choice-prompt__foot` — which holds Confirm — off the bottom of the
 * screen. Cloudshift clips. And because a "choose up to three" prompt is
 * `min: 0`, dismissing it without reaching Confirm is a LEGAL answer meaning
 * "exile nothing" — so the Angel exiled nothing, silently and by the rules.
 *
 * The engine was never at fault: `angel-of-serenity.test.ts` drives it directly
 * and its five cases pass, including "exiles three across both zones".
 *
 * ## Why a test, and why this shape
 * `board-fit.css` already learned this rule on the play board and wrote it down.
 * It recurred here anyway, because prose does not travel between stylesheets. So
 * the guard is executable and it sweeps by STRUCTURE — any rule that opts into
 * scrolling must also opt out of the default floor — rather than naming the two
 * selectors that happen to be wrong today.
 *
 * ## What it cannot prove
 * jsdom has no flexbox, so this cannot assert that the footer is on screen. It
 * asserts the declaration whose absence causes the bug. The pixels are the
 * browser harnesses' job.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every stylesheet the app ships, found rather than listed. */
function stylesheets(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...stylesheets(full));
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

/**
 * Selectors allowed to scroll WITHOUT `min-height: 0`, each with its reason.
 * A CLOSED table: an unlisted scroller that omits the floor fails, rather than
 * being assumed fine. The reason is the point — "it works today" is not one.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  ['.choice-prompt__list--scroll', 'carries its own max-height (40vh), so it never depends on the parent to bound it'],
  ['.card-face__textbox', 'absolutely positioned between a fixed top and bottom — not a flex item at all'],
  [
    '.bugreport__panel',
    // NOT VERIFIED AS SAFE, and said so rather than implied: this is a ROW-direction
    // flex item (`flex: 0 0 340px` fixes its WIDTH), so its height comes from the
    // parent's stretch rather than from a column parent that refuses to shrink —
    // a different geometry from the bug this test exists for. I have not reproduced
    // clipping there, and `verify-bug-reporter.mjs` passes 31/31. Exempted on that
    // basis, not on a proof. If the reporter's panel is ever seen to clip, delete
    // this row first.
    'row-direction flex item: height comes from stretch, not from a shrink-refusing column parent',
  ],
]);

interface Scroller {
  readonly file: string;
  readonly selector: string;
  readonly body: string;
}

/**
 * Rules that opt into vertical scrolling. Deliberately crude block-splitting —
 * this repo ships no CSS parser, and a regex that silently matched nothing would
 * make the test vacuous, which is why the non-vacuity case below pins it.
 */
function verticalScrollers(): readonly Scroller[] {
  const found: Scroller[] = [];
  for (const file of stylesheets(WEB_SRC)) {
    const bare = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (match[1] ?? '').trim().replace(/\s+/g, ' ');
      const body = match[2] ?? '';
      // `overflow-y: auto|scroll`, or shorthand `overflow` that implies it.
      if (!/overflow(-y)?\s*:\s*(auto|scroll)/.test(body)) continue;
      // A fixed/absolute box is bounded by its insets, not by a flex parent.
      if (/position\s*:\s*(fixed|absolute)/.test(body)) continue;
      // An explicit height or max-height is its own bound.
      if (/(^|[;\s])(max-)?height\s*:/.test(body)) continue;
      found.push({ file: file.slice(WEB_SRC.length + 1).replace(/\\/g, '/'), selector, body });
    }
  }
  return found;
}

describe('scrollers inside flex columns', () => {
  it('the sweep finds real scrollers — it cannot pass by matching nothing', () => {
    const all = verticalScrollers();
    expect(all.length).toBeGreaterThan(0);
    // The rule this test was written for must be among them.
    expect(all.some((s) => s.selector.includes('.choice-prompt__options'))).toBe(true);
  });

  it('every unbounded scroller declares min-height: 0', () => {
    const offenders = verticalScrollers()
      .filter((s) => ![...EXEMPT.keys()].some((sel) => s.selector.includes(sel)))
      .filter((s) => !/min-height\s*:\s*0/.test(s.body))
      .map((s) => `${s.file}: ${s.selector}`);

    expect(
      offenders,
      'These rules opt into scrolling but keep the default `min-height: auto`, which refuses to ' +
        'shrink below content — so inside a flex column the overflow never engages and the content ' +
        'pushes its siblings (Confirm buttons, footers) off screen. Add `min-height: 0`, give the ' +
        'rule its own max-height, or add a row to EXEMPT saying why it is bounded some other way.',
    ).toEqual([]);
  });
});
