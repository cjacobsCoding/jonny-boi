/**
 * NO BROWSER HARNESS MAY WAIT ON AN UNNAMED DEFAULT.
 *
 * ## The bug this exists for
 * `verify-mana-choice.mjs` failed on a fresh worktree with
 * `Waiting for selector '.app__nav' failed: 30000ms exceeded` — and the app was
 * fine. Puppeteer's `waitForSelector` has an unnamed 30 s default, and the
 * landing view is the 5,651-tile card browser, which pulls hundreds of
 * cross-origin Scryfall images. §3.146's gate MEASURED time-to-`.app__nav` as
 * bimodal — ~7.8 s warm, ~38.9 s cold — so against that default the harness was a
 * coin flip that reported the APP as broken when the NETWORK was slow.
 *
 * ## Why a test rather than just the fix
 * That gate found it, named the budget in `verify-game-resume.mjs`, and stopped.
 * The sibling harness kept the bare wait and failed the same way a day later.
 * That is the class-not-instance failure CLAUDE.md rule 10 is about, and the
 * remedy rule 10 prescribes is to ship the GUARD with the fix — so a *third*
 * harness cannot quietly inherit the same coin flip.
 *
 * ## What this can and cannot prove
 * It proves every `waitForSelector` in the harnesses passes an explicit timeout.
 * It cannot prove the number is big enough — only a real run on a cold cache can,
 * and that is what the harnesses themselves are for. A bare wait is nonetheless
 * always wrong here: the default is a number nobody chose, on a page whose load
 * time depends on an external host.
 *
 * The harnesses are plain `.mjs` outside the vitest include glob and are never
 * imported, so this reads them as TEXT. That is the only way to see them at all.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');

/** Every browser harness — discovered, never listed, so a new one is covered. */
function harnesses(): readonly string[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((name) => name.startsWith('verify-') && name.endsWith('.mjs'))
    .map((name) => join(SCRIPTS_DIR, name));
}

/**
 * A `waitForSelector(...)` call with no `timeout:` in its argument list.
 *
 * Matches up to the call's closing paren on one line. Harness waits are written
 * on one line throughout; a multi-line call would be missed, which is why the
 * non-vacuity test below pins that the sweep still sees every harness.
 */
const BARE_WAIT = /waitForSelector\((?![^)]*timeout:)[^)]*\)/g;

describe('browser harness wait budgets', () => {
  it('finds every harness — the sweep cannot go vacuous', () => {
    const names = harnesses().map((p) => p.split(/[\\/]/).pop());
    // If a harness is renamed, this fails before the real assertion can pass by
    // simply having nothing left to check.
    expect(names).toContain('verify-mana-choice.mjs');
    expect(names).toContain('verify-game-resume.mjs');
    expect(names).toContain('verify-board-fits.mjs');
    expect(names).toContain('verify-bug-reporter.mjs');
    expect(names.length).toBeGreaterThanOrEqual(4);
  });

  it('no harness waits for a selector on an unnamed default timeout', () => {
    const offenders: string[] = [];
    for (const file of harnesses()) {
      const name = file.split(/[\\/]/).pop() ?? file;
      const source = readFileSync(file, 'utf8');
      // Strip comments: the doc comments explaining this rule quote the very
      // call shape it forbids, and a guard that trips on its own explanation
      // teaches people to delete the guard.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const hit of code.match(BARE_WAIT) ?? []) {
        offenders.push(`${name}: ${hit.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }

    expect(
      offenders,
      'These harness waits use puppeteer’s unnamed 30s default. The landing view ' +
        'pulls hundreds of cross-origin Scryfall images and measured 38.9s cold, so a bare ' +
        'wait reports the APP as broken when the NETWORK is slow. Pass an explicit, NAMED ' +
        'budget (see APP_SHELL_WAIT_MS / LAUNCHER_WAIT_MS) rather than a literal.',
    ).toEqual([]);
  });

  it('the budgets are named constants, not inline literals', () => {
    for (const file of harnesses()) {
      const name = file.split(/[\\/]/).pop() ?? file;
      const source = readFileSync(file, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const waits = code.match(/waitForSelector\([^)]*timeout:[^)]*\)/g) ?? [];
      const inlineNumbers = waits.filter((w) => /timeout:\s*\d/.test(w));
      expect(
        inlineNumbers.map((w) => `${name}: ${w.replace(/\s+/g, ' ').slice(0, 90)}`),
        'A timeout is a tuning decision with a measured reason behind it (rule 1) — give it a ' +
          'name whose doc comment carries that reason, so the next person changing it knows what ' +
          'it was chosen against.',
      ).toEqual([]);
    }
  });
});
