/**
 * NO HARNESS MAY LAUNCH ITS OWN CHROME.
 *
 * ## The request this exists for
 * Caleb, 2026-09-14: *"when running game tests, they dont show up and take focus
 * and are muted audio-wise? So they dont conflict with real things that Im
 * working on"*. The harnesses drive a REAL browser playing the REAL game, and
 * the game makes noise, so a verification run was audible over whatever the
 * machine was actually doing.
 *
 * ## Why a guard and not just the flag
 * The five harnesses had five different hand-rolled argument lists and **not one
 * of them muted audio**. Adding `--mute-audio` five times would have been the
 * same mistake a sixth time — the next harness would have arrived without it,
 * exactly as `verify-mana-choice.mjs` arrived without the named wait budget its
 * sibling had just been given (see `harness-wait-budgets.test.ts`, same shape,
 * same week). So the launch is one funnel and this test is what keeps it one.
 *
 * ## What it proves and what it does not
 * It proves every harness launches through `harnessLaunchOptions`, and that the
 * shared list still carries the flags that make a run quiet. It cannot prove the
 * machine stayed silent — only a person listening can. That is an honest limit,
 * not a gap to paper over: the value here is that a NEW harness cannot be noisy
 * by omission.
 *
 * The harnesses are plain `.mjs` outside the vitest include glob and are never
 * imported, so this reads them as TEXT — the only way to see them at all.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
const SHARED_LAUNCHER = 'harness-chrome.mjs';

/**
 * Flags whose ABSENCE would put a sound or a window in front of the user. Each
 * row says what it prevents, so a future reader can judge whether to remove it
 * rather than guessing.
 */
const REQUIRED_FLAGS: ReadonlyMap<string, string> = new Map([
  ['--mute-audio', 'the game plays sounds; a test run must not be audible'],
  ['--no-first-run', 'a first-run tab is a window, and a window can take focus'],
  ['--no-default-browser-check', 'the default-browser prompt is a focus-stealing dialog'],
]);

/** Every browser harness — discovered, never listed, so a new one is covered. */
function harnesses(): readonly { name: string; source: string }[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((n) => n.startsWith('verify-') && n.endsWith('.mjs'))
    .map((name) => ({ name, source: readFileSync(join(SCRIPTS_DIR, name), 'utf8') }));
}

/** Source with comments stripped, so prose about a flag is never mistaken for one. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('browser harness Chrome launches', () => {
  it('finds every harness — the sweep cannot go vacuous', () => {
    const names = harnesses().map((h) => h.name);
    expect(names).toContain('verify-board-fits.mjs');
    expect(names).toContain('verify-combat-visibility.mjs');
    expect(names.length).toBeGreaterThanOrEqual(5);
  });

  it('every harness launches through the shared options builder', () => {
    const offenders = harnesses()
      .filter((h) => !code(h.source).includes('harnessLaunchOptions('))
      .map((h) => h.name);
    expect(
      offenders,
      'These harnesses build their own puppeteer.launch options, so they will miss ' +
        `--mute-audio and the focus-suppressing flags. Import harnessLaunchOptions from ` +
        `./lib/${SHARED_LAUNCHER} and pass harness-specific flags via its \`extra\` parameter.`,
    ).toEqual([]);
  });

  it('no harness hand-rolls headless or an args array of its own', () => {
    const offenders: string[] = [];
    for (const h of harnesses()) {
      const c = code(h.source);
      // `headless:` and `args:` belong to the shared builder now. A harness that
      // sets either is launching on its own terms again, which is the exact
      // divergence this funnel removed.
      if (/headless\s*:/.test(c)) offenders.push(`${h.name}: sets headless: itself`);
      if (/puppeteer\.launch\(\s*\{/.test(c)) offenders.push(`${h.name}: passes an inline launch object`);
    }
    expect(offenders).toEqual([]);
  });

  it('the shared launcher still carries every quiet-run flag', () => {
    const shared = readFileSync(join(SCRIPTS_DIR, 'lib', SHARED_LAUNCHER), 'utf8');
    for (const [flag, why] of REQUIRED_FLAGS) {
      expect(shared, `${SHARED_LAUNCHER} must pass ${flag} — ${why}`).toContain(flag);
    }
  });

  it('a headful run is still possible, and is still muted', () => {
    const shared = readFileSync(join(SCRIPTS_DIR, 'lib', SHARED_LAUNCHER), 'utf8');
    // `--headful` on the bug reporter exists so a human can WATCH it work.
    // Wanting to see a window is not wanting to hear it, so the mute must not
    // live behind the headless branch.
    expect(shared).toMatch(/headful/);
    const muteLine = shared.indexOf('--mute-audio');
    const headlessLine = shared.indexOf('headless:');
    expect(muteLine).toBeGreaterThan(-1);
    expect(
      muteLine < headlessLine,
      '--mute-audio must be an unconditional flag, not applied only on the headless branch',
    ).toBe(true);
  });
});
