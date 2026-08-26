/**
 * STYLESHEET REGRESSION PINS FOR THE TESTMEBRO FINDINGS TMB-JB-0001..0004.
 *
 * Layout and paint cannot be asserted in a Node test, so each fix here is
 * pinned at the seam that CAN be: the design-token arithmetic (WCAG ratios
 * computed from the committed palette) and the specific stylesheet structure
 * the fix hangs on. `tmb verify` re-captures the pixels; these tests make the
 * regression LOUD before anything is captured — a token darkened below a
 * floor, or a rule deleted in a refactor, fails here with the finding id in
 * the message.
 *
 * The parsing is deliberately dumb (strip comments, split on braces): it only
 * has to find named blocks in stylesheets this repo owns, not parse CSS.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  WCAG_AA_BODY_TEXT_MIN,
  WCAG_AA_NON_TEXT_MIN,
  contrastRatio,
} from './lib/contrast.js';

/** Read a stylesheet relative to this file, newline- and comment-agnostic. */
function readStylesheet(relativePath: string): string {
  const raw = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
  // CRLF trap (CLAUDE.md): committed files are CRLF on Windows checkouts, LF
  // in git. Normalize before any string matching. Comments go too, so a
  // declaration mentioned in prose can never satisfy an assertion.
  return raw.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
}

interface CssRule {
  readonly selector: string;
  readonly declarations: string;
}

/**
 * Flatten a stylesheet into (selector, declarations) pairs. One level of
 * at-rule nesting (media queries) is enough for these files.
 */
function cssRules(source: string): CssRule[] {
  const rules: CssRule[] = [];
  for (const chunk of source.split('}')) {
    const open = chunk.lastIndexOf('{');
    if (open === -1) continue;
    const head = chunk.slice(0, open);
    const previousOpen = head.lastIndexOf('{');
    const selector = (previousOpen === -1 ? head : head.slice(previousOpen + 1)).trim();
    if (selector.length === 0) continue;
    rules.push({ selector, declarations: chunk.slice(open + 1) });
  }
  return rules;
}

/** Every rule whose selector list names `selector` exactly (after splitting on commas). */
function rulesFor(rules: CssRule[], selector: string): CssRule[] {
  return rules.filter((rule) => rule.selector.split(',').some((s) => s.trim() === selector));
}

const styles = readStylesheet('./styles.css');
const styleRules = cssRules(styles);
const aboutRules = cssRules(readStylesheet('./views/about.css'));
const bugReporterRules = cssRules(readStylesheet('./components/bug-reporter.css'));

/** The named palette tokens, lifted from `:root` — the same values the app paints with. */
function token(name: string): string {
  const root = rulesFor(styleRules, ':root')[0];
  expect(root, ':root token block missing from styles.css').toBeDefined();
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`).exec(root!.declarations);
  expect(match, `token ${name} missing (or no longer a plain hex) in :root`).not.toBeNull();
  return match![1]!;
}

describe('TMB-JB-0003 — the card-pool count clears the body-text floor', () => {
  it('sets .result-count in the muted tone, never the faint one', () => {
    const blocks = rulesFor(styleRules, '.result-count');
    expect(blocks.length).toBeGreaterThan(0);
    expect(
      blocks[0]!.declarations,
      'TMB-JB-0003: the pool count is the only number on the toolbar; it filed at 3.88:1 ' +
        'because it used --color-fg-faint. Keep it on --color-fg-muted (or lighter).',
    ).toMatch(/color:\s*var\(--color-fg-muted\)/);
    for (const block of blocks) {
      expect(block.declarations).not.toMatch(/color:\s*var\(--color-fg-faint\)/);
    }
  });

  it('keeps the muted token itself above 4.5:1 on the grounds the count sits over', () => {
    const muted = token('--color-fg-muted');
    for (const groundToken of ['--color-bg', '--color-surface'] as const) {
      const ratio = contrastRatio(muted, token(groundToken));
      expect(
        ratio,
        `TMB-JB-0003: --color-fg-muted vs ${groundToken} is ${ratio.toFixed(2)}:1 — ` +
          `body text (the ~9px pool count) needs ${WCAG_AA_BODY_TEXT_MIN}:1.`,
      ).toBeGreaterThanOrEqual(WCAG_AA_BODY_TEXT_MIN);
    }
  });
});

describe('TMB-JB-0004 — the bug-reporter launcher is findable without being known about', () => {
  const launcher = rulesFor(bugReporterRules, '.bugreport-launcher')[0];

  it('never dims itself back below the contrast floors with opacity', () => {
    expect(launcher).toBeDefined();
    expect(
      launcher!.declarations,
      'TMB-JB-0004: `opacity: 0.45` is what composited the launcher to 1.09:1 against the ' +
        'page and its icon to 2.27:1 against its own fill. Quiet must come from the token ' +
        'choices, not from an opacity that multiplies every ratio down.',
    ).not.toMatch(/opacity\s*:/);
  });

  it('draws its ring and icon from tokens that clear the 3:1 non-text floor', () => {
    expect(launcher!.declarations).toMatch(/border:.*var\(--color-fg-faint\)/);
    expect(launcher!.declarations).toMatch(/color:\s*var\(--color-fg-muted\)/);

    const ring = token('--color-fg-faint');
    const fill = token('--color-surface-raised');
    const icon = token('--color-fg-muted');
    const page = token('--color-bg');
    const checks: Array<[string, number]> = [
      ['ring vs page', contrastRatio(ring, page)],
      ['ring vs its own fill', contrastRatio(ring, fill)],
      ['icon dots vs fill', contrastRatio(icon, fill)],
    ];
    for (const [what, ratio] of checks) {
      expect(
        ratio,
        `TMB-JB-0004: launcher ${what} is ${ratio.toFixed(2)}:1 — WCAG 1.4.11 needs ` +
          `${WCAG_AA_NON_TEXT_MIN}:1 for non-text UI parts.`,
      ).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_MIN);
    }
  });
});

describe('TMB-JB-0001 — the About stat values share one baseline', () => {
  it('pins each value to the tile bottom instead of letting it ride the label height', () => {
    const tile = rulesFor(aboutRules, '.about__stat')[0];
    const value = rulesFor(aboutRules, '.about__stat dd')[0];
    expect(tile).toBeDefined();
    expect(value).toBeDefined();
    expect(
      tile!.declarations,
      'TMB-JB-0001: the tile must be a flex column for the value’s auto margin to have ' +
        'slack to eat; without it one-line labels float their numbers a line high.',
    ).toMatch(/flex-direction:\s*column/);
    expect(value!.declarations, 'TMB-JB-0001: the value bottom-pins via margin: auto 0 0.').toMatch(
      /margin:\s*auto\s+0\s+0/,
    );
  });
});

describe('TMB-JB-0002 — a clipped nav strip says so', () => {
  it('keeps the overflow cues as long as the phone strip hides its scrollbar', () => {
    const strip = rulesFor(styleRules, '.app__nav').find((rule) =>
      /scrollbar-width:\s*none/.test(rule.declarations),
    );
    expect(
      strip,
      'The phone nav strip no longer hides its scrollbar — if that is deliberate, ' +
        'rethink whether the fade/chevron cues below are still the only overflow signal.',
    ).toBeDefined();

    // The strip is only honest because these exist: an edge that still hides
    // tabs fades out under a chevron. Both cues live on .app__nav-wrap--more-*.
    const endFade = rulesFor(styleRules, '.app__nav-wrap--more-end .app__nav')[0];
    expect(
      endFade,
      'TMB-JB-0002: the trailing-edge fade rule is gone; a hidden-scrollbar strip then ' +
        'ends in flat background again and every tab past the fold is undiscoverable.',
    ).toBeDefined();
    expect(endFade!.declarations).toMatch(/mask-image:/);
    expect(rulesFor(styleRules, '.app__nav-wrap--more-end::after')[0]?.declarations).toMatch(
      /content:/,
    );
    expect(rulesFor(styleRules, '.app__nav-wrap--more-start::before')[0]?.declarations).toMatch(
      /content:/,
    );
  });

  it('keeps the chevrons legible as graphics (3:1) against the page', () => {
    const ratio = contrastRatio(token('--color-fg-muted'), token('--color-bg'));
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_MIN);
  });
});
