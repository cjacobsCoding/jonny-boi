/**
 * NO HARNESS MAY DRIVE A PAGE WITHOUT LISTENING FOR WHAT IT THROWS.
 *
 * ## The defect this exists for
 *
 * A data harness reported that the card browser was **missing 8 cards**. All 8
 * were in the pool. They were missing because the React tree had thrown
 * `Minified React error #185` and unmounted, so `#root` was empty and every
 * selector the harness looked for was genuinely absent. The harness was
 * measuring a corpse and filed a bug against the corpus — and the real defect,
 * a feedback loop in the card grid's virtualiser, went unattributed.
 *
 * That is not one harness's mistake, it is a SHAPE. A harness that does not
 * listen for `pageerror` cannot distinguish "the app crashed" from "the thing I
 * am measuring is not on screen", so it will always report the second, because
 * the second is the question it was written to ask. When this was written, of
 * eleven scripts in `apps/web/scripts/` that drive a page:
 *
 *   captured AND failed on it   bug-reporter, card-browser-perf   (2)
 *   captured, only printed it   announcement-queue, game-resume,
 *                               mana-choice, see-online-board      (4)
 *   never listened at all       board-fits, combat-visibility,
 *                               deck-identity, forced-choice       (4)
 *
 * Nine of eleven could have filed that same wrong report.
 *
 * ## What this proves, and what it does not
 *
 * It proves every page-driving script routes through `lib/harness-page.mjs`, and
 * that every script with a pass/fail verdict turns a thrown page into a FAILED
 * CHECK rather than a printed line. It cannot prove the assertion is in the
 * right place in the run, or that the harness drove anything meaningful — only
 * running one does that. The value is that a NEW harness cannot be blind by
 * omission, which is exactly how all four of the blind ones arrived.
 *
 * The scripts are plain `.mjs` outside the vitest include glob and are never
 * imported, so this reads them as TEXT — the only way to see them at all. Same
 * idiom as `harness-chrome-launch.test.ts`, whose funnel this one mirrors.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
const SHARED_WATCHER = 'harness-page.mjs';

/**
 * Scripts that drive a browser page — discovered by what they DO (they open a
 * page), never by a hand-kept list, so a new one is covered the day it lands.
 */
function pageDrivers(): readonly { name: string; source: string }[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((n) => n.endsWith('.mjs'))
    .map((name) => ({ name, source: readFileSync(join(SCRIPTS_DIR, name), 'utf8') }))
    .filter((f) => /\.newPage\(\)/.test(f.source));
}

/** Source with comments stripped, so prose about `pageerror` is not mistaken for code. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Does this script render a PASS/FAIL verdict? Those must fail on a throw.
 *
 * `see-online-board.mjs` deliberately does not: it is an observation script a
 * person reads, with no checks and no meaningful exit code. It still has to go
 * through the funnel — the printing is the same question — but there is nothing
 * for it to fail.
 */
function hasVerdict(source: string): boolean {
  return /\bchecks\b/.test(source) || /\bfailures\b/.test(source);
}

describe('every browser harness sees what the page throws', () => {
  it('finds the page-driving scripts — the sweep cannot go vacuous', () => {
    const names = pageDrivers().map((f) => f.name);
    // The four that were completely blind, named so that deleting the listener
    // from any of them fails HERE rather than silently shrinking the sweep.
    expect(names).toContain('verify-board-fits.mjs');
    expect(names).toContain('verify-combat-visibility.mjs');
    expect(names).toContain('verify-deck-identity.mjs');
    expect(names).toContain('verify-forced-choice.mjs');
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it('every page-driving script routes through the shared watcher', () => {
    const offenders = pageDrivers()
      .filter((f) => !code(f.source).includes('watchPageErrors('))
      .map((f) => f.name);
    expect(
      offenders,
      'These scripts open a page without listening for what it throws, so a crash ' +
        'in the app will be reported as whatever they failed to find. Import ' +
        `watchPageErrors from ./lib/${SHARED_WATCHER} and use it at the point the ` +
        'page is created.',
    ).toEqual([]);
  });

  it('no script hand-rolls its own pageerror listener any more', () => {
    const offenders = pageDrivers()
      .filter((f) => /\.on\(\s*['"]pageerror['"]/.test(code(f.source)))
      .map((f) => f.name);
    expect(
      offenders,
      `A second listener is a second answer to one question. ${SHARED_WATCHER} is ` +
        'the funnel; pass it a `label` if the script drives more than one page.',
    ).toEqual([]);
  });

  it('a script with a verdict FAILS on a throw — it does not merely print one', () => {
    const offenders: string[] = [];
    for (const f of pageDrivers()) {
      if (!hasVerdict(f.source)) continue;
      const c = code(f.source);
      // The watcher's errors must reach a check/failure, not just a console.log.
      // Both spellings are accepted because the harnesses differ in whether they
      // keep the watcher or destructure its array.
      const asserted =
        /check\([^;]*(watcher\.errors|pageErrors|replayErrors)/s.test(c) ||
        /(watcher\.errors|pageErrors|replayErrors)[^;]*\.length === 0/s.test(c) ||
        /assertPageAlive\(/.test(c);
      if (!asserted) offenders.push(f.name);
    }
    expect(
      offenders,
      'These scripts capture what the page throws and then do not act on it. A ' +
        'printed pageerror scrolls past; a failed check is what stops a wrong ' +
        'report being filed against the data.',
    ).toEqual([]);
  });

  it('the shared watcher still does both halves — the throw AND the silent page', () => {
    const shared = readFileSync(join(SCRIPTS_DIR, 'lib', SHARED_WATCHER), 'utf8');
    expect(shared).toContain("'pageerror'");
    // An unmounted tree throws once and is then quiet, so "nothing threw" is not
    // the same question as "the app is still there". Both must exist.
    expect(shared).toMatch(/export async function assertPageAlive/);
    expect(shared).toMatch(/childElementCount/);
  });
});
