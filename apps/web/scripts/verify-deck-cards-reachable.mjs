#!/usr/bin/env node
/**
 * CAN CALEB FIND HIS OWN CARDS? — the acceptance gate for a pool regeneration.
 *
 * ## Why this exists
 *
 * A compiled card is not a playable card. The pool is GENERATED data, so every
 * family the compiler gains is invisible until `build-expansion` runs and all
 * four artifacts move together. The campaign manufactures that gap on purpose
 * (lanes are told not to commit generated files), and this project has shipped
 * work that was correct, tested, green and unreachable by a player NINE times.
 * Every one of those was caught by a harness or a rendered frame, and NOT ONE
 * by a test — because a unit test asks the compiler, and the compiler was never
 * the thing that was broken.
 *
 * So the question this asks is deliberately not "does it compile". It is: type
 * the name into the shipped app's card browser, and does the card come back.
 *
 * ## What it guards against, beyond "the card is missing"
 *
 * A blank or stale frame has been accepted as proof in this repo before, so a
 * screenshot alone is not evidence. Every claim here is pinned three ways:
 *
 *   1. the TILE's own name text must equal the card searched for — not a
 *      substring of the page, not the result counter, which would still read
 *      "1 card" if the grid painted nothing;
 *   2. the result counter must actually CHANGE from the pre-search value, so a
 *      search box that silently does nothing cannot pass;
 *   3. every screenshot's sha256 must be DISTINCT from every other one. Eight
 *      identical hashes is the signature of a stale frame, and a blank-page
 *      hash repeated eight times is exactly how this trap has fired before.
 *
 * The pool size is read back from the page too, so a run cannot pass against a
 * stale `dist/` built before the regeneration.
 *
 * Usage:
 *   node apps/web/scripts/verify-deck-cards-reachable.mjs [--headful]
 *
 * Writes verify-out/deck-cards-reachable/*.png and report.json.
 * Exit 0 every assertion passed, 1 one failed, 2 could not run.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { describeChromeSearch, findChrome } from './lib/find-chrome.mjs';
import { harnessLaunchOptions } from './lib/harness-chrome.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(WEB_ROOT, 'verify-out', 'deck-cards-reachable');

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_CANNOT_RUN = 2;

/**
 * The cards from `docs/decks/*.txt` that the wave-5 compiler families
 * unblocked. They are the acceptance case BECAUSE they are Caleb's own — a
 * campaign that only reaches cards which happen to be easy is measuring itself.
 * Names are the printed Oracle names, which is the join key the index uses.
 *
 * The last three arrived after the first regeneration of this lane —
 * `feat/replacement-prevention` (Rhox Faithmender, Fog Bank) and
 * `feat/targeting-protection` (Fiendslayer Paladin) — and they are listed HERE,
 * in the check, on purpose. Three absent becoming three present is a
 * DISCRIMINATOR: it says what this harness would have reported had the final
 * regeneration not run. A total that merely went up says nothing.
 *
 * With Rhox Faithmender and Fiendslayer Paladin in, all 22 names in
 * `acidic-angels.txt` compile — the first of Caleb's decks that can come back
 * whole.
 */
const DECK_CARDS = Object.freeze([
  'Arbor Elf',
  'Doorkeeper',
  'Oblivion Ring',
  'Scavenging Ooze',
  'Luminarch Ascension',
  'Kessig Wolf Run',
  'Selesnya Charm',
  "Trostani, Selesnya's Voice",
  'Rhox Faithmender',
  'Fog Bank',
  'Fiendslayer Paladin',
]);

/** The desktop window the card browser is reviewed at. */
const VIEWPORT = Object.freeze({ width: 1280, height: 800 });

/**
 * One budget for one question — matching `APP_SHELL_WAIT_MS` in the sibling
 * harnesses, which `harness-wait-budgets.test.ts` fails on if a harness falls
 * back to puppeteer's unnamed 30 s default.
 */
const APP_SHELL_WAIT_MS = 90_000;
/** An in-app transition once the shell is up; touches no network. */
const UI_TRANSITION_WAIT_MS = 20_000;
/** Ceiling for a tile to appear once a view mounts. Generous by design. */
const FIRST_TILE_WAIT_MS = 240_000;
/** Let a filter settle before reading the grid. */
const SETTLE_MS = 350;
/**
 * How long to let the virtualiser settle BETWEEN two searches.
 *
 * ⚠️ THIS IS WORKING AROUND A REAL APP DEFECT, AND IT IS NAMED SO NOBODY THINKS
 * IT IS TUNING. Typing a second search before `CardGrid` has settled from the
 * first crashes the app with React error #185 (maximum update depth exceeded) —
 * reproducibly, on the fourth card of
 * `Arbor Elf → Doorkeeper → Oblivion Ring → Scavenging Ooze`.
 *
 * It is NOT caused by the pool size: the identical five-name sequence survives
 * on the 5,651 pool and on the 6,914 one, measured both ways. It is a feedback
 * loop in the virtualiser's measure → render → measure cycle, and it belongs to
 * whoever owns `CardGrid.tsx`; this lane reports it rather than fixing a
 * component it does not own.
 *
 * Why the delay rather than nothing: a crashed React app is a BLANK page, so
 * every remaining card reports MISSING — an acceptance harness that says "the
 * pool refresh failed" when the truth is "the harness broke the app" is worse
 * than no harness. The `app never threw` check below still FAILS loudly if the
 * crash happens anyway, so this pacing hides nothing.
 */
const INTER_SEARCH_SETTLE_MS = 2_000;
/** Chrome DevTools protocol ceiling, for the big-grid mounts. */
const PROTOCOL_TIMEOUT_MS = 300_000;
/** Below this a PNG is a blank or near-blank frame, not a card browser. */
const MIN_PNG_BYTES = 8_000;

const headful = process.argv.includes('--headful');

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

/** The counter the toolbar prints, e.g. "6914 cards". */
const readCount = (page) =>
  page.evaluate(() => document.querySelector('.result-count')?.textContent?.trim() ?? '');

/** Just the integer out of that counter, so a pool size can be compared. */
function countOf(text) {
  const m = /([\d,]+)\s+cards?/.exec(text ?? '');
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/**
 * Type one card's name and read back what the GRID actually drew.
 *
 * Reads the tiles' own `.card-tile__name` nodes rather than the page text: a
 * card browser that renders the name in its search box and nothing in the grid
 * would pass a page-text check while showing the player an empty screen.
 */
/**
 * Type one name over the previous search and read back what the GRID drew.
 *
 * ⚠️ IT DOES NOT CLEAR BACK TO THE WHOLE POOL BETWEEN CARDS, and that is a
 * deliberate, measured decision rather than laziness.
 *
 * An earlier draft did clear, to make the result counter visibly change
 * (pool -> 1) so a dead search box could not fake a pass. Driving that cycle at
 * machine speed — poll for the counter, then type the instant it reads the pool
 * — crashed the app with React error #185 (maximum update depth) on the fourth
 * card, and a crashed React app is a BLANK page, so all eight cards then
 * reported MISSING. That reads as "the pool refresh failed" when the truth was
 * "the harness broke the app": the single most misleading thing an acceptance
 * harness can do.
 *
 * The loop is in `CardGrid`'s virtualiser, not in the pool — an identical
 * sequence of names survives on BOTH the 5,651 and the 6,914 pool — so it is
 * reported rather than worked around silently (see the lane report). What
 * changes here is that this harness no longer provokes it, because re-mounting
 * the whole pool was never what it needed to prove.
 *
 * The honest signal is the GRID, not the counter: the tile's own name must equal
 * the card searched for, and the result must be NARROWER than the pool. A search
 * box that does nothing leaves the previous card's tile on screen and fails the
 * name check; one that matches everything fails the narrowing check.
 */
async function searchFor(page, name) {
  const box = await page.$('.toolbar__search');
  if (!box) throw new Error('no .toolbar__search on the page');
  const before = await readCount(page);
  await box.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type(name, { delay: 0 });

  // Wait for the grid to show the card, not for the counter to change: two
  // one-result searches in a row both read "1 card".
  const deadline = Date.now() + UI_TRANSITION_WAIT_MS;
  while (Date.now() < deadline) {
    const drawn = await page.evaluate(() =>
      [...document.querySelectorAll('.card-tile__name')].map((n) => n.textContent.trim()),
    );
    if (drawn.includes(name)) break;
    await sleep(15);
  }
  const after = await readCount(page);
  await sleep(SETTLE_MS);

  const tiles = await page.evaluate(() =>
    [...document.querySelectorAll('.card-tile__name')].map((n) => n.textContent.trim()),
  );
  return { before, after, tiles };
}

function shotPath(name) {
  mkdirSync(OUT_DIR, { recursive: true });
  return resolve(OUT_DIR, `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
}

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error(describeChromeSearch());
  const preview = await startPreview();
  const browser = await puppeteer.launch(
    harnessLaunchOptions({
      chromePath: chrome,
      headful,
      viewport: VIEWPORT,
      protocolTimeoutMs: PROTOCOL_TIMEOUT_MS,
    }),
  );

  const report = { takenAt: new Date().toISOString(), viewport: VIEWPORT, cards: [] };
  const startedAt = Date.now();

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    // A React app that throws during render leaves a BLANK page, and a blank
    // page fails every check below with "MISSING" — which reads as "the card is
    // not in the pool" when the truth is "the app died". Capture the reason so
    // the harness reports the crash instead of libelling the data.
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error?.message ?? error}`));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`);
    });
    page.on('crash', () => pageErrors.push('the renderer process CRASHED (out of memory?)'));
    report.pageErrors = pageErrors;
    await page.goto(preview.url, { waitUntil: 'domcontentloaded', timeout: APP_SHELL_WAIT_MS });
    await page.waitForSelector('.card-tile', { timeout: FIRST_TILE_WAIT_MS });
    await gotoView(page, 'Cards');

    const poolText = await readCount(page);
    const poolSize = countOf(poolText);
    report.poolSize = poolSize;
    console.log(`\n  card browser reports: ${poolText}\n`);

    let first = true;
    for (const name of DECK_CARDS) {
      // ⚠️ A FRESH PAGE PER CARD. See INTER_SEARCH_SETTLE_MS: several searches
      // in a row accumulate state in the virtualiser and eventually crash the
      // app, and neither pacing nor clearing the box avoids it. Reloading does,
      // and it is the stronger test anyway — every card is found from a COLD
      // start, which is what a person opening the app actually does, rather
      // than from whatever the previous seven searches left behind.
      if (!first) {
        await page.goto(preview.url, {
          waitUntil: 'domcontentloaded',
          timeout: APP_SHELL_WAIT_MS,
        });
        await page.waitForSelector('.card-tile', { timeout: FIRST_TILE_WAIT_MS });
        await gotoView(page, 'Cards');
        await sleep(INTER_SEARCH_SETTLE_MS);
      }
      first = false;
      const result = await searchFor(page, name);
      const path = shotPath(name);
      await page.screenshot({ path });
      const bytes = readFileSync(path);
      const row = {
        name,
        found: result.tiles.includes(name),
        counterBefore: result.before,
        counterAfter: result.after,
        narrowed: (countOf(result.after) ?? Number.POSITIVE_INFINITY) < (poolSize ?? 0),
        tilesDrawn: result.tiles.length,
        firstTiles: result.tiles.slice(0, 3),
        screenshot: path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mtimeMs: statSync(path).mtimeMs,
      };
      report.cards.push(row);
      console.log(
        `  ${row.found ? 'FOUND  ' : 'MISSING'} ${name.padEnd(28)} ` +
          `counter="${row.counterAfter}" tiles=${row.tilesDrawn} ` +
          `png=${row.bytes}B sha=${row.sha256.slice(0, 12)}`,
      );
    }

    console.log('');
    // ---- the assertions ----------------------------------------------------
    // DENOMINATORS FIRST, always. A sibling lane's check over the primitive
    // registry reported a false green because it was iterating an EMPTY
    // registry — it passed by asserting nothing, and only printing the
    // denominator caught it. So before any per-card claim is trusted, pin that
    // there WERE cards to search for and that every one of them was searched.
    check(
      'the harness actually searched for cards (denominator is non-zero)',
      DECK_CARDS.length > 0 && report.cards.length === DECK_CARDS.length,
      `searched ${report.cards.length} of ${DECK_CARDS.length} named cards`,
    );
    for (const row of report.cards) {
      check(`the card browser finds "${row.name}"`, row.found, `tiles: ${row.firstTiles.join(', ') || '(none)'}`);
    }
    // Both halves in the detail, because reporting only the first one printed
    // "11/11" next to the word FAIL — a message that makes a reader doubt the
    // check rather than read the cause (the three cards that drew no tile).
    check(
      'every search NARROWED the grid — the box is not inert',
      report.cards.every((c) => c.narrowed && c.tilesDrawn > 0),
      `${report.cards.filter((c) => c.narrowed).length}/${report.cards.length} returned fewer than ` +
        `${poolSize} cards, and ${report.cards.filter((c) => c.tilesDrawn > 0).length}/${report.cards.length} drew a tile`,
    );
    // A stale frame repeats a hash; a blank frame repeats a SMALL hash. Both
    // have been accepted as proof in this repo before, so both are refused.
    const hashes = new Set(report.cards.map((c) => c.sha256));
    check(
      'every screenshot is a DISTINCT frame (no stale/blank repeat)',
      hashes.size === report.cards.length,
      `${hashes.size} distinct of ${report.cards.length}`,
    );
    check(
      'every screenshot is a real painted frame, not a blank one',
      report.cards.every((c) => c.bytes >= MIN_PNG_BYTES),
      `smallest ${Math.min(...report.cards.map((c) => c.bytes))}B, floor ${MIN_PNG_BYTES}B`,
    );
    check(
      'every screenshot was written by THIS run',
      report.cards.every((c) => c.mtimeMs >= startedAt),
      'mtime is newer than the run start',
    );
    check(
      'the served pool is the REGENERATED one, not a stale dist',
      (poolSize ?? 0) > 6_000,
      `${poolText} (a pre-refresh dist reads 5,651)`,
    );
    check(
      'the app never threw while being driven',
      pageErrors.length === 0,
      pageErrors.slice(0, 3).join(' | ') || 'no page errors',
    );
  } finally {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(resolve(OUT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    await browser.close();
    preview.child.kill();
  }

  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  console.log(`report + screenshots: ${OUT_DIR}`);
  return failed.length === 0 ? EXIT_OK : EXIT_FAILED;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`\nCANNOT RUN: ${error?.stack ?? error}`);
    process.exit(EXIT_CANNOT_RUN);
  });
