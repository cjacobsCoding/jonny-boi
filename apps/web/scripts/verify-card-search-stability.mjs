#!/usr/bin/env node
/**
 * SEARCH THE CARD BROWSER LIKE A PERSON DOES, and require the app to survive it.
 *
 * ## The defect this exists for
 *
 * Caleb's most-used surface took the whole tab down. Typing a handful of
 * searches in a row — `Arbor Elf`, `Doorkeeper`, `Oblivion Ring`,
 * `Scavenging Ooze` — ended in `Minified React error #185`, "Maximum update
 * depth exceeded", and an empty `#root`. It is not a data problem: the same
 * sequence crashed on the 5,651-card pool and on the 6,914-card one.
 *
 * It is a VIRTUALISER FEEDBACK LOOP. `CardGrid` measures the tallest rendered
 * tile, pins the row track to it, and computes from that pitch which rows to
 * render — so the measurement decides the rendered set and the rendered set
 * decides the measurement. When a taller-than-average tile sits just past the
 * window edge, the two answers alternate forever: tall tile in -> bigger pitch
 * -> fewer rows -> tall tile out -> smaller pitch -> tall tile in. Every hop is
 * a `setState` from a layout effect, which React counts as a nested update, and
 * fifty of those is #185.
 *
 * Searching is what exposes it, because a query is what decides WHICH cards sit
 * next to each other — and therefore whether a tall one lands on the boundary.
 *
 * ## Why this is a browser harness and not a unit test
 *
 * Nothing about this is visible without a real layout. There is no DOM in
 * vitest, `renderToStaticMarkup` does not run layout effects, and a tile's
 * height comes from a wrapped card name in a real font. The unit suite was
 * fully green across every commit in which this crash shipped.
 *
 * ## The other half of the lesson
 *
 * The crash was first reported as "the card browser is missing 8 cards". It was
 * not: the app had thrown, `#root` was empty, and a harness with no `pageerror`
 * listener faithfully reported the absence it was built to look for. Every step
 * below therefore goes through `lib/harness-page.mjs`, which fails on a page
 * that threw or a page that silently went blank rather than attributing either
 * to whatever was being measured.
 *
 * Usage:
 *   node apps/web/scripts/verify-card-search-stability.mjs [--headful] [--label after]
 *
 * Exit 0 every check passed, 1 one failed, 2 could not run.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { describeChromeSearch, findChrome } from './lib/find-chrome.mjs';
import { harnessLaunchOptions } from './lib/harness-chrome.mjs';
import { assertPageAlive, watchPageErrors } from './lib/harness-page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(WEB_ROOT, 'verify-out', 'card-search-stability');

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_CANNOT_RUN = 2;

/** The desktop window the defect was reported against. */
const VIEWPORT = Object.freeze({ width: 1280, height: 800 });

/**
 * How long the app SHELL may take to appear. 90 s, matching `LAUNCHER_WAIT_MS`
 * in `verify-bug-reporter.mjs` and `APP_SHELL_WAIT_MS` in the layout harnesses
 * — one budget for one question (`harness-wait-budgets.test.ts` fails if any
 * harness waits on puppeteer's unnamed 30 s default).
 */
const APP_SHELL_WAIT_MS = 90_000;
/** How long a tile may take to appear once a view is mounted. */
const FIRST_TILE_WAIT_MS = 120_000;
/** How long one query may take to move the result count. */
const QUERY_WAIT_MS = 20_000;
/** Ceiling for ONE DevTools call. Matches `verify-card-browser-perf.mjs`. */
const PROTOCOL_TIMEOUT_MS = 600_000;
/** Let a query's re-render settle, in ms. */
const SETTLE_MS = 450;

/**
 * THE SEQUENCE, as a TABLE (rule 2): adding a case is a row.
 *
 * The first four are the exact sequence from the report, in the exact order —
 * do not reorder them, they are the reproduction. The rest are the "and keep
 * going" that proves the fix is not a coincidence of those four: each is chosen
 * for a different result-set SHAPE, because what feeds the loop is which card
 * lands on the window's boundary row.
 *
 * `scrollAfter` scrolls before the next query, because a scroll is what re-runs
 * the measurement against a different window — and the original crash was
 * reached by a person who scrolls while browsing.
 */
const SEARCHES = Object.freeze([
  { term: 'Arbor Elf', why: 'the reported sequence, step 1', scrollAfter: 0 },
  { term: 'Doorkeeper', why: 'the reported sequence, step 2', scrollAfter: 0 },
  { term: 'Oblivion Ring', why: 'the reported sequence, step 3', scrollAfter: 0 },
  { term: 'Scavenging Ooze', why: 'the reported sequence, step 4 — where it died', scrollAfter: 0 },
  { term: '', why: 'back to the whole pool — the widest window there is', scrollAfter: 4000 },
  { term: 'goblin', why: 'hundreds of hits: many rows, many boundary candidates', scrollAfter: 2400 },
  { term: 'elf', why: 'a substring that matches names AND types', scrollAfter: 1200 },
  { term: 'a', why: 'nearly the whole pool, re-filtered', scrollAfter: 6000 },
  { term: 'Serra Angel', why: 'one long two-word name — a tall tile alone', scrollAfter: 0 },
  { term: 'Llanowar Elves', why: 'a name that wraps at this column width', scrollAfter: 0 },
  { term: 'Lightning Bolt', why: 'a short name after a long one', scrollAfter: 0 },
  { term: 'Birds of Paradise', why: 'three words', scrollAfter: 0 },
  { term: 'Wrath of God', why: 'and back down again', scrollAfter: 900 },
  { term: 'zzzzznotacard', why: 'ZERO results — the grid unmounts entirely', scrollAfter: 0 },
  { term: 'Counterspell', why: 'recovering from the empty state', scrollAfter: 0 },
  { term: '', why: 'the whole pool once more, from a scrolled position', scrollAfter: 0 },
]);

const args = process.argv.slice(2);
const headful = args.includes('--headful');
const label = args.indexOf('--label') >= 0 ? args[args.indexOf('--label') + 1] : 'run';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
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

/**
 * Serve the BUILT app — what ships, not the dev server.
 *
 * It matters here beyond the usual reason: React's development build turns
 * "Maximum update depth exceeded" into a readable warning it can sometimes
 * absorb, while the production build minifies it to `#185` and unmounts. The
 * bug Caleb hit is the production one.
 */
async function startPreview() {
  const indexPath = resolve(WEB_ROOT, 'dist', 'index.html');
  if (!existsSync(indexPath)) {
    throw new Error('apps/web/dist missing — run `npm run build` first');
  }
  // A stale bundle is a lying bundle: this harness has to be measuring the
  // source it is being run against, and `dist/` survives a `git checkout`.
  const builtAt = statSync(indexPath).mtimeMs;
  const port = await freePort();
  const url = `http://localhost:${port}/`;
  const child = spawn(
    process.execPath,
    [viteBin(), 'preview', '--port', String(port), '--strictPort'],
    { cwd: WEB_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const deadline = Date.now() + APP_SHELL_WAIT_MS;
  while (Date.now() < deadline) {
    if (await isUp(url)) return { child, url, builtAt };
    await sleep(300);
  }
  child.kill();
  throw new Error('vite preview did not answer in time');
}

async function shot(page, name) {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = resolve(OUT_DIR, name);
  await page.screenshot({ path });
  const stat = statSync(path);
  console.log(`  shot ${name} — ${stat.size} bytes, ${Date.now() - stat.mtimeMs} ms old`);
  return path;
}

/** Everything the grid will say about itself, in one read. */
async function readGrid(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('.card-grid');
    const resultText = document.querySelector('.result-count')?.textContent ?? '';
    if (!grid) {
      return {
        hasGrid: false,
        emptyState: !!document.querySelector('.empty-state'),
        resultText: resultText.trim(),
        tiles: 0,
        nodes: document.querySelectorAll('*').length,
      };
    }
    const tiles = [...grid.querySelectorAll('.card-tile')];
    const heights = tiles.map((t) => t.getBoundingClientRect().height);
    return {
      hasGrid: true,
      emptyState: false,
      resultText: resultText.trim(),
      tiles: tiles.length,
      nodes: document.querySelectorAll('*').length,
      pinnedRowPx: Number.parseFloat(getComputedStyle(grid).gridAutoRows),
      tallestTilePx: heights.length ? Math.round(Math.max(...heights) * 10) / 10 : 0,
      shortestTilePx: heights.length ? Math.round(Math.min(...heights) * 10) / 10 : 0,
      paddingTopPx: Number.parseFloat(getComputedStyle(grid).paddingTop),
      paddingBottomPx: Number.parseFloat(getComputedStyle(grid).paddingBottom),
    };
  });
}

/**
 * Type one query the way a person retypes over the old one: select all, type.
 *
 * Waits for the result count to actually MOVE rather than for a fixed sleep,
 * except when the new term matches the same count as the old one — in which
 * case the settle below is what covers it.
 */
async function search(page, term) {
  const box = await page.$('.toolbar__search');
  if (!box) throw new Error('no .toolbar__search on the page');
  const before = await page.evaluate(
    () => document.querySelector('.result-count')?.textContent ?? '',
  );
  await box.click({ clickCount: 3 });
  if (term === '') {
    await page.keyboard.press('Backspace');
  } else {
    await page.keyboard.type(term, { delay: 0 });
  }
  const started = Date.now();
  const deadline = started + QUERY_WAIT_MS;
  while (Date.now() < deadline) {
    const now = await page.evaluate(
      () => document.querySelector('.result-count')?.textContent ?? '',
    );
    if (now !== before) break;
    await sleep(10);
  }
  await sleep(SETTLE_MS);
  return Date.now() - started;
}

async function openCards(page) {
  const clicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll('.app__nav button')].find((b) =>
      /cards/i.test(b.textContent ?? ''),
    );
    if (!button) return false;
    button.click();
    return true;
  });
  if (!clicked) throw new Error('no nav button labelled Cards');
  await page.waitForSelector('.card-tile', { timeout: FIRST_TILE_WAIT_MS });
  await sleep(SETTLE_MS);
}

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error(describeChromeSearch());
  const preview = await startPreview();
  console.log(`Browser: ${chrome}`);
  console.log(`App:     ${preview.url}  (dist built ${new Date(preview.builtAt).toISOString()})`);
  const browser = await puppeteer.launch(
    harnessLaunchOptions({
      chromePath: chrome,
      headful,
      viewport: VIEWPORT,
      protocolTimeoutMs: PROTOCOL_TIMEOUT_MS,
    }),
  );

  const report = {
    label,
    takenAt: new Date().toISOString(),
    distBuiltAt: new Date(preview.builtAt).toISOString(),
    viewport: VIEWPORT,
    steps: [],
  };
  let died = null;
  try {
    const page = await browser.newPage();
    const watcher = watchPageErrors(page);

    await page.goto(preview.url, { waitUntil: 'domcontentloaded', timeout: APP_SHELL_WAIT_MS });
    await page.waitForSelector('.app__nav', { timeout: APP_SHELL_WAIT_MS });
    await openCards(page);
    await assertPageAlive(page, watcher, 'opening the Cards view');
    console.log(`\nThe sequence (${SEARCHES.length} queries):`);

    for (const [index, step] of SEARCHES.entries()) {
      const shown = step.term === '' ? '(cleared)' : `"${step.term}"`;
      let ms = -1;
      let grid = null;
      let threw = [];
      try {
        ms = await search(page, step.term);
        if (step.scrollAfter > 0) {
          await page.evaluate((px) => window.scrollTo(0, px), step.scrollAfter);
          await sleep(SETTLE_MS);
        }
        grid = await readGrid(page);
      } catch (error) {
        threw = [String(error)];
      }
      threw = [...threw, ...watcher.drain()];
      const line =
        grid === null
          ? '(could not read the grid)'
          : grid.hasGrid
            ? `${grid.resultText || '?'} | ${grid.tiles} tiles | row track ${Math.round(grid.pinnedRowPx)}px ` +
              `vs tallest tile ${grid.tallestTilePx}px | ${grid.nodes} nodes`
            : `${grid.resultText || '?'} | no grid (${grid.emptyState ? 'empty state' : 'GONE'}) | ${grid.nodes} nodes`;
      console.log(`  ${String(index + 1).padStart(2)}. ${shown.padEnd(20)} ${line}`);
      report.steps.push({ ...step, index, ms, grid, threw });

      // The step that killed it is the step that gets named. A run that carried
      // on would measure a dead page and report whatever it failed to find.
      if (threw.length > 0) {
        died = { step: index + 1, term: step.term, errors: threw };
        await shot(page, `${label}-died-on-step-${index + 1}.png`);
        break;
      }
      try {
        await assertPageAlive(page, watcher, `search ${shown}`);
      } catch (error) {
        died = { step: index + 1, term: step.term, errors: [String(error)] };
        await shot(page, `${label}-died-on-step-${index + 1}.png`);
        break;
      }
    }

    if (!died) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(SETTLE_MS);
      report.finalShot = await shot(page, `${label}-after-the-sequence.png`);
    }

    const completed = report.steps.filter((s) => s.threw.length === 0).length;
    report.pageErrors = watcher.errors;
    report.consoleErrors = watcher.consoleErrors;
    report.died = died;

    console.log('');
    check(
      `all ${SEARCHES.length} queries completed with the app still running`,
      died === null,
      died
        ? `died on step ${died.step} ("${died.term}") — ${died.errors[0]?.slice(0, 220)}`
        : `${completed} of ${SEARCHES.length}`,
    );
    check(
      'the page threw nothing',
      watcher.errors.length === 0,
      watcher.errors.slice(0, 2).join(' | '),
    );
    // Named separately from the generic throw check: #185 is THIS defect, and a
    // future unrelated throw must not be mistaken for its return.
    const updateLoop = watcher.errors.filter((e) => /#185|Maximum update depth/i.test(e));
    check(
      'no "Maximum update depth exceeded" (React #185) — the virtualiser did not feed itself',
      updateLoop.length === 0,
      updateLoop.slice(0, 1).join(''),
    );
    // The grid must still be pinned to a track that fits its tiles. A row track
    // shorter than the tile it holds is how §3.147's overlapping rows started,
    // and the fix for the loop moves exactly this number.
    const last = [...report.steps].reverse().find((s) => s.grid?.hasGrid);
    check(
      'the row track still fits the tallest tile after the whole sequence',
      !!last && last.grid.pinnedRowPx >= last.grid.tallestTilePx - 2,
      last
        ? `track ${Math.round(last.grid.pinnedRowPx)}px, tallest tile ${last.grid.tallestTilePx}px`
        : 'no grid was ever read',
    );
  } catch (error) {
    report.harnessError = String(error);
    console.error('could not run:', error instanceof Error ? error.message : String(error));
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(resolve(OUT_DIR, `${label}.json`), JSON.stringify({ ...report, checks }, null, 2));
    await browser.close().catch(() => {});
    preview.child.kill();
    process.exit(EXIT_CANNOT_RUN);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = resolve(OUT_DIR, `${label}.json`);
  writeFileSync(jsonPath, JSON.stringify({ ...report, checks }, null, 2));
  console.log(`\nwrote ${jsonPath}`);
  await browser.close().catch(() => {});
  preview.child.kill();

  const failed = checks.filter((c) => !c.passed);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length === 0 ? EXIT_OK : EXIT_FAILED);
}

main().catch((error) => {
  console.error('could not run:', error instanceof Error ? error.stack : String(error));
  process.exit(EXIT_CANNOT_RUN);
});
