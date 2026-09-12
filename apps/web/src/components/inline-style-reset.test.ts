/**
 * Guard: no React component may set the CSS `all` shorthand in an inline
 * `style={{ ... }}` prop (§3.143 wave 3, rule 7 / rule 10).
 *
 * ## Why this exists — the defect it was written for
 *
 * `CardTile` reset its art button's browser chrome with
 * `style={{ all: 'unset', cursor: 'pointer', display: 'block' }}`. That is
 * correct CSS and it looked free. It is not free: React writes the prop through
 * the CSSOM, and the CSSOM **expands the `all` shorthand into every CSS
 * longhand it knows**, so `element.outerHTML` carries ~7.4 KB of `style`
 * attribute for that one declaration. On the card browser — 5,651 tiles, one
 * button each — that made the app's LANDING VIEW a 42 MB DOM (measured:
 * `#root.innerHTML.length === 42,231,776`, of which the tiles were 41.9 MB).
 *
 * It was invisible to every existing test for a reason worth writing down:
 * **`renderToStaticMarkup` does NOT expand the shorthand.** React's server
 * renderer emits the literal string `style="all:unset;cursor:pointer"`, so an
 * SSR snapshot sees ~30 characters and reports that everything is fine. Only a
 * real browser's CSSOM expands it, which is why the symptom surfaced as a
 * BROWSER HARNESS timeout (`verify-game-resume.mjs` waiting 30 s for
 * `.app__nav` after a reload, against a render that took ~40 s with a
 * MutationObserver attached and ~3 s without one) and never as a red unit test.
 *
 * ## Why it is a SOURCE sweep and not a render assertion
 *
 * Per the paragraph above, there is no DOM available in this suite that would
 * expand the shorthand, so there is nothing to measure — the only honest guard
 * is over the source text. It is therefore a STRUCTURAL check: it proves no
 * component asks for the expansion, not that any particular page is small.
 * The size claim itself is a harness/browser measurement, recorded above.
 *
 * The fix is always the same shape: move the reset into a stylesheet class,
 * where `all: unset` costs nothing per element.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, '..');

/** Every `.tsx` under `apps/web/src`, so a new component is swept the day it lands. */
function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsxFiles(full));
    } else if (entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * `all:` as a key of an inline style object — `all: 'unset'`, `all: "revert"`,
 * `all: x`. Anchored on the `{`/`,`/newline before it so a word ending in
 * "all" (`overall:`) cannot match.
 */
const INLINE_ALL = /(?:^|[{,\s])all\s*:\s*['"`]?[A-Za-z-]/;

/**
 * Block comments and whole-line `//` comments removed, so prose ABOUT the
 * defect is not mistaken for the defect — `CardTile.tsx` quotes the offending
 * line in its doc-comment in order to explain it, and a guard that reddens on
 * its own explanation teaches the next reader to delete the explanation.
 *
 * A trailing `//` on a line of real code is deliberately NOT stripped: eating
 * the whole line would also eat any style prop sharing it, and a guard that
 * can be silenced by appending a comment is worse than none.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('no component expands the CSS `all` shorthand through an inline style', () => {
  const files = tsxFiles(SRC_ROOT);

  it('sweeps a real, non-trivial set of components', () => {
    // A broken walker that found nothing would otherwise pass silently.
    expect(files.length).toBeGreaterThan(20);
  });

  it('no `style={{ all: ... }}` anywhere in apps/web/src', () => {
    const offenders: string[] = [];
    for (const file of files) {
      // Comments are stripped first: a doc-comment that QUOTES the defect in
      // order to explain it (CardTile.tsx does exactly that) is documentation,
      // not a style prop, and a guard that reddens on its own explanation
      // teaches the next reader to delete the explanation.
      const text = stripComments(readFileSync(file, 'utf8'));
      // Only inline STYLE objects matter; a stylesheet `all: unset` is the fix,
      // not the defect, and .css files are not swept here at all.
      for (const match of text.matchAll(/style=\{\{([^}]*)\}\}/g)) {
        if (INLINE_ALL.test(match[1] ?? '')) {
          offenders.push(`${relative(SRC_ROOT, file)}: ${match[0].slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the regex it sweeps with actually matches the defect it was written for', () => {
    // Rule 10's guard-with-the-fix: pin the DETECTOR too, or a typo in the
    // pattern turns this whole file into a test that can never fail.
    const defect = "style={{ all: 'unset', cursor: 'pointer', display: 'block' }}";
    const inner = /style=\{\{([^}]*)\}\}/.exec(defect)?.[1] ?? '';
    expect(INLINE_ALL.test(inner)).toBe(true);
    expect(INLINE_ALL.test(" overall: 'x' ")).toBe(false);
    expect(INLINE_ALL.test(" display: 'block' ")).toBe(false);
    // And the comment stripper must actually remove the prose that quotes it.
    expect(stripComments(`/* ${defect} */`).trim()).toBe('');
    expect(stripComments(`  // ${defect}`).trim()).toBe('');
    // A trailing comment does NOT hide the code in front of it.
    expect(stripComments(`const a = 1; // note`)).toContain('const a = 1');
    expect(stripComments(`const s = "${defect}";`)).toContain('all:');
  });
});
