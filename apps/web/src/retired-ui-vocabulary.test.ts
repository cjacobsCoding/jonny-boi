/**
 * RETIRED CLASS NAMES STAY RETIRED (§3.143 wave 2, GAP-16).
 *
 * ## The gap
 * Wave 1 replaced two components outright — the stack panel (UX-1) and the
 * straight blocker lines (UX-14) — and left their old rules sitting in
 * `styles.css`. Nothing rendered `.stack-item` or `.combat-lines` any more, so
 * the rules painted nothing; but a reader opening that file found what looks
 * like the live styling for the stack, and would have edited it. CLAUDE.md calls
 * a stale comment "a bug with a blast radius"; a stale RULE is the same bug with
 * a stylesheet attached.
 *
 * ## The guard
 * A CLOSED TABLE of vocabulary this overhaul retired, each row naming what
 * replaced it. For each row:
 *
 *  - no stylesheet may declare a selector in the retired family, and
 *  - no component may put the retired name in a string, and
 *  - the REPLACEMENT must still exist — so a row cannot be satisfied by deleting
 *    both halves and quietly losing the feature.
 *
 * Comments are stripped before matching, deliberately: `styles.css` now carries
 * a note at each deletion saying which classes used to live there and why they
 * are gone. Prose about a retired class is the right thing to leave behind; a
 * RULE is not, and a guard that could not tell them apart would force the note
 * to be deleted too.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const WEB_SRC = fileURLToPath(new URL('./', import.meta.url));

/** Every file under `apps/web/src` whose name ends in `suffix`, comment-stripped. */
function sources(suffix: string): readonly (readonly [string, string])[] {
  const out: [string, string][] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(`${dir}${entry.name}/`, `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith(suffix)) continue;
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
      // CRLF trap (CLAUDE.md): normalise before matching. Comments go too — see
      // the header for why that is load-bearing rather than tidy.
      const raw = readFileSync(`${dir}${entry.name}`, 'utf8').replace(/\r\n/gu, '\n');
      out.push([`${prefix}${entry.name}`, stripComments(raw)]);
    }
  };
  walk(WEB_SRC, '');
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

/** One name this overhaul retired, and what took its place. */
interface RetiredName {
  /** The retired class, matched as a PREFIX: `stack-item` covers `stack-item__kind`. */
  readonly retired: string;
  /** The class that replaced it. Must still exist, or the feature went with it. */
  readonly replacement: string;
  readonly why: string;
}

/** CLOSED. A component replaced outright is a ROW. */
const RETIRED_NAMES: readonly RetiredName[] = [
  {
    retired: 'stack-item',
    replacement: 'stack-row',
    why: 'UX-1 replaced the four-text-span stack panel with a fan of real card faces.',
  },
  {
    retired: 'stack-panel__list',
    replacement: 'stack-panel__rows',
    why: 'Same rewrite: the panel is an `<ol class="stack-panel__rows">` now.',
  },
  {
    retired: 'combat-lines',
    replacement: 'combat-arcs',
    why: 'UX-14 replaced the straight blocker segments with fiery arcs; `CombatLines.tsx` emits `.combat-arcs`.',
  },
];

/**
 * A selector in the retired family: a literal `.` then the retired name, then
 * anything that is still part of a class name (`__kind`, `--top`). The `.` is
 * required so a module specifier — `lib/play/combat-lines.js` — is not mistaken
 * for a rule; a `/` before the name never satisfies it.
 */
function selectorPattern(name: string): RegExp {
  return new RegExp(`\\.${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}[-\\w]*`, 'u');
}

/**
 * The name inside a string literal, e.g. `className="stack-item"`. The
 * lookbehind excludes a path segment (`play/combat-lines.js`) and a longer
 * identifier that merely ends with the name.
 */
function usagePattern(name: string): RegExp {
  return new RegExp(`(?<![/\\w-])${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\w-])`, 'u');
}

const STYLESHEETS = sources('.css');
const COMPONENTS = sources('.tsx');

describe('the walkers found something to check (never vacuously green)', () => {
  it('reads the app stylesheets and components', () => {
    expect(STYLESHEETS.length).toBeGreaterThan(5);
    expect(COMPONENTS.length).toBeGreaterThan(20);
    expect(STYLESHEETS.map(([path]) => path)).toContain('styles.css');
  });
});

describe.each(RETIRED_NAMES.map((row) => [row.retired, row] as const))(
  'retired: .%s',
  (_name, row) => {
    it('no stylesheet still declares it', () => {
      const pattern = selectorPattern(row.retired);
      const offenders = STYLESHEETS.filter(([, text]) => pattern.test(text)).map(([path]) => path);
      // Dead rules read as live styling to the next person who opens the file.
      // ${row.why}
      expect(offenders, row.why).toEqual([]);
    });

    it('no component still emits it', () => {
      const pattern = usagePattern(row.retired);
      const offenders = COMPONENTS.filter(([, text]) => pattern.test(text)).map(([path]) => path);
      // The mirror failure: an element wearing a class nothing styles.
      expect(offenders, row.why).toEqual([]);
    });

    it('its replacement is still there — the feature did not go with it', () => {
      const pattern = selectorPattern(row.replacement);
      expect(
        STYLESHEETS.some(([, text]) => pattern.test(text)),
        `.${row.replacement} is gone too — this row would then be green for the wrong reason`,
      ).toBe(true);
    });
  },
);
