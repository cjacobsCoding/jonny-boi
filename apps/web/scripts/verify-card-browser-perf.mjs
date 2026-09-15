#!/usr/bin/env node
/**
 * MEASURE THE CARD BROWSER, in a real Chrome, before and after.
 *
 * ## Why this exists
 *
 * Caleb: *"jonny boi is running really slow on cards and deck builder tabs"*.
 * The Cards view and the Deck Builder's pool both rendered EVERY card in the
 * pool as a tile — 5,651 of them at the time of writing, on a pool growing
 * toward the 32,276-card corpus. "Feels slow" is not a number, and §3.146
 * already showed that the interesting costs here (DOM size, cross-origin image
 * requests, frame time under scroll) are invisible to the unit suite: there is
 * no DOM in vitest, `renderToStaticMarkup` does not expand the CSSOM, and a
 * green test says nothing about how a page scrolls.
 *
 * So this is the gate. It is a MEASUREMENT harness, not a pass/fail one for
 * most of what it prints: it reports numbers, and asserts only the handful of
 * things that are genuinely binary (the grid is not blank; scrolling leaves no
 * hole; the rendered node count does not track the pool size).
 *
 * ## How to compare two runs honestly
 *
 * Puppeteer launches a FRESH temp profile every time, so every run is a COLD
 * image cache — the expensive half of §3.146's bimodal time-to-shell (~7.8 s
 * warm, ~38.9 s cold). Both sides of a before/after therefore pay the same
 * price, which is the only way the two numbers mean anything next to each
 * other. Do not "warm it up" to make a number look better.
 *
 * Usage:
 *   node apps/web/scripts/verify-card-browser-perf.mjs [--label before] [--headful]
 *
 * Writes verify-out/card-browser-perf/<label>.json plus screenshots at both
 * viewports. Exit 0 every assertion passed, 1 one failed, 2 could not run.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { describeChromeSearch, findChrome } from './lib/find-chrome.mjs';
import { harnessLaunchOptions } from './lib/harness-chrome.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(WEB_ROOT, 'verify-out', 'card-browser-perf');

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_CANNOT_RUN = 2;

/** The desktop window the report was filed against, and the PWA's phone size. */
const VIEWPORTS = Object.freeze({
  desktop: { width: 1280, height: 800 },
  phone: { width: 375, height: 812 },
});

/**
 * How long the app SHELL may take to appear. 90 s, matching `LAUNCHER_WAIT_MS`
 * in `verify-bug-reporter.mjs` and `APP_SHELL_WAIT_MS` in the layout harnesses
 * — one budget for one question (see `harness-wait-budgets.test.ts`, which
 * fails if any harness waits on puppeteer's unnamed 30 s default).
 */
const APP_SHELL_WAIT_MS = 90_000;
/** An in-app transition once the shell is up; touches no network. */
const UI_TRANSITION_WAIT_MS = 20_000;
/**
 * How long a tile may take to appear once a view is mounted.
 *
 * 240 s, and the number is this large because of what it MEASURED. Mounting the
 * pre-virtualisation Deck Builder pool — 5,651 tiles carrying add/remove
 * steppers, 6.7 MB of DOM — was timed at 49.6 s on one run and 92.3 s on
 * another, and a third run blew straight past a 90 s budget and reported the
 * harness as unable to run. A budget that a healthy-but-pathological page
 * crosses at random turns a MEASUREMENT into a coin flip, which is the same
 * trap `harness-wait-budgets.test.ts` was written for.
 *
 * It is a ceiling, not a wait: once virtualised this view mounts in well under
 * a second, and nothing here slows down because the ceiling is high.
 */
const FIRST_TILE_WAIT_MS = 240_000;

/** Frames longer than this are what a person perceives as a stutter. */
const LONG_FRAME_MS = 50;
/** How far to scroll per step while sampling frame times. */
const SCROLL_STEP_PX = 900;
/** How many scroll steps to sample. Enough to leave the first screenful behind. */
const SCROLL_STEPS = 12;
/** Milliseconds to let a scroll settle before measuring coverage. */
const SETTLE_MS = 450;
/** How many Tab presses the keyboard walk takes. More than one screenful of
 *  tiles, so the window is forced to extend rather than merely hold. */
const KEYBOARD_TAB_STOPS = 45;

/**
 * How far the pinned row track may sit from the tile it holds, in px.
 *
 * A couple of pixels covers sub-pixel layout and a fractional device ratio.
 * The defect this bounds was off by 265px, so the tolerance is nowhere near
 * the interesting scale and does not need to be argued about.
 */
const ROW_GEOMETRY_TOLERANCE_PX = 2;

/**
 * The narrowest rendered tile, as a fraction of the widest, below which a grid
 * is drawing collapsed sliver columns rather than cards. Real columns are `1fr`
 * and therefore equal; a sliver measures a hairline, so anything above a coin
 * flip separates the two cleanly.
 */
const MIN_TILE_WIDTH_RATIO = 0.5;

/** A visible vertical band with no tile in it, taller than this, is a HOLE. */
const MAX_BLANK_BAND_PX = 260;

/**
 * Ceiling for ONE DevTools protocol call.
 *
 * Puppeteer's unnamed default is 180 s, and the BEFORE side of this measurement
 * blows straight through it: a single `Page.captureScreenshot` of the
 * un-virtualised deck builder at 375px — 5,651 tiles, 5,651 images, 6.7 MB of
 * DOM — timed out, and the harness reported "could not run" against an app that
 * was merely unusably slow. Reporting "I could not measure" when the honest
 * answer is "it took four minutes to draw one frame" loses the finding.
 */
const PROTOCOL_TIMEOUT_MS = 600_000;

const args = process.argv.slice(2);
const headful = args.includes('--headful');
const label = args.indexOf('--label') >= 0 ? args[args.indexOf('--label') + 1] : 'run';

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Let the page settle for a couple of frames without leaving the harness. */
const sleepInPage = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 400)));

/**
 * Flush the report to disk after every phase, not once at the end.
 *
 * The PRE-virtualisation Cards view drives the Chrome renderer to ~1.4 GB on
 * this 7 GB box, and a run that dies of memory pressure half way through used
 * to take the numbers it had already taken with it — on the one build whose
 * numbers are hardest to retake. Partial results are still results.
 */
function flush(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, `${label}.json`), JSON.stringify({ ...report, checks }, null, 2));
}

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

/** Serve the BUILT app — what ships, not the dev server. */
async function startPreview() {
  if (!existsSync(resolve(WEB_ROOT, 'dist', 'index.html'))) {
    throw new Error('apps/web/dist missing — run `npm run build` first');
  }
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
 * The one place the page is measured, so a selector change breaks one function
 * rather than every number below it.
 */
async function measureDom(page) {
  return page.evaluate(() => {
    const root = document.getElementById('root');
    return {
      nodes: document.querySelectorAll('*').length,
      rootHtmlChars: root ? root.innerHTML.length : 0,
      images: document.querySelectorAll('img').length,
      tiles: document.querySelectorAll('.card-tile').length,
      // What the toolbar claims is MATCHING — the denominator the tiles are a
      // window onto. A virtualised grid must keep this honest.
      resultCount: document.querySelector('.result-count')?.textContent?.trim() ?? null,
      docHeight: document.documentElement.scrollHeight,
    };
  });
}

/**
 * Scroll in steps, sampling every animation frame, and report what the frames
 * actually cost. Frame time is the only honest proxy for "does it feel smooth";
 * a total elapsed time hides a single 2-second hitch inside an average.
 */
async function measureScroll(page) {
  return page.evaluate(
    async (stepPx, steps, longMs) => {
      const frames = [];
      let last = performance.now();
      let running = true;
      const tick = () => {
        const now = performance.now();
        frames.push(now - last);
        last = now;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      for (let i = 0; i < steps; i++) {
        window.scrollBy(0, stepPx);
        await new Promise((r) => setTimeout(r, 120));
      }
      running = false;
      await new Promise((r) => setTimeout(r, 60));
      // Drop the first frame: it carries the gap since the previous rAF loop.
      const sample = frames.slice(1).sort((a, b) => a - b);
      const at = (q) => (sample.length ? sample[Math.min(sample.length - 1, Math.floor(sample.length * q))] : 0);
      return {
        frames: sample.length,
        medianMs: Math.round(at(0.5) * 10) / 10,
        p95Ms: Math.round(at(0.95) * 10) / 10,
        worstMs: Math.round((sample[sample.length - 1] ?? 0) * 10) / 10,
        longFrames: sample.filter((f) => f > longMs).length,
        scrolledTo: window.scrollY,
      };
    },
    SCROLL_STEP_PX,
    SCROLL_STEPS,
    LONG_FRAME_MS,
  );
}

/**
 * Is the grid actually COVERED where the user is looking? A virtualiser that
 * renders the wrong window looks exactly like a fast one in every number above
 * and like a blank page to a person. Walks the visible band and reports the
 * tallest vertical run with no tile in it.
 */
async function measureCoverage(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('.card-grid');
    if (!grid) return { hasGrid: false, tallestBlankPx: Infinity, visibleTiles: 0 };
    const gridRect = grid.getBoundingClientRect();
    // Only the part of the viewport the GRID is responsible for.
    const top = Math.max(0, gridRect.top);
    const bottom = Math.min(window.innerHeight, gridRect.bottom);
    if (bottom - top < 1) return { hasGrid: true, tallestBlankPx: 0, visibleTiles: 0, bandPx: 0 };
    const rows = [...grid.querySelectorAll('.card-tile')]
      .map((t) => t.getBoundingClientRect())
      .filter((r) => r.bottom > top && r.top < bottom)
      .sort((a, b) => a.top - b.top);
    let cursor = top;
    let tallestBlank = 0;
    for (const r of rows) {
      if (r.top > cursor) tallestBlank = Math.max(tallestBlank, r.top - cursor);
      cursor = Math.max(cursor, r.bottom);
    }
    tallestBlank = Math.max(tallestBlank, bottom - cursor);
    return {
      hasGrid: true,
      bandPx: Math.round(bottom - top),
      visibleTiles: rows.length,
      tallestBlankPx: Math.round(tallestBlank),
    };
  });
}

/**
 * Type into the search box and time how long the result counter takes to
 * answer. This is the latency a person feels most sharply: every keystroke
 * re-filters the whole pool and, before virtualisation, re-rendered it too.
 */
async function measureSearchLatency(page, term) {
  const box = await page.$('.toolbar__search');
  if (!box) return null;
  await box.click({ clickCount: 3 });
  const before = await page.evaluate(
    () => document.querySelector('.result-count')?.textContent ?? '',
  );
  const started = Date.now();
  await page.keyboard.type(term, { delay: 0 });
  const deadline = Date.now() + UI_TRANSITION_WAIT_MS;
  while (Date.now() < deadline) {
    const now = await page.evaluate(
      () => document.querySelector('.result-count')?.textContent ?? '',
    );
    if (now !== before) {
      return { ms: Date.now() - started, from: before.trim(), to: now.trim() };
    }
    await sleep(10);
  }
  return { ms: -1, from: before.trim(), to: '(never changed)' };
}

/**
 * Does the grid's PINNED geometry agree with the tiles it is drawing?
 *
 * ## The defect this exists for
 *
 * The virtualiser pins `grid-auto-rows` to a MEASURED tile height. The first
 * layout pass after mount measured 94px — the tile body alone, with the art box
 * contributing nothing — and the grid then never looked again. Tiles are 359px
 * tall, so every row overlapped the two above it: art clipped to a third of a
 * card, names and mana costs hidden behind the next row.
 *
 * ⚠️ AND EVERY OTHER CHECK IN THIS HARNESS PASSED. The node count was right,
 * scrolling was smooth, the search was fast, and `measureCoverage` reported a
 * 16px tallest blank band — because overlapping tiles leave NO GAP. A grid can
 * be entirely wrong and still have no holes in it, which is why "no blank band"
 * was never enough on its own.
 *
 * So this asks the two questions that actually fail when the geometry is wrong:
 * is the row track the height of a tile, and do rows overlap each other?
 */
async function measureRowGeometry(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('.card-grid');
    if (!grid) return { hasGrid: false };
    const pinned = Number.parseFloat(getComputedStyle(grid).gridAutoRows);
    const tiles = [...grid.querySelectorAll('.card-tile')];
    if (tiles.length === 0) return { hasGrid: true, tiles: 0 };
    const rects = tiles.map((t) => t.getBoundingClientRect());
    const tallestTile = Math.max(...rects.map((r) => r.height));

    // Group tiles into rows by their top edge, then ask whether any row's
    // bottom crosses into the row below it.
    const rows = new Map();
    for (const r of rects) {
      const key = Math.round(r.top);
      const row = rows.get(key) ?? { top: r.top, bottom: r.bottom };
      row.bottom = Math.max(row.bottom, r.bottom);
      rows.set(key, row);
    }
    const ordered = [...rows.values()].sort((a, b) => a.top - b.top);
    let worstOverlapPx = 0;
    for (let i = 1; i < ordered.length; i++) {
      worstOverlapPx = Math.max(worstOverlapPx, ordered[i - 1].bottom - ordered[i].top);
    }
    // COLUMNS, the other half of the same question. The virtualiser groups items
    // into rows by a measured column count but leaves the COLUMN to the grid's
    // own auto-placement, so a count that is too high pushes the surplus into an
    // implicit track that collapses to a sliver — two real cards beside four
    // hairlines, on every row.
    //
    // ⚠️ NOT compared against `grid-template-columns`. That check was written
    // first and was VACUOUS: the computed value reports implicit tracks
    // alongside declared ones, so a grid with four invented columns cheerfully
    // reported "6 of 6 declared" and passed while the slivers were on screen.
    // The honest symptom is the slivers themselves — a rendered tile far
    // narrower than its neighbours.
    const widths = rects.map((r) => r.width);
    const widestTilePx = Math.max(...widths);
    const narrowestTilePx = Math.min(...widths);
    const occupiedColumns = new Set(rects.map((r) => Math.round(r.left))).size;

    return {
      hasGrid: true,
      tiles: tiles.length,
      rows: ordered.length,
      pinnedRowPx: Number.isFinite(pinned) ? Math.round(pinned * 100) / 100 : null,
      tallestTilePx: Math.round(tallestTile * 100) / 100,
      // How far the pinned row track is from the tile it is supposed to hold.
      rowVsTilePx: Number.isFinite(pinned) ? Math.round((pinned - tallestTile) * 100) / 100 : null,
      worstOverlapPx: Math.round(worstOverlapPx * 100) / 100,
      occupiedColumns,
      widestTilePx: Math.round(widestTilePx * 100) / 100,
      narrowestTilePx: Math.round(narrowestTilePx * 100) / 100,
      narrowestRatio: widestTilePx > 0 ? Math.round((narrowestTilePx / widestTilePx) * 1000) / 1000 : 0,
      overflowsHorizontally: grid.scrollWidth > grid.clientWidth + 1,
    };
  });
}

/** Assert the geometry at one label, so the three surfaces share one funnel. */
function assertRowGeometry(label, geo) {
  if (!geo || geo.hasGrid !== true || !geo.tiles) {
    check(`${label}: there was a grid with tiles to measure`, false, JSON.stringify(geo));
    return;
  }
  console.log(
    `  ${label} geometry: row track ${geo.pinnedRowPx}px vs tallest tile ${geo.tallestTilePx}px ` +
      `(off by ${geo.rowVsTilePx}px), worst row overlap ${geo.worstOverlapPx}px across ${geo.rows} rows, ` +
      `${geo.occupiedColumns} columns, narrowest tile ${geo.narrowestTilePx}px of ${geo.widestTilePx}px`,
  );
  check(
    `${label}: the pinned row track is the height of a tile`,
    geo.rowVsTilePx !== null && Math.abs(geo.rowVsTilePx) <= ROW_GEOMETRY_TOLERANCE_PX,
    `off by ${geo.rowVsTilePx}px`,
  );
  check(
    `${label}: no row overlaps the one below it`,
    geo.worstOverlapPx <= ROW_GEOMETRY_TOLERANCE_PX,
    `worst overlap ${geo.worstOverlapPx}px`,
  );
  check(
    `${label}: every rendered tile is a real column wide, not a collapsed sliver`,
    geo.narrowestRatio >= MIN_TILE_WIDTH_RATIO,
    `narrowest ${geo.narrowestTilePx}px vs widest ${geo.widestTilePx}px across ${geo.occupiedColumns} columns`,
  );
  check(
    `${label}: the grid does not overflow sideways`,
    geo.overflowsHorizontally === false,
  );
}

/**
 * Can the grid still be used from the keyboard, and does scrolling keep your
 * place?
 *
 * The specific failure a virtualiser invites: wheel-scroll away from a focused
 * tile, the tile unmounts, the browser hands focus back to `<body>`, and the
 * next Tab restarts at the top of the document. A grid that loses your place is
 * worse than a slow one, so this is a CHECK and not a number.
 *
 * Tabbing is also how the window is proved to EXTEND: focusing an element
 * scrolls it into view, which moves the scroll position, which re-plans the
 * window — so a run of Tabs must keep finding real tiles rather than falling out
 * of the grid at the edge of the first screenful.
 */
async function measureKeyboard(page) {
  // ONE definition of "which tile has focus", installed in the page, so the
  // before and after builds are read the same way.
  //
  // `data-card-index` is an attribute the VIRTUALISED grid adds. Reading only
  // that made the un-virtualised build report "no tile focused" for all 45 Tab
  // stops — an instrument artifact that looks exactly like a real failure, on
  // the side of the comparison that is supposed to be the baseline. The
  // ordinal fallback answers the same question ("which tile did focus land
  // on?") for a grid that has no such attribute.
  await page.evaluate(() => {
    window.__focusedTileIndex = () => {
      const grid = document.querySelector('.card-grid');
      const active = document.activeElement;
      if (!grid || !active || !grid.contains(active)) return null;
      const cell = active.closest ? active.closest('[data-card-index]') : null;
      if (cell) return Number(cell.getAttribute('data-card-index'));
      const tile = active.closest ? active.closest('.card-tile') : null;
      if (!tile) return null;
      return [...grid.querySelectorAll('.card-tile')].indexOf(tile);
    };
  });

  const entered = await page.evaluate(() => {
    const first = document.querySelector('.card-grid .card-tile__art-btn');
    if (!first) return false;
    first.focus();
    return document.activeElement === first;
  });
  if (!entered) return { entered: false };

  const seen = [];
  let leftGrid = 0;
  for (let i = 0; i < KEYBOARD_TAB_STOPS; i++) {
    await page.keyboard.press('Tab');
    const state = await page.evaluate(() => {
      const grid = document.querySelector('.card-grid');
      const active = document.activeElement;
      const inGrid = Boolean(grid && active && grid.contains(active));
      return { inGrid, index: window.__focusedTileIndex() };
    });
    if (!state.inGrid) leftGrid++;
    if (state.index !== null) seen.push(state.index);
  }

  // Now the part a virtualiser breaks: keep focus, and scroll a long way away.
  const focusedIndex = seen.length > 0 ? seen[seen.length - 1] : null;
  await page.evaluate(() => window.scrollBy(0, 12_000));
  await sleepInPage(page);
  const afterScroll = await page.evaluate(() => {
    const grid = document.querySelector('.card-grid');
    const active = document.activeElement;
    return {
      stillInGrid: Boolean(grid && active && grid.contains(active)),
      index: window.__focusedTileIndex(),
      fellToBody: active === document.body,
    };
  });

  return {
    entered: true,
    tabStops: KEYBOARD_TAB_STOPS,
    leftGrid,
    tilesReached: new Set(seen).size,
    furthestIndex: seen.length > 0 ? Math.max(...seen) : null,
    focusedBeforeScroll: focusedIndex,
    afterScroll,
  };
}

/**
 * Empty the search box and wait for the grid to answer.
 *
 * Called after every latency measurement, because the NEXT measurement must see
 * the whole pool. The first version of this harness skipped it and reported the
 * Deck Builder at 375px as 1,336 nodes — a real number, of the 60 cards left
 * over from a "goblin" search, presented as if it were the pool. Substituting a
 * population you control for the one you were asked about is how a metric gets
 * to be true by construction.
 */
async function clearSearch(page) {
  const box = await page.$('.toolbar__search');
  if (!box) return null;
  await box.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  const deadline = Date.now() + UI_TRANSITION_WAIT_MS;
  while (Date.now() < deadline) {
    const text = await page.evaluate(
      () => document.querySelector('.result-count')?.textContent?.trim() ?? '',
    );
    const count = Number(/^(\d+)/.exec(text)?.[1] ?? '0');
    if (count > 1000) return count;
    await sleep(50);
  }
  return -1;
}

/** Click a top-level nav button by its label. */
async function gotoView(page, viewLabel) {
  const clicked = await page.evaluate((text) => {
    const nav = [...document.querySelectorAll('.nav-link')].find(
      (b) => b.textContent.trim().toLowerCase() === text.toLowerCase(),
    );
    if (!nav) return false;
    nav.click();
    return true;
  }, viewLabel);
  if (!clicked) throw new Error(`no nav button labelled ${viewLabel}`);
  await page.waitForSelector('.card-tile', { timeout: FIRST_TILE_WAIT_MS });
  await sleep(SETTLE_MS);
}

async function shot(page, name) {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = resolve(OUT_DIR, name);
  await page.screenshot({ path });
  return path;
}

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error(describeChromeSearch());
  const preview = await startPreview();
  const browser = await puppeteer.launch(
    harnessLaunchOptions({
      chromePath: chrome,
      headful,
      viewport: VIEWPORTS.desktop,
      protocolTimeoutMs: PROTOCOL_TIMEOUT_MS,
    }),
  );

  const report = { label, takenAt: new Date().toISOString(), viewports: VIEWPORTS };
  try {
    const page = await browser.newPage();
    // Count what the page asks the NETWORK for. Hundreds of cross-origin card
    // images is itself a headline cost, not a detail.
    let cardImageRequests = 0;
    page.on('request', (req) => {
      if (/scryfall/i.test(req.url()) && req.resourceType() === 'image') cardImageRequests++;
    });
    const pageErrors = [];
    // Printed the moment they happen, not only in the summary. A run where the
    // React tree threw and came down looked, in the summary, like a page whose
    // nav buttons had simply gone missing — which sent the diagnosis off in
    // entirely the wrong direction until the error was read.
    page.on('pageerror', (e) => {
      pageErrors.push(String(e));
      console.log('  PAGE ERROR: ' + String(e).slice(0, 200));
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`  CONSOLE ERROR: ${msg.text().slice(0, 200)}`);
    });

    // ---- Cards (the landing view) -----------------------------------------
    const navStart = Date.now();
    await page.goto(preview.url, { waitUntil: 'domcontentloaded', timeout: APP_SHELL_WAIT_MS });
    await page.waitForSelector('.app__nav', { timeout: APP_SHELL_WAIT_MS });
    const timeToShellMs = Date.now() - navStart;
    await page.waitForSelector('.card-tile', { timeout: FIRST_TILE_WAIT_MS });
    const timeToFirstTileMs = Date.now() - navStart;
    await sleep(SETTLE_MS);

    const cardsDom = await measureDom(page);
    // BEFORE any scrolling: the defect this catches is a first-frame
    // measurement that a single scroll event silently repairs, so a check that
    // scrolls first would never see it.
    const cardsGeometry = await measureRowGeometry(page);
    assertRowGeometry('Cards @1280, at load', cardsGeometry);
    const cardsShot = await shot(page, `${label}-cards-1280.png`);
    const cardsScroll = await measureScroll(page);
    const cardsCoverage = await measureCoverage(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(SETTLE_MS);
    const keyboard = await measureKeyboard(page);
    console.log(
      `
  keyboard: entered=${keyboard.entered} tabs=${keyboard.tabStops ?? 0} ` +
        `left-grid=${keyboard.leftGrid ?? '-'} distinct-tiles=${keyboard.tilesReached ?? '-'} ` +
        `furthest-index=${keyboard.furthestIndex ?? '-'}`,
    );
    console.log(
      `  after scrolling 12,000px away: focus still in grid=${keyboard.afterScroll?.stillInGrid} ` +
        `index=${keyboard.afterScroll?.index} fell-to-body=${keyboard.afterScroll?.fellToBody}`,
    );
    check(
      'Tab walks the grid without falling out of it',
      keyboard.entered === true && keyboard.leftGrid === 0,
      `${keyboard.leftGrid ?? '?'} of ${keyboard.tabStops ?? 0} stops left the grid`,
    );
    check(
      'Tab reaches tiles beyond the first screenful — the window extends',
      (keyboard.furthestIndex ?? -1) > 0,
      `furthest index ${keyboard.furthestIndex}`,
    );
    check(
      'scrolling far away does NOT drop focus to <body>',
      keyboard.afterScroll?.fellToBody === false && keyboard.afterScroll?.stillInGrid === true,
      `index ${keyboard.afterScroll?.index}`,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(SETTLE_MS);
    const cardsSearch = await measureSearchLatency(page, 'goblin');
    const cardsSearchDom = await measureDom(page);
    // Clear the search so the next view starts from the full pool.
    const cardsRestored = await clearSearch(page);
    check(
      'the Cards search was cleared back to the whole pool before moving on',
      (cardsRestored ?? -1) > 1000,
      `${cardsRestored} cards`,
    );
    await sleep(SETTLE_MS);

    report.cards = {
      timeToShellMs,
      timeToFirstTileMs,
      cardImageRequestsAtSettle: cardImageRequests,
      dom: cardsDom,
      scroll: cardsScroll,
      coverage: cardsCoverage,
      geometry: cardsGeometry,
      search: cardsSearch,
      keyboard,
      domWhileSearching: cardsSearchDom,
      screenshot: cardsShot,
    };
    flush(report);

    console.log(`\nCards @1280x800 (label "${label}")`);
    console.log(`  time to shell            ${timeToShellMs} ms`);
    console.log(`  time to first tile       ${timeToFirstTileMs} ms`);
    console.log(`  DOM nodes                ${cardsDom.nodes}`);
    console.log(`  #root.innerHTML chars    ${cardsDom.rootHtmlChars}`);
    console.log(`  <img> elements           ${cardsDom.images}`);
    console.log(`  .card-tile elements      ${cardsDom.tiles}   (toolbar says ${cardsDom.resultCount})`);
    console.log(`  scryfall image requests  ${cardImageRequests}`);
    console.log(
      `  scroll frames            median ${cardsScroll.medianMs} ms · p95 ${cardsScroll.p95Ms} ms · worst ${cardsScroll.worstMs} ms · ${cardsScroll.longFrames}/${cardsScroll.frames} over ${LONG_FRAME_MS} ms`,
    );
    console.log(`  tallest blank band       ${cardsCoverage.tallestBlankPx} px of a ${cardsCoverage.bandPx} px band`);
    console.log(`  search "goblin" answered ${cardsSearch?.ms} ms  (${cardsSearch?.from} -> ${cardsSearch?.to})`);

    check('the Cards grid rendered tiles at all', cardsDom.tiles > 0, `${cardsDom.tiles} tiles`);
    check(
      'no hole in the Cards grid after scrolling',
      cardsCoverage.tallestBlankPx <= MAX_BLANK_BAND_PX,
      `tallest blank ${cardsCoverage.tallestBlankPx}px`,
    );
    check('searching answered', (cardsSearch?.ms ?? -1) >= 0, `${cardsSearch?.ms} ms`);

    // ---- Deck Builder ------------------------------------------------------
    // Non-fatal on purpose: a phase that is too slow to finish must not take the
    // phases that already succeeded with it, and "this view would not mount in
    // four minutes" is itself the most important thing a run can report.
    const deckStart = Date.now();
    let deckMounted = true;
    try {
      await gotoView(page, 'Deck Builder');
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      deckMounted = false;
      check('the Deck Builder pool mounted at all', false, why);
      report.deck = { mounted: false, why, mountMs: Date.now() - deckStart };
      flush(report);
    }

    if (deckMounted) {
    const deckMountMs = Date.now() - deckStart;
    const deckDom = await measureDom(page);
    const deckGeometry = await measureRowGeometry(page);
    assertRowGeometry('Deck Builder @1280, at load', deckGeometry);
    const deckShot = await shot(page, `${label}-deck-1280.png`);
    const deckScroll = await measureScroll(page);
    const deckCoverage = await measureCoverage(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(SETTLE_MS);
    const deckSearch = await measureSearchLatency(page, 'goblin');

    report.deck = {
      mountMs: deckMountMs,
      dom: deckDom,
      scroll: deckScroll,
      coverage: deckCoverage,
      geometry: deckGeometry,
      search: deckSearch,
      screenshot: deckShot,
    };
    flush(report);

    console.log(`\nDeck Builder @1280x800`);
    console.log(`  time to mount the pool   ${deckMountMs} ms`);
    console.log(`  DOM nodes                ${deckDom.nodes}`);
    console.log(`  #root.innerHTML chars    ${deckDom.rootHtmlChars}`);
    console.log(`  <img> elements           ${deckDom.images}`);
    console.log(`  .card-tile elements      ${deckDom.tiles}   (toolbar says ${deckDom.resultCount})`);
    console.log(
      `  scroll frames            median ${deckScroll.medianMs} ms · p95 ${deckScroll.p95Ms} ms · worst ${deckScroll.worstMs} ms · ${deckScroll.longFrames}/${deckScroll.frames} over ${LONG_FRAME_MS} ms`,
    );
    console.log(`  tallest blank band       ${deckCoverage.tallestBlankPx} px of a ${deckCoverage.bandPx} px band`);
    console.log(`  search "goblin" answered ${deckSearch?.ms} ms  (${deckSearch?.from} -> ${deckSearch?.to})`);

    check('the Deck Builder pool rendered tiles at all', deckDom.tiles > 0, `${deckDom.tiles} tiles`);
    check(
      'no hole in the Deck Builder pool after scrolling',
      deckCoverage.tallestBlankPx <= MAX_BLANK_BAND_PX,
      `tallest blank ${deckCoverage.tallestBlankPx}px`,
    );

    // THE POOL, not what a leftover search left behind — see clearSearch.
    const deckRestored = await clearSearch(page);
    check(
      'the Deck Builder search was cleared back to the whole pool before the phone pass',
      (deckRestored ?? -1) > 1000,
      `${deckRestored} cards`,
    );
    }

    // ---- The phone, which DECKBUILDER-AND-ART.md §2 says has no layout ------
    await page.setViewport(VIEWPORTS.phone);
    await sleep(SETTLE_MS * 2);
    // Only if the Deck Builder actually mounted — measuring whatever view
    // happens to be on screen and FILING IT UNDER "deck builder" is exactly the
    // substitution that makes a number true by construction.
    const deckPhoneDom = deckMounted ? await measureDom(page) : null;
    const deckPhoneShot = deckMounted ? await shot(page, `${label}-deck-375.png`) : null;
    const deckPhoneCoverage = deckMounted ? await measureCoverage(page) : null;
    if (!deckMounted) {
      check('the Deck Builder was measured at 375px', false, 'the view never mounted at 1280px');
    }
    await gotoView(page, 'Cards');
    await sleep(SETTLE_MS);
    const cardsPhoneDom = await measureDom(page);
    const cardsPhoneShot = await shot(page, `${label}-cards-375.png`);
    const cardsPhoneGeometry = await measureRowGeometry(page);
    assertRowGeometry('Cards @375, at load', cardsPhoneGeometry);
    const cardsPhoneScroll = await measureScroll(page);
    const cardsPhoneCoverage = await measureCoverage(page);

    report.phone = {
      deck: { dom: deckPhoneDom, coverage: deckPhoneCoverage, screenshot: deckPhoneShot },
      cards: {
        dom: cardsPhoneDom,
        scroll: cardsPhoneScroll,
        coverage: cardsPhoneCoverage,
        geometry: cardsPhoneGeometry,
        screenshot: cardsPhoneShot,
      },
    };
    console.log(`\n375x812 (phone)`);
    console.log(
      deckPhoneDom
        ? `  Deck Builder: ${deckPhoneDom.nodes} nodes, ${deckPhoneDom.tiles} tiles, blank ${deckPhoneCoverage.tallestBlankPx}px`
        : '  Deck Builder: NOT CHECKED — the view never mounted at 1280x800',
    );
    console.log(`  Cards:        ${cardsPhoneDom.nodes} nodes, ${cardsPhoneDom.tiles} tiles, blank ${cardsPhoneCoverage.tallestBlankPx}px`);
    console.log(
      `  Cards scroll: median ${cardsPhoneScroll.medianMs} ms · p95 ${cardsPhoneScroll.p95Ms} ms · worst ${cardsPhoneScroll.worstMs} ms`,
    );
    check(
      'no hole in the Cards grid at 375px',
      cardsPhoneCoverage.tallestBlankPx <= MAX_BLANK_BAND_PX,
      `tallest blank ${cardsPhoneCoverage.tallestBlankPx}px`,
    );

    flush(report);
    report.pageErrors = pageErrors;
    check('the page threw nothing', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  } finally {
    await browser.close().catch(() => {});
    preview.child.kill();
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = resolve(OUT_DIR, `${label}.json`);
  report.checks = checks;
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${jsonPath}`);

  const failed = checks.filter((c) => !c.passed);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  return failed.length === 0 ? EXIT_OK : EXIT_FAILED;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('could not run:', err instanceof Error ? err.message : String(err));
    process.exit(EXIT_CANNOT_RUN);
  },
);
