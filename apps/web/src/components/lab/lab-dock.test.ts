/**
 * THE LAB'S PINNED PROGRESS DOCK (DESIGN §3.180) — pinned at the seams a Node
 * test can actually reach.
 *
 * > "in all the Lab subtabs, make the loading bar get pinned to the bottom of
 * >  the screen while in that area while its working on a lab, so you can scroll
 * >  around and still watch the progress."
 *
 * ⚠️ WHAT THIS FILE CANNOT DO, SAID PLAINLY. There is no DOM in this suite —
 * the root `vitest.config.ts` sets no `environment`, so tests run in `node`, and
 * jsdom/happy-dom/@testing-library are not dependencies. `getComputedStyle` and
 * `getBoundingClientRect` do not exist here and CSS files are never loaded, so
 * **the on-screen rectangle cannot be asserted in this file** and nothing here
 * pretends otherwise. That check lives in
 * `apps/web/scripts/verify-lab-progress-dock.mjs`, which drives a real browser.
 *
 * What IS checkable here, and is:
 *  1. the DECLARATIONS, read out of the stylesheet as text (comments stripped,
 *     so a rule described in prose can never satisfy an assertion);
 *  2. the stacking order against the other bottom-fixed elements, all named;
 *  3. the STRUCTURE of the render site — that the dock is owned by the shell and
 *     sits outside every per-tab branch, which is what makes "in all the Lab
 *     subtabs" true for a seventh tab nobody has written yet.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LAB_TABS } from '../../lib/useLabSelection.js';

/** Read a file relative to this one, CRLF- and comment-agnostic. */
function readStylesheet(relativePath: string): string {
  const raw = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
  // CRLF trap (CLAUDE.md): committed files are CRLF on a Windows checkout and LF
  // in git, so normalise before matching. Comments go too — a declaration named
  // in a comment must not be able to satisfy an assertion about the rule.
  return raw.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
}

interface CssRule {
  readonly selector: string;
  readonly declarations: string;
}

/** Flatten a stylesheet into (selector, declarations) pairs. */
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

function rulesFor(rules: CssRule[], selector: string): CssRule[] {
  return rules.filter((rule) => rule.selector.split(',').some((s) => s.trim() === selector));
}

/** The first `z-index: <n>` in a rule, as a number — or NaN if it declares none. */
function zIndexOf(rules: CssRule[], selector: string): number {
  const blocks = rulesFor(rules, selector);
  expect(blocks.length, `no rule for ${selector}`).toBeGreaterThan(0);
  for (const block of blocks) {
    const match = /z-index:\s*([0-9]+)\s*;/.exec(block.declarations);
    if (match?.[1]) return Number(match[1]);
  }
  return Number.NaN;
}

const styles = readStylesheet('../../styles.css');
const styleRules = cssRules(styles);
const bugReporterRules = cssRules(readStylesheet('../bug-reporter.css'));
const updatePillRules = cssRules(readStylesheet('../update-pill.css'));

/**
 * A numeric custom property lifted from `:root` — the leading number, with any
 * CSS unit discarded (`--lab-dock-z: 85`, `--lab-dock-reserve: 7rem`).
 */
function numericToken(name: string): number {
  const root = rulesFor(styleRules, ':root')[0];
  expect(root, ':root token block missing from styles.css').toBeDefined();
  const match = new RegExp(`${name}:\\s*(-?[0-9.]+)[a-z%]*\\s*;`).exec(root?.declarations ?? '');
  expect(match, `token ${name} missing (or no longer a plain number) in :root`).not.toBeNull();
  return Number(match?.[1]);
}

const labViewSource = readFileSync(
  fileURLToPath(new URL('../../views/LabView.tsx', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');

/** LabView with its comments stripped — so a claim in a comment proves nothing. */
const labViewCode = labViewSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('§3.180 acceptance 1 — the dock is pinned to the foot of the viewport', () => {
  it('declares position: fixed and bottom: 0, spanning the width', () => {
    const dock = rulesFor(styleRules, '.lab-dock');
    expect(dock.length, '.lab-dock has no rule in styles.css').toBe(1);
    const declarations = dock[0]?.declarations ?? '';
    expect(declarations).toMatch(/position:\s*fixed\s*;/);
    expect(declarations).toMatch(/bottom:\s*0\s*;/);
    expect(declarations).toMatch(/left:\s*0\s*;/);
    expect(declarations).toMatch(/right:\s*0\s*;/);
  });

  it('is opaque, so the content scrolling under it does not show through', () => {
    // A transparent dock over scrolling text is illegible, which is the same
    // defect as not pinning it at all — the progress becomes unreadable.
    const declarations = rulesFor(styleRules, '.lab-dock')[0]?.declarations ?? '';
    expect(declarations).toMatch(/background:\s*var\(--color-surface\)\s*;/);
  });
});

describe('§3.180 acceptance 3 — absent when idle, and never covering the last row', () => {
  it('the Lab reserves room for the dock only while one is up', () => {
    const docked = rulesFor(styleRules, '.lab--docked');
    expect(docked.length, '.lab--docked has no rule — the last row would sit under the bar').toBe(1);
    expect(docked[0]?.declarations).toMatch(/padding-bottom:\s*var\(--lab-dock-reserve\)\s*;/);
    // The reserve must actually reserve something.
    expect(numericToken('--lab-dock-reserve')).toBeGreaterThan(0);
    // ...and the plain `.lab` must NOT carry it, or the Match view and an idle
    // Lab would both have a permanent gap at the bottom of the page.
    const plain = rulesFor(styleRules, '.lab');
    expect(plain.length).toBe(1);
    expect(plain[0]?.declarations ?? '').not.toMatch(/padding-bottom/);
  });

  it('the dock renders only while a job is running — absent, not an empty bar', () => {
    // The guard is the shell's own condition. If the dock ever renders
    // unconditionally, an idle Lab grows a blank bar across the bottom.
    expect(labViewCode).toMatch(/const running = sim\.status === 'running';/);
    expect(labViewCode).toMatch(/\{running && \(\s*<div className="lab-dock">/);
    expect(labViewCode).toMatch(/className=\{running \? 'lab lab--docked' : 'lab'\}/);
  });
});

describe('§3.180 acceptance 4 — the contested bottom of the viewport', () => {
  it('sits below the bug reporter and above the update pill, all three named', () => {
    const dockZ = numericToken('--lab-dock-z');
    const launcherZ = zIndexOf(bugReporterRules, '.bugreport-launcher');
    const lastLinkZ = zIndexOf(bugReporterRules, '.bugreport-lastlink');
    const pillZ = zIndexOf(updatePillRules, '.update-pill');

    expect(Number.isNaN(dockZ)).toBe(false);
    // A run in flight must never be the reason a bug about it cannot be filed.
    expect(dockZ, 'the dock would cover the bug reporter').toBeLessThan(launcherZ);
    expect(dockZ, 'the dock would cover the last-report link').toBeLessThan(lastLinkZ);
    // ...and a pill over the Cancel button would trap a long run.
    expect(dockZ, 'the update pill would cover the dock').toBeGreaterThan(pillZ);
    // The dock's own rule must actually USE the token, not a bare literal.
    expect(rulesFor(styleRules, '.lab-dock')[0]?.declarations).toMatch(/z-index:\s*var\(--lab-dock-z\)\s*;/);
  });

  it('does not break the bug reporter’s capture policy: the dock is NOT portalled', () => {
    // `lib/bugreport/capture-policy.ts` prunes the trailing run of below-the-fold
    // children per parent, and a boxed in-viewport LAST child freezes that
    // pruning — the regression that made one capture take 11 seconds. Fixed
    // positioning is visual; where the node sits in the tree is what the capture
    // reads. So the dock must stay inside `.lab`, followed by `.lab-panel`.
    expect(labViewCode, 'a portalled dock would become the last child of body').not.toMatch(/createPortal/);
    const dockAt = labViewCode.indexOf('className="lab-dock"');
    const panelAt = labViewCode.indexOf('className="lab-panel"');
    expect(dockAt).toBeGreaterThan(-1);
    expect(panelAt).toBeGreaterThan(-1);
    expect(dockAt, 'the dock must precede .lab-panel so the panel stays prunable').toBeLessThan(panelAt);
  });

  it('pins the Lab’s bar only — the Match view shares RunStatus and must not move', () => {
    // `MatchView` mounts the same component under a root that is also `.lab`.
    // Pinning `.run-status` itself would have pinned the Match view's bar too.
    const runStatusRule = rulesFor(styleRules, '.run-status')[0]?.declarations ?? '';
    expect(runStatusRule, 'RunStatus itself must stay unpinned — MatchView renders it too').not.toMatch(
      /position:\s*fixed/,
    );
    const matchView = readFileSync(
      fileURLToPath(new URL('../../views/MatchView.tsx', import.meta.url)),
      'utf8',
    );
    expect(matchView).toContain('<RunStatus');
    expect(matchView, 'the Match view has not opted into the Lab dock').not.toContain('lab-dock');
  });
});

describe('§3.180 acceptance 2 — every Lab subtab gets the dock', () => {
  it('the tab registry is the ONE list, and the id union derives from it', () => {
    expect(LAB_TABS.length).toBeGreaterThan(1);
    // The duplicate hand-written union is gone: LabView must import the registry
    // rather than declaring a second copy of it.
    expect(labViewCode).toMatch(/import \{ LAB_TABS \} from '\.\.\/lib\/useLabSelection\.js';/);
    expect(labViewCode, 'LabView declared its own tab list again').not.toMatch(/const LAB_TABS\s*=/);
  });

  it('the dock is rendered by the SHELL, outside every per-tab branch', () => {
    // ⚠️ THIS IS THE GUARD, and it enumerates the registry rather than naming
    // tabs by hand. The dock is present in every subtab because it is rendered
    // once, before the tab switch, and therefore cannot be conditional on which
    // tab is showing. Move it inside a branch and this goes red for every row.
    const dockAt = labViewCode.indexOf('className="lab-dock"');
    expect(dockAt).toBeGreaterThan(-1);

    for (const { id } of LAB_TABS) {
      const branchAt = labViewCode.indexOf(`tab === '${id}'`);
      expect(branchAt, `LAB_TABS has a row for '${id}' that LabView never renders`).toBeGreaterThan(-1);
      expect(
        dockAt,
        `the dock is rendered after (or inside) the '${id}' branch, so that tab could lose it`,
      ).toBeLessThan(branchAt);
    }
  });

  it('there is exactly ONE progress bar in the Lab, and the dock wraps it', () => {
    // Four copies would drift and a fifth subtab would silently have none.
    const mounts = labViewCode.match(/<RunStatus/g) ?? [];
    expect(mounts.length, 'the Lab grew a second progress bar').toBe(1);
    expect(labViewCode).toMatch(/<div className="lab-dock">\s*<RunStatus/);
  });
});
