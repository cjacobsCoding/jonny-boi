#!/usr/bin/env node
/**
 * Drive the BUILT app in a real Chrome and prove the two game-resume promises
 * end to end (DESIGN §3.58) — the parts no unit test can reach, because they
 * live in the service worker, the reload, and the real localStorage:
 *
 *   1. RESUME EXACTLY — start a Solo game, play turns, hard-reload the tab:
 *      the Play menu offers "Resume game", and resuming reproduces the exact
 *      board (asserted on the rendered board text, the log, and scrollY).
 *   2. UPDATES DEFER — rebuild the app while a game is on screen, poke the SW
 *      update check: the pill appears, the page does NOT reload; leaving the
 *      game applies the update (real skipWaiting + reload), returns to the
 *      Play view, and the game is still resumable on the NEW build.
 *
 * Screenshots land in verify-out/game-resume/ inside the worktree.
 * Exit 0 = every check passed; 1 = a check failed; 2 = could not run.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { describeChromeSearch, findChrome } from './lib/find-chrome.mjs';
import { harnessLaunchOptions } from './lib/harness-chrome.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(WEB_ROOT, 'verify-out', 'game-resume');
const VIEWPORT = { width: 900, height: 560 }; // small on purpose: the board must overflow so scroll restore is provable
const AI_BEAT_MS = 700; // > HOTSEAT_CONFIG.aiThinkMs (450) so the pilot's move lands between steps
const PASS_CLICK_BUDGET = 60; // hard ceiling on the drive loop
const TARGET_TURN = 4; // "several turns"
/**
 * How long the app shell (`.app__nav`) may take to appear after a navigation.
 *
 * NOT a check — a precondition. It replaces puppeteer’s unnamed 30 s default,
 * which nobody chose and which this harness had no headroom against: the view
 * a reload lands on is the 5,651-tile card browser, and those tiles request
 * card art from Scryfall over the INTERNET. Measured on the reference box,
 * post-reload time-to-`.app__nav` is bimodal — ~7.8 s with the art warm in
 * Chrome's cache, and 38.9 s / 40.6 s on the runs where it is not (the same
 * runs whose `performance.getEntriesByType("resource")` shows hundreds of
 * cross-origin `.jpg` fetches). Against the 30 s default that made the harness
 * a coin flip that reported the app as broken when the network was slow.
 *
 * 90 s is the same budget `verify-bug-reporter.mjs` already gives
 * `LAUNCHER_WAIT_MS`, and is ~2x the worst case measured here. Every one of the
 * 18 checks is unchanged; only the wait for the shell to exist is named.
 */
const APP_SHELL_WAIT_MS = 90_000;

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
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

async function startPreview() {
  if (!existsSync(resolve(WEB_ROOT, 'dist', 'index.html'))) {
    throw new Error('apps/web/dist missing — build first');
  }
  const port = await freePort();
  const url = `http://localhost:${port}/`;
  const child = spawn(process.execPath, [viteBin(), 'preview', '--port', String(port), '--strictPort'], {
    cwd: WEB_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await isUp(url)) return { child, url };
    await sleep(300);
  }
  child.kill();
  throw new Error('vite preview did not answer in time');
}

/** Click the first visible button whose trimmed text matches. */
async function clickButton(page, pattern, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const source = pattern.source;
  const flags = pattern.flags;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate(
      (src, flg) => {
        const re = new RegExp(src, flg);
        const buttons = [...document.querySelectorAll('button')];
        const hit = buttons.find((b) => re.test(b.textContent?.trim() ?? '') && !b.disabled);
        if (!hit) return false;
        hit.click();
        return true;
      },
      source,
      flags,
    );
    if (clicked) return true;
    await sleep(200);
  }
  return false;
}

async function textPresent(page, pattern, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate((src) => new RegExp(src).test(document.body.innerText), pattern.source);
    if (found) return true;
    await sleep(200);
  }
  return false;
}

/**
 * The rendered game, as evidence: the whole play surface's text (board, life,
 * hands, LOG — the log only grows through accepted actions, so equality is a
 * strong statement), plus scroll position. Waits for the human's window (the
 * pass button) so the AI is not mid-move while we look.
 */
async function boardFingerprint(page) {
  // Ready = the human's window: either a pass control or a parked question's
  // dialog (a mid-CHOICE stop is a legitimate — and valuable — save point).
  await page.waitForFunction(
    () =>
      document.querySelector('[role="dialog"]') !== null ||
      [...document.querySelectorAll('button')].some((b) => /Pass \/ advance|Pass priority/.test(b.textContent ?? '')),
    { timeout: 30_000 },
  );
  // Two beats of quiet: the AI acts on a 450 ms timer, so a stable read needs
  // the board unchanged across at least that.
  let before = '';
  for (let i = 0; i < 20; i++) {
    const now = await page.evaluate(() => document.querySelector('.play-view')?.innerText ?? '');
    if (now !== '' && now === before) break;
    before = now;
    await sleep(AI_BEAT_MS);
  }
  return page.evaluate(() => ({
    board: document.querySelector('.play-view')?.innerText ?? '',
    scrollY: Math.round(window.scrollY),
    // §3.62 made the play surface a fixed-height canvas: on most windows the
    // PAGE has no scroll range at all, so "restore scrollY" has nothing to
    // restore and asserting a non-zero position would be asserting a bug.
    pageScrollable: document.documentElement.scrollHeight > window.innerHeight + 1,
  }));
}

async function shot(page, name) {
  const path = resolve(OUT_DIR, name);
  await page.screenshot({ path, fullPage: false });
  console.log(`  shot  ${path}`);
  return path;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const chrome = findChrome();
  if (!chrome) throw new Error(describeChromeSearch());
  const preview = await startPreview();
  const browser = await puppeteer.launch(harnessLaunchOptions({ chromePath: chrome }));
  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    page.on('pageerror', (err) => console.log('  pageerror:', String(err).slice(0, 200)));

    // ---- load + install the SW, then reload once so the page is controlled ----
    // `domcontentloaded`, never `networkidle2`: the landing view pulls hundreds of
    // Scryfall card images, so "the network went quiet" depends on an external host
    // and times out on a cold cache. Every navigation here is followed by an
    // explicit wait for what the next assertion actually needs.
    await page.goto(preview.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app__nav', { timeout: APP_SHELL_WAIT_MS });
    await page.evaluate(() => navigator.serviceWorker?.ready);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const controlled = await page.evaluate(() => navigator.serviceWorker?.controller !== null);
    check('service worker installs and controls the page', controlled);

    // ---- start a Solo game -------------------------------------------------------
    await clickButton(page, /^Play$/);
    await clickButton(page, /Solo \(vs the computer\)/);
    check('solo setup reached', await textPresent(page, /Start game/));
    check('start clicked', await clickButton(page, /^Start game$/));
    check('mulligan screen shown', await textPresent(page, /Keep \(/));
    await clickButton(page, /^Keep \(/);
    // A zero-mulligan keep may still show a confirm step; take it if offered.
    await clickButton(page, /^Confirm bottom/, { timeoutMs: 1500 });

    // ---- play several turns (human passes; the pilot plays its side) --------------
    // Stop EARLY if a question parks (e.g. the cleanup "discard down to 7"
    // prompt): a mid-choice board is the hardest save point, so it is the one
    // we want to reload on.
    let sawEnd = false;
    let stoppedMidChoice = false;
    for (let i = 0; i < PASS_CLICK_BUDGET; i++) {
      const state = await page.evaluate(() => {
        const text = document.body.innerText;
        const turn = /Turn\s+(\d+)/.exec(text);
        return {
          turn: turn ? Number(turn[1]) : 0,
          over: /wins the game|Rematch/.test(text),
          dialog: document.querySelector('[role="dialog"]') !== null,
          hasPass: [...document.querySelectorAll('button')].some((b) =>
            /Pass \/ advance|Pass priority/.test(b.textContent ?? ''),
          ),
        };
      });
      if (state.over) {
        sawEnd = true;
        break;
      }
      if (state.dialog && state.turn >= 2) {
        stoppedMidChoice = true;
        break;
      }
      if (state.turn >= TARGET_TURN) break;
      if (state.hasPass) await clickButton(page, /Pass \/ advance|Pass priority/, { timeoutMs: 3000 });
      await sleep(AI_BEAT_MS);
    }
    check('several turns played without the game ending', !sawEnd);
    if (stoppedMidChoice) console.log('  stopped ON A PARKED CHOICE — the reload will happen mid-question');
    const reached = await page.evaluate(() => ({
      turn: /Turn\s+(\d+)/.exec(document.body.innerText)?.[1] ?? '0',
      head: document.body.innerText.slice(0, 400).replace(/\n+/g, ' | '),
      buttons: [...document.querySelectorAll('button')].map((b) => b.textContent?.trim()).slice(0, 20),
    }));
    console.log(`  drive loop ended at turn ${reached.turn}`);
    console.log(`  screen: ${reached.head}`);
    console.log(`  buttons: ${JSON.stringify(reached.buttons)}`);
    await shot(page, '00-drive-loop-end.png');

    // ---- scroll somewhere non-trivial, then let the debounce write ------------------
    await page.evaluate(() => window.scrollTo(0, 240));
    await sleep(600); // > PLAY_PERSIST_DEBOUNCE_MS
    const live = await boardFingerprint(page);
    // A page that fits the window (§3.62) cannot be scrolled; the check then
    // records that fact rather than failing a promise the layout removed. The
    // equality checks below still hold on such a page — 0 restores to 0.
    check(
      'board scrolled to a non-zero position (or the page fits the window)',
      live.pageScrollable ? live.scrollY > 0 : true,
      live.pageScrollable ? `scrollY=${live.scrollY}` : 'page fits the window — no page scroll to restore (§3.62)',
    );
    await shot(page, '01-live-board.png');

    // ---- hard reload: manual navigation, so the MENU offers the resume ---------------
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app__nav', { timeout: APP_SHELL_WAIT_MS });
    await shot(page, '02-after-hard-reload.png');
    await clickButton(page, /^Play$/);
    const bannerShown = await textPresent(page, /Game in progress/);
    check('play menu offers "Resume game" after a hard reload', bannerShown);
    await shot(page, '03-resume-banner.png');
    await clickButton(page, /^Resume game$/);
    const resumed = await boardFingerprint(page);
    check('resumed board text is EXACTLY the live board', resumed.board === live.board);
    check('scroll position restored', resumed.scrollY === live.scrollY, `scrollY=${resumed.scrollY}`);
    if (stoppedMidChoice) {
      check(
        'the PARKED QUESTION is re-presented after the reload',
        await page.evaluate(() => document.querySelector('[role="dialog"]') !== null),
      );
      // Answer it now (first candidate + Confirm) so the game moves on and the
      // update half of the proof runs on an open board.
      await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const option = dialog
          ? [...dialog.querySelectorAll('button')].find((b) => !/Confirm|Cancel/.test(b.textContent ?? ''))
          : null;
        option?.click();
      });
      await clickButton(page, /^Confirm/, { timeoutMs: 5000 });
      await sleep(AI_BEAT_MS);
    }
    await shot(page, '04-resumed-board.png');
    // The answered question moved the game on; re-baseline for the update half.
    const baseline = stoppedMidChoice ? await boardFingerprint(page) : resumed;

    // ---- build an "update" while the game is live ------------------------------------
    console.log('  rebuilding dist as the update…');
    const rebuild = spawnSync(process.execPath, [viteBin(), 'build'], {
      cwd: WEB_ROOT,
      env: { ...process.env, BUILD_COMMIT: 'e2e-second-build' },
      stdio: 'pipe',
      timeout: 300_000,
    });
    if (rebuild.status !== 0) {
      console.error(String(rebuild.stdout).slice(-800), String(rebuild.stderr).slice(-800));
      throw new Error('rebuild failed');
    }
    await page.evaluate(() => {
      window.__e2eNotReloaded = true;
      return navigator.serviceWorker.getRegistration().then((r) => r?.update());
    });
    const pillShown = await textPresent(page, /Update ready — applies when this game ends/, 30_000);
    check('update pill appears, deferring, while the game is live', pillShown);
    const notReloaded = await page.evaluate(() => window.__e2eNotReloaded === true);
    check('the running game was NOT interrupted by the waiting update', notReloaded);
    await shot(page, '05-update-pill-deferred.png');

    // ---- leave the game: the update applies itself (skipWaiting + reload) ------------
    const bundleBefore = await page.evaluate(
      () => document.querySelector('script[type="module"]')?.getAttribute('src') ?? '',
    );
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }),
      clickButton(page, /← Play menu/),
    ]);
    await page.waitForSelector('.app__nav', { timeout: APP_SHELL_WAIT_MS });
    const afterUpdate = await page.evaluate(() => ({
      bundle: document.querySelector('script[type="module"]')?.getAttribute('src') ?? '',
      view: document.querySelector('.nav-link--active')?.textContent?.trim() ?? '',
      flagLeft: sessionStorage.getItem('jonny-boi.update.resume.v1'),
    }));
    check('leaving the game applied the update (page really reloaded on the new bundle)',
      afterUpdate.bundle !== '' && afterUpdate.bundle !== bundleBefore,
      `${bundleBefore} → ${afterUpdate.bundle}`);
    check('the reloaded app returns to the Play view', afterUpdate.view === 'Play', `view=${afterUpdate.view}`);
    check('the resume flag was consumed', afterUpdate.flagLeft === null);
    const bannerAfterUpdate = await textPresent(page, /Game in progress/);
    check('the game survived the update and is offered again', bannerAfterUpdate);
    await shot(page, '06-after-update-back-on-play.png');

    // ---- resume on the NEW build -------------------------------------------------------
    await clickButton(page, /^Resume game$/);
    const resumedOnNew = await boardFingerprint(page);
    check('the game resumes exactly on the NEW build', resumedOnNew.board === baseline.board);
    check('scroll restored again on the new build', resumedOnNew.scrollY === baseline.scrollY);
    await shot(page, '07-resumed-on-new-build.png');
  } finally {
    await browser.close();
    preview.child.kill();
  }

  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
