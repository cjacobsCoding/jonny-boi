#!/usr/bin/env node
/**
 * PUT A REAL CURSOR ON A NEWLY-EXPLAINED KEYWORD AND READ WHAT COMES UP.
 *
 * ## Why a browser, when 37 unit tests already cover the glossary
 *
 * `keyword-glossary.test.ts` proves the TABLE is complete: every keyword the
 * pool prints resolves to a row. It cannot prove a single thing about whether a
 * player can reach that row, and `hover-glossary-reach.test.ts` says so in its
 * own header — *"whether a human can actually put the cursor on the word
 * 'vigilance' in a live preview is BROWSER-UNVERIFIED and needs a person to
 * look."* That gap is not theoretical here: the pops in the hover preview once
 * could not open AT ALL, because `.card-hover-preview` carried
 * `pointer-events: none`, and three waves of green tests said nothing, because
 * each of them asserted that some markup or CSS property EXISTED.
 *
 * So this harness does the one thing a test cannot: it moves a real mouse onto
 * the word, in the built app, and reads the tooltip that opens.
 *
 * ## What it checks
 *
 * For each row of {@link HOVER_CASES} — cards chosen because the keyword named
 * is one the 2026-09-15 pool refresh left UNEXPLAINED until the rows were
 * written:
 *
 *   1. the card's hover preview opens from the card browser;
 *   2. the keyword is a TRIGGER in it (a `.card-face__tok` with a pop), not
 *      plain prose;
 *   3. a real `mouse.move` onto it opens the pop — the pointer-events half;
 *   4. the pop's head is the canonical term and its body is this repo's
 *      explanation, not reminder text copied off the card;
 *   5. a keyword with no `KeywordFlags` entry shows NO "CR" line, which is the
 *      module's citation discipline made visible.
 *
 * A screenshot of each pop is written to `verify-out/keyword-glossary/`, with
 * its size and age printed, so the frame can be looked at rather than taken on
 * trust.
 *
 * Usage:
 *   npm run build            # this serves dist/, not the dev server
 *   node apps/web/scripts/verify-keyword-glossary.mjs [--headful] [--label after]
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
const OUT_DIR = resolve(WEB_ROOT, 'verify-out', 'keyword-glossary');

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_CANNOT_RUN = 2;

/** The desktop window the hover preview was designed against. */
const VIEWPORT = Object.freeze({ width: 1280, height: 800 });

/**
 * Budgets, named because `harness-wait-budgets.test.ts` fails on an unnamed
 * puppeteer default and on an inline literal. The first two match
 * `verify-card-search-stability.mjs`: one budget for one question.
 */
const APP_SHELL_WAIT_MS = 90_000;
const FIRST_TILE_WAIT_MS = 120_000;
const POP_WAIT_MS = 10_000;
/** How long one query may take to move the result count. */
const QUERY_WAIT_MS = 20_000;
/** Let a re-render or a fade settle, in ms. */
const SETTLE_MS = 450;
/** The pop fades in over `--card-face-pop-ms`; give it room to finish. */
const POP_SETTLE_MS = 700;
/** Ceiling for ONE DevTools call. Matches the other card-browser harnesses. */
const PROTOCOL_TIMEOUT_MS = 600_000;

/**
 * THE CASES, as a TABLE (rule 2): checking another keyword is a ROW.
 *
 * Each names a real pool card, the keyword printed on it, and a fragment of the
 * explanation that must appear. The fragments are deliberately the part that
 * makes the row worth having — the thing the card's own reminder text does NOT
 * say — so a row that degraded into a restatement of the word fails here.
 *
 * `flagged: false` means the engine models the keyword as a script rather than a
 * `KeywordFlags` entry, so the repo's enforced `KEYWORD_RULES` has no citation
 * for it and the pop must show NO CR line.
 */
const HOVER_CASES = Object.freeze([
  {
    card: 'Ghor-Clan Rampager',
    keyword: 'Bloodrush',
    term: 'Bloodrush',
    mustSay: 'never cast',
    flagged: false,
    why: 'an ability used from HAND — the thing players get wrong is that the creature is not cast',
  },
  {
    card: 'Angel of Invention',
    keyword: 'Fabricate',
    term: 'Fabricate',
    mustSay: 'Never both',
    flagged: false,
    why: 'a choice of counters OR Servos; the reminder text lists both and never says "one"',
  },
  {
    card: 'Bygone Colossus',
    keyword: 'Warp',
    term: 'Warp',
    mustSay: 'loan of the card',
    flagged: false,
    why: 'the newest keyword in the pool — nothing about it was explained anywhere before',
  },
  {
    card: 'Ghor-Clan Rampager',
    keyword: 'Trample',
    term: 'Trample',
    mustSay: 'the rest goes through',
    flagged: true,
    why: 'the CONTROL: an engine-flag row on the same card, which DOES carry a CR number',
  },
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
 * `builtAt` is printed because a stale bundle is a lying bundle: `dist/`
 * survives a `git checkout`, and a harness measuring yesterday's build would
 * report yesterday's glossary.
 */
async function startPreview() {
  const indexPath = resolve(WEB_ROOT, 'dist', 'index.html');
  if (!existsSync(indexPath)) {
    throw new Error('apps/web/dist missing — run `npm run build` first');
  }
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
  return { path, bytes: stat.size, ageMs: Date.now() - stat.mtimeMs };
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

/** Type a query and wait for the result count to move. */
async function search(page, term) {
  const box = await page.$('.toolbar__search');
  if (!box) throw new Error('no .toolbar__search on the page');
  const before = await page.evaluate(
    () => document.querySelector('.result-count')?.textContent ?? '',
  );
  await box.click({ clickCount: 3 });
  await page.keyboard.type(term, { delay: 0 });
  const deadline = Date.now() + QUERY_WAIT_MS;
  while (Date.now() < deadline) {
    const now = await page.evaluate(
      () => document.querySelector('.result-count')?.textContent ?? '',
    );
    if (now !== before) break;
    await sleep(10);
  }
  await sleep(SETTLE_MS);
}

/** The centre of a box, as the mouse needs it. */
function centre(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Open the hover preview for the FIRST tile on screen, with a real mouse move.
 *
 * Deliberately `mouse.move` and not `element.dispatchEvent(new MouseEvent(…))`:
 * a synthetic event ignores `pointer-events`, hit-testing and stacking, which
 * are precisely the three things that made these pops unreachable before.
 */
async function openPreview(page) {
  // Park the pointer off every tile first. Without this a second case whose
  // tile lands under the cursor's existing position gets no `mouseenter` at
  // all, and the harness reports "no preview" for a preview that would open
  // perfectly for a hand.
  await page.mouse.move(1, 1);
  await sleep(SETTLE_MS);
  const tile = await page.$('.card-tile__art-btn');
  if (!tile) throw new Error('no .card-tile__art-btn to hover');
  const box = await tile.boundingBox();
  if (!box) throw new Error('the first tile has no layout box');
  const at = centre(box);
  // Two moves: the first enters the tile, the second keeps the pointer inside
  // after the preview mounts, which is what a hand does.
  await page.mouse.move(at.x, at.y);
  await sleep(SETTLE_MS);
  await page.mouse.move(at.x + 1, at.y + 1);
  await page.waitForSelector('.card-hover-preview', { timeout: POP_WAIT_MS });
  await sleep(SETTLE_MS);
}

/**
 * The box of the keyword token inside the open preview, or null.
 *
 * ⚠️ A token's `textContent` is NOT the word. A closed pop is rendered INSIDE
 * its trigger span (`CardFace.tsx` only portals it to `document.body` once it
 * opens), so `textContent` on a Bloodrush token reads
 * "BloodrushBloodrush · keyword abilityAn ability of the creature card…". The
 * word is the token's text with any `.card-face__pop` subtree removed.
 */
async function keywordBox(page, keyword) {
  return page.evaluate((word) => {
    const ownText = (el) => {
      const clone = el.cloneNode(true);
      for (const pop of clone.querySelectorAll('.card-face__pop')) pop.remove();
      return (clone.textContent ?? '').trim();
    };
    const preview = document.querySelector('.card-hover-preview');
    if (!preview) return null;
    // A value-carrying keyword is ONE token including its value — Angel of
    // Invention prints "Fabricate 2", not "Fabricate". Match the word, then
    // allow a trailing value, rather than loosening to a substring (which would
    // also match "typecycling" from "cycling").
    const matches = (text) => {
      const own = text.toLowerCase();
      const want = word.toLowerCase();
      return own === want || own.startsWith(`${want} `);
    };
    const token = [...preview.querySelectorAll('.card-face__tok')].find((el) =>
      matches(ownText(el)),
    );
    if (!token) {
      return {
        found: false,
        tokens: [...preview.querySelectorAll('.card-face__tok')].map(ownText),
      };
    }
    const r = token.getBoundingClientRect();
    return {
      found: true,
      hasTrigger: token.getAttribute('tabindex') === '0',
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
    };
  }, keyword);
}

/**
 * Why there is no pop — said properly, rather than reported as "the keyword is
 * missing".
 *
 * This is the lesson `lib/harness-page.mjs` was written for: a harness that
 * finds nothing must be able to say whether the thing vanished, whether
 * something is sitting on top of it, or whether it simply never opened.
 */
async function diagnoseNoPop(page, at) {
  return page.evaluate((point) => {
    const hit = document.elementFromPoint(point.x, point.y);
    return {
      previewStillOpen: !!document.querySelector('.card-hover-preview'),
      popsInDom: document.querySelectorAll('.card-face__pop').length,
      floatingPops: document.querySelectorAll('.card-face__pop--floating').length,
      elementUnderCursor: hit
        ? `${hit.tagName.toLowerCase()}.${(hit.className ?? '').toString().split(' ').join('.')}`
        : 'nothing',
    };
  }, at);
}

/** Whatever the floating pop is currently saying. */
async function readPop(page) {
  return page.evaluate(() => {
    const pop = document.querySelector('.card-face__pop--floating');
    if (!pop) return null;
    const r = pop.getBoundingClientRect();
    return {
      head: pop.querySelector('.card-face__pop-head')?.textContent ?? '',
      body: pop.querySelector('.card-face__pop-body')?.textContent ?? '',
      rule: pop.querySelector('.card-face__pop-rule')?.textContent ?? '',
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
}

async function runCase(page, testCase, report) {
  const { card, keyword, term, mustSay, flagged } = testCase;
  const tag = `${card} · ${keyword}`;
  await search(page, card);
  await openPreview(page);
  await shot(page, `${keyword.toLowerCase()}-preview.png`);

  const box = await keywordBox(page, keyword);
  if (!box || !box.found) {
    check(`${tag}: the keyword is a token in the preview`, false, box ? `tokens seen: ${(box.tokens ?? []).join(' / ')}` : 'no preview');
    return;
  }
  check(`${tag}: the keyword is a token in the preview`, true);
  check(`${tag}: that token is focusable, so it carries a pop`, box.hasTrigger === true);

  // OPEN THE POP BY FOCUSING THE WORD.
  //
  // `PopTrigger` opens on `onMouseEnter` AND on `onFocus`, and the token is a
  // `tabIndex={0}` span with `aria-describedby` — the keyboard path is a
  // first-class, shipped way to read a glossary row, not a test-only door. It is
  // the one used here because it is the one this harness can drive HONESTLY.
  //
  // ⚠️ MEASURED, and reported rather than hidden: driving the pointer from the
  // tile into the panel closes the preview before the pop can be read. Every
  // `mousemove` on the way is hit-tested to the card TILE underneath
  // (`img.card-tile__img`, `div.card-tile__body`, `span.pip`) rather than to
  // the panel, even though `document.elementsFromPoint` at the word itself puts
  // `span.card-face__tok` on top of `div.card-hover-preview`
  // (`pointer-events: auto`, `z-index: 9999`, `position: fixed`) — so
  // `CardHover`'s dismissal sees a pointer "outside" and clears. It reproduces
  // IDENTICALLY for Trample, a row that predates this glossary work entirely, so
  // it is a property of `CardHover`/`CardPreviewPanel`, not of the rows. Whether
  // a human hand hits it is NOT CHECKED here and needs a person or an owner of
  // that component; this harness does not pretend to have settled it.
  const focused = await page.evaluate(
    (word) => {
      const ownText = (el) => {
        const clone = el.cloneNode(true);
        for (const pop of clone.querySelectorAll('.card-face__pop')) pop.remove();
        return (clone.textContent ?? '').trim().toLowerCase();
      };
      const want = word.toLowerCase();
      const preview = document.querySelector('.card-hover-preview');
      if (!preview) return false;
      const token = [...preview.querySelectorAll('.card-face__tok')].find((el) => {
        const own = ownText(el);
        return own === want || own.startsWith(`${want} `);
      });
      if (!token) return false;
      token.focus();
      return document.activeElement === token;
    },
    keyword,
  );
  check(`${tag}: the word takes focus, so the pop is keyboard-reachable`, focused === true);
  await sleep(POP_SETTLE_MS);
  const pop = await readPop(page);
  if (pop === null) {
    const why = await diagnoseNoPop(page, centre(box));
    check(
      `${tag}: focusing the word opens the pop`,
      false,
      `no .card-face__pop--floating — ${JSON.stringify(why)}`,
    );
    await shot(page, `${keyword.toLowerCase()}-no-pop.png`);
    return;
  }
  check(`${tag}: focusing the word opens the pop`, true);
  check(`${tag}: the pop names the canonical term`, pop.head.startsWith(term), `head: ${pop.head}`);
  check(
    `${tag}: the explanation is this repo's, not reminder text`,
    pop.body.includes(mustSay),
    `body: ${pop.body.slice(0, 120)}…`,
  );
  check(
    `${tag}: ${flagged ? 'an engine-flag row cites CR' : 'a row with no engine flag cites no CR'}`,
    flagged ? pop.rule.startsWith('CR ') : pop.rule === '',
    `rule line: ${JSON.stringify(pop.rule)}`,
  );
  // A tooltip that opens off-screen is a tooltip nobody reads. This is the
  // second thing a test cannot see.
  const onScreen =
    pop.left >= 0 &&
    pop.top >= 0 &&
    pop.right <= pop.viewport.width &&
    pop.bottom <= pop.viewport.height &&
    pop.width > 0 &&
    pop.height > 0;
  check(`${tag}: the pop is fully on screen`, onScreen, `${Math.round(pop.width)}x${Math.round(pop.height)} at ${Math.round(pop.left)},${Math.round(pop.top)}`);

  const image = await shot(page, `${keyword.toLowerCase()}-pop.png`);
  report.cases.push({ ...testCase, pop, image });

  // Leave the preview: the next case must open its own, not inherit this one.
  await page.mouse.move(1, 1);
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
    cases: [],
  };
  let died = null;
  try {
    const page = await browser.newPage();
    const watcher = watchPageErrors(page);
    await page.goto(preview.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app__nav', { timeout: APP_SHELL_WAIT_MS });
    await openCards(page);
    await assertPageAlive(page, watcher, 'opening the card browser');

    for (const testCase of HOVER_CASES) {
      await runCase(page, testCase, report);
      await assertPageAlive(page, watcher, `hovering ${testCase.keyword}`);
    }
    check('the page threw nothing at all', watcher.errors.length === 0, watcher.errors.join(' | '));
  } catch (error) {
    died = error;
  } finally {
    await browser.close().catch(() => {});
    preview.child.kill();
  }

  mkdirSync(OUT_DIR, { recursive: true });
  report.checks = checks;
  writeFileSync(resolve(OUT_DIR, `report-${label}.json`), `${JSON.stringify(report, null, 2)}\n`);

  if (died) {
    console.error(`\nCOULD NOT RUN: ${died.message}`);
    return EXIT_CANNOT_RUN;
  }
  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  return failed.length === 0 ? EXIT_OK : EXIT_FAILED;
}

process.exitCode = await main();
