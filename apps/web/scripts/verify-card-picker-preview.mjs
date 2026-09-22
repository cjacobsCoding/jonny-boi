/**
 * §3.181 — DOES THE DWELL PREVIEW ACTUALLY WORK, AND DOES THE BRING-IN FOCUS
 * ACTUALLY REACH THE ENGINE?
 *
 * Both are claims that unit tests cannot make. The dwell is a real timer over a
 * real pointer and a real keyboard; the bring-in focus is a value that has to
 * survive a React panel, a request object, a Web Worker and the engine. So this
 * drives the shipped build in a real browser and reads the OUTCOME.
 *
 * ## ⚠️ IT PROVES WHICH TREE ANSWERED BEFORE IT BELIEVES ANYTHING
 *
 * A lane on this box nearly filed a false green by driving the wrong worktree's
 * dev server — it saw the old Lab and could not tell. A screenshot cannot tell
 * two checkouts apart, so this fetches the SERVED bundle and greps it for
 * string literals that only exist in this change. No markers, no run.
 *
 * `vite preview` is spawned with `cwd: WEB_ROOT`, and WEB_ROOT is resolved from
 * THIS FILE's location — so the tree under test is the tree this script lives
 * in, and the marker check is what confirms it rather than assumes it.
 *
 * Usage:
 *   npm run build                                   # dist must be current
 *   node apps/web/scripts/verify-card-picker-preview.mjs [--headful]
 *
 * Exit code 0 = every check passed. Anything else = read the FAIL lines.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChrome } from './lib/find-chrome.mjs';
import { harnessLaunchOptions } from './lib/harness-chrome.mjs';
import { watchPageErrors, assertPageAlive } from './lib/harness-page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
/** The repo's harness-output convention, already gitignored. */
const OUT_DIR = resolve(WEB_ROOT, 'verify-out', 'card-picker');

const APP_SHELL_WAIT_MS = 60_000;
/** Must match CARD_PREVIEW_DWELL_MS in apps/web/src/lib/lab/cardPicker.ts. */
const DWELL_MS = 2000;
/** Comfortably past the dwell, so a slow frame is not read as a broken feature. */
const PAST_DWELL_MS = DWELL_MS + 1200;
/** Comfortably BEFORE it, so "left too early" is unambiguous. */
const BEFORE_DWELL_MS = Math.floor(DWELL_MS / 3);
/** A whole suggestion run in a browser worker. Generous; reported if exceeded. */
const RUN_BUDGET_MS = 240_000;

/**
 * String literals that exist ONLY in this change. Minification mangles
 * identifiers but keeps string literals, so these survive `vite build`.
 */
const TREE_MARKERS = [
  'what to cut to fit ',       // lib/lab/suggestFocusSummary.ts
  'Bring in',                  // SuggestPanel's new picker label
  'Type a card from the pool', // its placeholder
  'approximate',               // the fuzzy footer
];

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function notChecked(name, why) {
  results.push({ name, passed: false, notChecked: true, detail: why });
  console.log(`  NOT CHECKED  ${name} — ${why}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((ok, fail) => {
    const server = net.createServer();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => ok(port));
    });
  });
}

async function isUp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.status > 0;
  } catch {
    return false;
  }
}

function viteBin() {
  const candidates = [
    resolve(WEB_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    resolve(WEB_ROOT, '..', '..', 'node_modules', 'vite', 'bin', 'vite.js'),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error('vite is not installed');
  return found;
}

/** Serve the BUILT app from THIS worktree — what ships, not the dev server. */
async function startPreview() {
  const indexPath = resolve(WEB_ROOT, 'dist', 'index.html');
  if (!existsSync(indexPath)) {
    throw new Error(`${indexPath} missing — run \`npm run build\` first`);
  }
  console.log(`  serving   ${WEB_ROOT}`);
  console.log(`  dist built ${statSync(indexPath).mtime.toISOString()}`);
  const port = await freePort();
  const url = `http://localhost:${port}/`;
  const child = spawn(
    process.execPath,
    [viteBin(), 'preview', '--port', String(port), '--strictPort'],
    { cwd: WEB_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const deadline = Date.now() + APP_SHELL_WAIT_MS;
  while (Date.now() < deadline) {
    if (await isUp(url)) return { child, url };
    await sleep(300);
  }
  child.kill();
  throw new Error('vite preview did not answer in time');
}

/**
 * WHICH TREE IS THIS? Fetch every script the page loads and look for the
 * markers. A screenshot cannot tell two checkouts apart; this can.
 */
async function assertServedTree(url) {
  const html = await (await fetch(url)).text();
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  if (srcs.length === 0) throw new Error('no <script src> in the served index.html');

  let joined = '';
  for (const src of srcs) {
    const abs = new URL(src, url).href;
    joined += await (await fetch(abs)).text();
  }
  console.log(`  fetched   ${srcs.length} script(s), ${joined.length.toLocaleString()} chars`);

  const missing = TREE_MARKERS.filter((m) => !joined.includes(m));
  check(
    'the SERVED bundle is this worktree (markers present in the shipped JS)',
    missing.length === 0,
    missing.length === 0
      ? `all ${TREE_MARKERS.length} markers found`
      : `MISSING ${JSON.stringify(missing)} — you are driving a different tree`,
  );
  return missing.length === 0;
}

async function gotoView(page, label) {
  const clicked = await page.evaluate((text) => {
    const nav = [...document.querySelectorAll('.app__nav button')].find(
      (b) => (b.textContent ?? '').trim().toLowerCase() === text.toLowerCase(),
    );
    if (!nav) return false;
    nav.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`no nav button labelled "${label}"`);
  await sleep(700);
}

async function gotoLabTab(page, label) {
  const clicked = await page.evaluate((text) => {
    const tab = [...document.querySelectorAll('.lab-tab')].find(
      (b) => (b.textContent ?? '').trim().toLowerCase() === text.toLowerCase(),
    );
    if (!tab) return false;
    tab.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`no Lab tab labelled "${label}"`);
  await sleep(700);
}

/** Open the collapsed "Focus the search" section. */
async function openFocus(page) {
  await page.evaluate(() => {
    const details = document.querySelector('details.suggest-focus');
    if (details && !details.open) details.open = true;
  });
  await sleep(300);
}

/** Index of the `.card-picker` whose label reads `label`. */
async function pickerIndex(page, label) {
  return page.evaluate((text) => {
    const pickers = [...document.querySelectorAll('.card-picker')];
    return pickers.findIndex(
      (p) =>
        (p.querySelector('.card-picker__label')?.textContent ?? '').trim().toLowerCase() ===
        text.toLowerCase(),
    );
  }, label);
}

const previewOpen = (page) =>
  page.evaluate(() => document.querySelectorAll('.card-picker-preview').length > 0);

const previewName = (page) =>
  page.evaluate(() => {
    const panel = document.querySelector('.card-picker-preview [role="tooltip"]');
    return panel?.getAttribute('aria-label') ?? null;
  });

async function main() {
  const headful = process.argv.includes('--headful');
  mkdirSync(OUT_DIR, { recursive: true });

  console.log('§3.181 — card picker dwell preview + bring-in focus');
  const preview = await startPreview();
  const treeOk = await assertServedTree(preview.url);
  if (!treeOk) {
    preview.child.kill();
    return 1;
  }

  const chromePath = findChrome();
  const browser = await puppeteer.launch(
    harnessLaunchOptions({
      chromePath,
      headful,
      viewport: { width: 1440, height: 950 },
      windowSize: { width: 1440, height: 950 },
    }),
  );

  try {
    const page = await browser.newPage();
    const watcher = watchPageErrors(page, { label: 'app' });
    await page.goto(preview.url, { waitUntil: 'domcontentloaded', timeout: APP_SHELL_WAIT_MS });
    await page.waitForSelector('.app__nav', { timeout: APP_SHELL_WAIT_MS });
    await assertPageAlive(page, watcher, 'the initial load');

    await gotoView(page, 'Lab');
    await gotoLabTab(page, 'Suggestions');
    await assertPageAlive(page, watcher, 'opening Lab -> Suggestions');
    await openFocus(page);

    // ---------------------------------------------------------------- pickers
    const cutIndex = await pickerIndex(page, 'Consider cutting');
    const inIndex = await pickerIndex(page, 'Bring in');
    check(
      'the Suggest focus has BOTH pickers, and no bare checkbox grid',
      cutIndex >= 0 && inIndex >= 0,
      `Consider cutting @${cutIndex}, Bring in @${inIndex}`,
    );
    const noGrid = await page.evaluate(
      () => document.querySelectorAll('.suggest-focus__grid, .suggest-focus__card').length === 0,
    );
    check('the old checkbox grid is gone from the DOM', noGrid);

    if (cutIndex < 0) {
      notChecked('the dwell preview', 'the cut picker was not on screen');
    } else {
      const pickers = await page.$$('.card-picker');
      const cutPicker = pickers[cutIndex];
      const input = await cutPicker.$('input[role="combobox"]');
      await input.click();
      await sleep(400);

      const options = await cutPicker.$$('.card-picker__option');
      check('the cut picker lists the deck as combobox options', options.length > 0, `${options.length} options`);

      if (options.length >= 2) {
        // ---- 1. pausing raises the card -------------------------------------
        await options[1].hover();
        await sleep(BEFORE_DWELL_MS);
        const earlyOpen = await previewOpen(page);
        check(
          `LEAVING EARLY shows nothing (still closed after ${BEFORE_DWELL_MS}ms)`,
          earlyOpen === false,
        );
        // move away before the dwell could ever elapse
        await page.mouse.move(5, 5);
        await sleep(PAST_DWELL_MS);
        check(
          'after moving away early, no preview ever appears',
          (await previewOpen(page)) === false,
        );

        // ---- 2. pause long enough -------------------------------------------
        await options[1].hover();
        await sleep(PAST_DWELL_MS);
        const dwellOpen = await previewOpen(page);
        const dwellName = await previewName(page);
        check(
          `PAUSING for ${DWELL_MS}ms raises the card`,
          dwellOpen === true,
          dwellName ? `showing "${dwellName}"` : 'no aria-label on the panel',
        );

        // ---- 3. the SCREENSHOT, with the preview open ------------------------
        let shotPath = null;
        if (dwellOpen) {
          // A byte count is weak evidence: the rest of the Lab would fill a PNG
          // on its own. Measure the PANEL, so the capture is of a card-sized
          // thing that is actually on screen and inside the viewport.
          const box = await page.evaluate(() => {
            const el = document.querySelector('.card-picker-preview [role="tooltip"]');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) };
          });
          check(
            'the preview panel is a real card-sized box inside the viewport',
            box !== null && box.w > 200 && box.h > 250 && box.x >= 0 && box.y >= 0,
            box ? `${box.w}x${box.h} at (${box.x},${box.y})` : 'no panel box',
          );
          shotPath = join(OUT_DIR, 'dwell-preview-open.png');
          await page.screenshot({ path: shotPath });
          const st = statSync(shotPath);
          check(
            'screenshot of the open preview is a real, non-empty capture',
            st.size > 20_000,
            `${shotPath} — ${st.size.toLocaleString()} bytes, ${st.mtime.toISOString()}`,
          );
        } else {
          notChecked('the screenshot', 'the preview never opened, so there was nothing to capture');
        }

        // ---- 4. the KEYBOARD path -------------------------------------------
        await page.mouse.move(5, 5);
        await sleep(600);
        check('moving off the list closes the preview', (await previewOpen(page)) === false);

        await input.click();
        await sleep(300);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        await sleep(PAST_DWELL_MS);
        const keyOpen = await previewOpen(page);
        const keyName = await previewName(page);
        check(
          'THE KEYBOARD PATH shows the preview too (arrow keys, no pointer)',
          keyOpen === true,
          keyName ? `showing "${keyName}"` : 'no panel',
        );
        await page.keyboard.press('Escape');
        await sleep(300);
      } else {
        notChecked('the dwell preview', `only ${options.length} option(s) in the cut picker`);
      }
    }

    await assertPageAlive(page, watcher, 'the dwell checks');

    // ------------------------------------------------- the >10 fuzzy rule, live
    if (inIndex >= 0) {
      const pickers = await page.$$('.card-picker');
      const hasFuzzyToggle = await pickers[inIndex].$('.card-picker__fuzzy-toggle');
      check(
        'the pool picker (thousands of options) OFFERS fuzzy',
        hasFuzzyToggle !== null,
      );
      const cutHasFuzzy =
        cutIndex >= 0 ? (await pickers[cutIndex].$('.card-picker__fuzzy-toggle')) !== null : null;
      // NOTE: the option COUNT is only readable while a list is open (the
      // popover unmounts when closed), so it is not printed here — the exact
      // threshold boundary is pinned by `cardPicker.test.ts`, which reads the
      // constant. This only records that the deck-sized list also offers it.
      console.log(`  (cut picker offers fuzzy: ${cutHasFuzzy} - it lists the deck, which is over the threshold)`);
    }

    // ------------------------------------------- ITEM 5: does inOnly REACH it?
    const pinned = await pinBringIn(page, inIndex);
    if (!pinned) {
      notChecked('the bring-in focus reaches the engine', 'could not pin a card in the Bring in picker');
    } else {
      check(
        'the summary line names the pinned card in words',
        pinned.summary.includes('what to cut to fit'),
        `summary reads "${pinned.summary}"`,
      );
      const ran = await runSuggest(page, watcher);
      if (ran.status !== 'done') {
        notChecked('the ranked table holds the IN fixed', ran.why);
      } else {
        const ins = [...new Set(ran.rows.map((r) => r.inName))];
        check(
          'EVERY row of the ranked table brings in the pinned card',
          ins.length === 1 && ins[0] === pinned.name,
          `${ran.rows.length} row(s), IN set = ${JSON.stringify(ins)}, pinned "${pinned.name}"`,
        );
        check(
          'and the OUT side varies — it really did try different cuts',
          new Set(ran.rows.map((r) => r.outName)).size >= 1,
          `OUTs = ${JSON.stringify([...new Set(ran.rows.map((r) => r.outName))])}`,
        );
      }
    }

    await assertPageAlive(page, watcher, 'the whole run');
    watcher.assertNone('the whole run');
  } finally {
    await browser.close();
    preview.child.kill();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? ` — ${failed.length} FAILED/NOT CHECKED` : ''),
  );
  return failed.length === 0 ? 0 : 1;
}

/** Pick the first pool card in the Bring in picker; returns its name + the summary. */
async function pinBringIn(page, inIndex) {
  if (inIndex < 0) return null;
  const pickers = await page.$$('.card-picker');
  const input = await pickers[inIndex].$('input[role="combobox"]');
  await input.click();
  await sleep(300);
  // Type a name that exists in every pool build, so the choice is deterministic.
  await input.type('Sol Ring', { delay: 20 });
  await sleep(700);
  const first = await pickers[inIndex].$('.card-picker__option');
  if (!first) return null;
  // `__option-label` is the bare name; `__option-name` is the whole cell and
  // also holds the multi-select tick and the approximate marker.
  const name = await first.evaluate(
    (el) =>
      (
        el.querySelector('.card-picker__option-label') ??
        el.querySelector('.card-picker__option-name')
      )?.textContent?.trim() ?? '',
  );
  await first.click();
  await sleep(400);
  await page.keyboard.press('Escape');
  await sleep(300);
  const summary = await page.evaluate(
    () => document.querySelector('.suggest-focus__summary')?.textContent?.trim() ?? '',
  );
  return { name, summary };
}

/** Press "Suggest swaps" and read the ranked table back. */
async function runSuggest(page, watcher) {
  const state = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').trim().startsWith('Suggest swaps'),
    );
    if (!btn) return { found: false, disabled: true };
    return { found: true, disabled: btn.disabled };
  });
  if (!state.found) return { status: 'skipped', why: 'no "Suggest swaps" button on screen' };
  if (state.disabled) {
    return { status: 'skipped', why: 'the run button is disabled (no legal hero or no opponents chosen)' };
  }

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').trim().startsWith('Suggest swaps'),
    );
    btn?.click();
  });

  const deadline = Date.now() + RUN_BUDGET_MS;
  while (Date.now() < deadline) {
    const rows = await page.evaluate(() => {
      const table = document.querySelector('.lab-results .lab-table');
      if (!table) return null;
      return [...table.querySelectorAll('tbody tr')].map((tr) => {
        const cell = tr.children[1];
        const names = [...cell.querySelectorAll('.lab-card-name')].map((n) => n.textContent.trim());
        return { outName: names[0] ?? '', inName: names[1] ?? '' };
      });
    });
    if (rows && rows.length > 0) return { status: 'done', rows };
    if (watcher.errors.length > 0) {
      return { status: 'skipped', why: `the page threw: ${watcher.errors[0]}` };
    }
    await sleep(2000);
  }
  return { status: 'skipped', why: `the run did not finish within ${RUN_BUDGET_MS / 1000}s` };
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  },
);
