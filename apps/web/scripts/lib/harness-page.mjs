/**
 * ONE answer to "did the page throw, and is it still there?" — for every
 * browser harness in this app.
 *
 * ## The defect this file exists for
 *
 * A data harness reported **all 8 cards MISSING** from the card browser while
 * all 8 were in the pool. They were missing because the React tree had thrown
 * `Minified React error #185` and come down: `#root` was empty, so every
 * selector the harness looked for was genuinely absent. The harness was
 * measuring a corpse and blamed the corpus.
 *
 * That is a CLASS, not an instance. A harness that does not listen for
 * `pageerror` cannot tell "the app crashed" from "the thing I was measuring is
 * not there", and it will always report the second — because the second is the
 * question it was written to ask. Before this file, of eleven harnesses in
 * `apps/web/scripts/`:
 *
 *   captured AND failed on it   bug-reporter, card-browser-perf   (2)
 *   captured, only printed it   announcement-queue, game-resume,
 *                               mana-choice, see-online-board      (4)
 *   never listened at all       board-fits, combat-visibility,
 *                               deck-identity, forced-choice       (4)
 *
 * Eight of eleven could have filed the same wrong report. So the listener is a
 * funnel rather than four more copies of `page.on('pageerror', …)` (rule 12),
 * and `harness-page-errors.test.ts` fails if a harness that drives a page stops
 * going through it.
 *
 * ## What "a silent page" means
 *
 * An uncaught error is only the loud half. React unmounts the tree on an error
 * it cannot recover from, and the result is a page that is *serving fine*,
 * *answering DevTools fine*, and has nothing in it. `assertPageAlive` is the
 * other half: a harness that finds no element it was looking for must be able
 * to say WHY — the app is gone — rather than reporting an absence as data.
 */

/**
 * Start recording everything the page throws.
 *
 * Errors are printed the moment they arrive, not only in a summary: a run where
 * the React tree threw and came down looked, in a summary, like a page whose
 * nav buttons had simply gone missing, and that sent one diagnosis off in
 * entirely the wrong direction until the error itself was read.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {object} [opts]
 * @param {string} [opts.label] prefix for the printed lines, when a harness
 *   drives more than one page (host/guest, app/replay).
 * @param {boolean} [opts.consoleErrors] also record `console.error` output.
 *   Off by default: a failed Scryfall image logs one, and that is not a crash.
 * @returns {{errors: string[], consoleErrors: string[], drain: () => string[],
 *   assertNone: (what: string) => void}}
 *   `drain` returns everything seen since the last call, so a stepping harness
 *   can attribute a throw to the step that caused it; `assertNone` throws if
 *   anything at all has been seen.
 */
export function watchPageErrors(page, { label = '', consoleErrors = false } = {}) {
  const tag = label ? `[${label}] ` : '';
  const errors = [];
  const consoleErrorTexts = [];
  let drainedTo = 0;
  page.on('pageerror', (error) => {
    errors.push(String(error));
    console.log(`  ${tag}PAGE ERROR: ${String(error).slice(0, 300)}`);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    consoleErrorTexts.push(msg.text());
    if (consoleErrors) console.log(`  ${tag}CONSOLE ERROR: ${msg.text().slice(0, 300)}`);
  });
  return {
    errors,
    consoleErrors: consoleErrorTexts,
    drain() {
      const fresh = errors.slice(drainedTo);
      drainedTo = errors.length;
      return fresh;
    },
    assertNone(what) {
      if (errors.length === 0) return;
      throw new Error(`the page threw during ${what}: ${errors.join(' | ')}`);
    },
  };
}

/**
 * Is the app still mounted?
 *
 * Reads the two things whose absence means "the tree came down" rather than
 * "this feature is not on screen": `#root` has children, and the app shell's
 * nav exists. Both are structural — every view in this app renders inside them
 * — so a harness can call this after any step without knowing what that step
 * was supposed to produce.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<{alive: boolean, rootChildren: number, navButtons: number, bodyTextChars: number}>}
 */
export async function readPageLiveness(page) {
  return page.evaluate(() => {
    const root = document.getElementById('root');
    return {
      rootChildren: root ? root.childElementCount : 0,
      navButtons: document.querySelectorAll('.app__nav button').length,
      bodyTextChars: (document.body.textContent ?? '').trim().length,
      alive: !!root && root.childElementCount > 0,
    };
  });
}

/**
 * Fail with the RIGHT reason when the app is gone.
 *
 * The whole point: when the tree has been torn down, the message names the
 * crash and quotes it, instead of the caller going on to report that whatever
 * it was looking for could not be found.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {{errors: string[]}} watcher  from {@link watchPageErrors}
 * @param {string} what  what the harness had just done, for the message
 */
export async function assertPageAlive(page, watcher, what) {
  const live = await readPageLiveness(page);
  if (live.alive && watcher.errors.length === 0) return live;
  const why =
    watcher.errors.length > 0
      ? `the page threw: ${watcher.errors.slice(0, 3).join(' | ')}`
      : 'the page threw nothing, but #root is empty — the app unmounted silently';
  throw new Error(
    `THE APP IS NOT RUNNING after ${what} — ${why} ` +
      `(#root children ${live.rootChildren}, nav buttons ${live.navButtons}, ` +
      `body text ${live.bodyTextChars} chars)`,
  );
}
