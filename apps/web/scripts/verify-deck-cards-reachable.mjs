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
 * The eight cards from `docs/decks/*.txt` that the wave-5 compiler families
 * unblocked. They are the acceptance case BECAUSE they are Caleb's own — a
 * campaign that only reaches cards which happen to be easy is measuring itself.
 * Names are the printed Oracle names, which is the join key the index uses.
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
async function searchFor(page, name) {
  const box = await page.$('.toolbar__search');
  if (!box) throw new Error('no .toolbar__search on the page');
  const before = await readCount(page);
  await box.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type(name, { delay: 0 });

  const deadline = Date.now() + UI_TRANSITION_WAIT_MS;
  let after = before;
  while (Date.now() < deadline) {
    after = await readCount(page);
    if (after !== before) break;
    await sleep(15);
  }
  await sleep(SETTLE_MS);

  const tiles = await page.evaluate(() =>
    [...document.querySelectorAll('.card-tile__name')].map((n) => n.textContent.trim()),
  );
  return { before, after, tiles, changed: after !== before };
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
    await page.goto(preview.url, { waitUntil: 'domcontentloaded', timeout: APP_SHELL_WAIT_MS });
    await page.waitForSelector('.card-tile', { timeout: FIRST_TILE_WAIT_MS });
    await gotoView(page, 'Cards');

    const poolText = await readCount(page);
    const poolSize = countOf(poolText);
    report.poolSize = poolSize;
    console.log(`\n  card browser reports: ${poolText}\n`);

    for (const name of DECK_CARDS) {
      const result = await searchFor(page, name);
      const path = shotPath(name);
      await page.screenshot({ path });
      const bytes = readFileSync(path);
      const row = {
        name,
        found: result.tiles.includes(name),
        counterChanged: result.changed,
        counterAfter: result.after,
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
    check(
      'every search actually re-filtered the grid',
      report.cards.every((c) => c.counterChanged),
      `${report.cards.filter((c) => c.counterChanged).length}/${report.cards.length} changed the counter`,
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
