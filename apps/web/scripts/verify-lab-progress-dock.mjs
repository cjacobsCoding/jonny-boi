#!/usr/bin/env node
/**
 * Is the Lab's progress bar REALLY pinned to the bottom of the screen?
 *
 * WHY THIS SCRIPT EXISTS. DESIGN §3.180 item 4 is a request about PIXELS:
 *
 *   "in all the Lab subtabs, make the loading bar get pinned to the bottom of
 *    the screen while in that area while its working on a lab, so you can scroll
 *    around and still watch the progress."
 *
 * There is no DOM in this repo's vitest suite — no `environment`, no jsdom, no
 * @testing-library — so `getBoundingClientRect` does not exist there and CSS is
 * never loaded. `lab-dock.test.ts` can therefore pin the DECLARATIONS and the
 * render STRUCTURE, and it does; it cannot pin the rectangle. Asserting "it is
 * pinned" from a unit test would be exactly the check-that-cannot-fail this
 * project has paid for most often. This turns it into a command.
 *
 * It launches the Chrome already on the machine (puppeteer-core, no download),
 * serves the BUILT bundle, starts a real gauntlet run, and then measures the
 * dock's actual rectangle while scrolling — at the bottom of the page and at the
 * top — and walks every Lab subtab while the job is still running.
 *
 * Usage:
 *   node apps/web/scripts/verify-lab-progress-dock.mjs [--headful] [--url <url>]
 *
 * Exit codes: 0 every check passed, 1 a check failed, 2 the harness could not
 * run at all (no Chrome, no build). 1 and 2 are different on purpose — "the dock
 * is broken" and "I could not look" must never read the same.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { describeChromeSearch, findChrome } from './lib/find-chrome.mjs';
import { harnessLaunchOptions } from './lib/harness-chrome.mjs';
import { assertPageAlive, watchPageErrors } from './lib/harness-page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(WEB_ROOT, 'verify-out');

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_CANNOT_RUN = 2;

/**
 * A DELIBERATELY SHORT viewport, and this is the whole point of the harness.
 *
 * `verify-bug-reporter.mjs` measured the Lab at "107 nodes, all of it on
 * screen" — at 1280x800 the Lab does not scroll at all, so a scroll test there
 * would pass without ever scrolling anything. Six hundred pixels of height makes
 * the page genuinely taller than the viewport; the run asserts that it did
 * before believing anything the scroll checks say.
 */
const VIEWPORT = { width: 1100, height: 600 };

/** Vite preview is slow to boot on a cold cache; a ceiling, not a wait. */
const PREVIEW_START_MS = 90_000;
/**
 * How long the app shell may take to mount. The landing view pulls hundreds of
 * cross-origin Scryfall images and has measured 38.9 s cold, so puppeteer's
 * unnamed 30 s default reports the APP as broken when the NETWORK is slow.
 */
const APP_SHELL_WAIT_MS = 90_000;
/** How long the Lab's own panel may take to render once its nav is clicked. */
const LAB_PANEL_WAIT_MS = 60_000;
/**
 * How long a started run may take to put the dock on screen. A gauntlet run
 * spins up a worker pool and loads the card pool inside it before the first
 * progress event, which is seconds on a cold cache.
 */
const DOCK_WAIT_MS = 60_000;
/** How long to let React commit after a click before measuring pixels. */
const RENDER_SETTLE_MS = 600;
/** Pixels of slack when comparing the dock's edge to the viewport's. */
const EDGE_TOLERANCE_PX = 2;

const args = process.argv.slice(2);
const headful = args.includes('--headful');
const urlArg = args.indexOf('--url') >= 0 ? args[args.indexOf('--url') + 1] : null;

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A port nothing is listening on, so `--strictPort` cannot lose a race. */
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

/**
 * Start `vite preview` and resolve once it actually answers.
 *
 * POLLED, NOT PARSED: vite does not print its banner when stdout is not a TTY,
 * and a harness that reads the URL out of it reports "did not start" about a
 * server that started perfectly well.
 */
function startPreview() {
  return (async () => {
    if (!existsSync(resolve(WEB_ROOT, 'dist', 'index.html'))) {
      throw new Error('apps/web/dist is missing — run `npm run build` first');
    }
    const port = await freePort();
    const url = `http://localhost:${port}/`;
    const viteBin = [
      resolve(WEB_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
      resolve(WEB_ROOT, '..', '..', 'node_modules', 'vite', 'bin', 'vite.js'),
    ].find((candidate) => existsSync(candidate));
    if (viteBin === undefined) throw new Error('vite is not installed — run `npm install`');
    const child = spawn(process.execPath, [viteBin, 'preview', '--port', String(port), '--strictPort'], {
      cwd: WEB_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (b) => {
      output += String(b);
    });
    child.stderr.on('data', (b) => {
      output += String(b);
    });
    const deadline = Date.now() + PREVIEW_START_MS;
    while (Date.now() < deadline) {
      if (await isUp(url)) return { url, child, port };
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    stopPreview(child);
    throw new Error(`vite preview never answered on ${url}. Its output was:\n${output}`);
  })();
}

/** Kill the preview AND its children, or the port outlives the run. */
function stopPreview(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch {
      // fall through to the portable kill
    }
  }
  child.kill();
}

/** The dock's rectangle and the viewport it is being measured against. */
async function readDock(page) {
  return page.evaluate(() => {
    const dock = document.querySelector('.lab-dock');
    const lab = document.querySelector('.lab');
    const panel = document.querySelector('.lab-panel');
    const scroller = document.scrollingElement ?? document.documentElement;
    return {
      present: dock !== null,
      rect: dock ? dock.getBoundingClientRect().toJSON() : null,
      position: dock ? getComputedStyle(dock).position : null,
      labPaddingBottom: lab ? parseFloat(getComputedStyle(lab).paddingBottom) : 0,
      panelBottom: panel ? panel.getBoundingClientRect().bottom : 0,
      innerHeight: window.innerHeight,
      scrollY: window.scrollY,
      scrollHeight: scroller.scrollHeight,
      maxScroll: scroller.scrollHeight - window.innerHeight,
      barVisible: document.querySelector('.lab-dock .run-status') !== null,
    };
  });
}

/** Assert the dock is flush with the bottom of the VIEWPORT, wherever we scrolled to. */
function checkPinned(where, dock) {
  if (!dock.present || !dock.rect) {
    check(`the dock is on screen ${where}`, false, 'no .lab-dock in the document');
    return;
  }
  check(`the dock is position: fixed ${where}`, dock.position === 'fixed', String(dock.position));
  const gap = Math.abs(dock.rect.bottom - dock.innerHeight);
  check(
    `the dock sits flush with the bottom of the viewport ${where}`,
    gap <= EDGE_TOLERANCE_PX,
    `bottom ${Math.round(dock.rect.bottom)} vs viewport ${dock.innerHeight} (scrollY ${Math.round(dock.scrollY)})`,
  );
  check(
    `the dock is actually visible ${where}`,
    dock.rect.height > 0 && dock.rect.top < dock.innerHeight && dock.barVisible,
    `${Math.round(dock.rect.width)}x${Math.round(dock.rect.height)}`,
  );
}

async function main() {
  const chromePath = findChrome();
  if (chromePath === null) {
    console.error(describeChromeSearch());
    return EXIT_CANNOT_RUN;
  }
  console.log(`Browser: ${chromePath}`);

  let preview = null;
  let url = urlArg;
  if (url === null) {
    try {
      preview = await startPreview();
      url = preview.url;
    } catch (error) {
      console.error(String(error.message ?? error));
      return EXIT_CANNOT_RUN;
    }
  }
  console.log(`App: ${url}`);
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch(harnessLaunchOptions({ chromePath, headful, viewport: VIEWPORT }));

  try {
    const page = await browser.newPage();
    const watcher = watchPageErrors(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PREVIEW_START_MS });
    await page.waitForSelector('.app__nav', { timeout: APP_SHELL_WAIT_MS });

    // WHICH TREE ANSWERED. A screenshot cannot tell two worktrees apart, and a
    // lane on this box has already driven the wrong build. The served bundle is
    // asked for a symbol only this branch introduces.
    const servedMarker = await page.evaluate(async () => {
      const html = await (await fetch('/')).text();
      const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
      for (const src of scripts) {
        const body = await (await fetch(src)).text();
        if (body.includes('lab-dock')) return { src, found: true };
      }
      return { src: scripts.join(', '), found: false };
    });
    check(
      'the server is serving THIS branch (the bundle contains lab-dock)',
      servedMarker.found,
      servedMarker.src,
    );

    await page.evaluate(() => {
      const nav = [...document.querySelectorAll('.nav-link')].find((b) => b.textContent.trim().toLowerCase() === 'lab');
      if (!nav) throw new Error('no nav button labelled Lab');
      nav.click();
    });
    await page.waitForSelector('.lab-panel', { timeout: LAB_PANEL_WAIT_MS });
    await assertPageAlive(page, watcher, 'opening the Lab');

    // IDLE FIRST — the dock must be ABSENT, not an empty bar.
    const idle = await readDock(page);
    check('with no job running there is no dock at all', !idle.present);
    check('and an idle Lab reserves no room for one', idle.labPaddingBottom === 0, `${idle.labPaddingBottom}px`);

    // Start a real run.
    //
    // ⚠️ THE SLIDER IS PUSHED TO ITS MAXIMUM FIRST, and that is not incidental.
    // At the default game count the run finished before the tab walk below got
    // going, so all six tabs reported "nothing to pin" and the walk measured
    // NOTHING — the harness said so rather than passing, which is the point, but
    // a check that cannot reach its subject is not a check. The job has to
    // outlast the walk for the walk to mean anything.
    console.log('\nStarting a gauntlet run…');
    const started = await page.evaluate(() => {
      // ⚠️ EARLY STOPPING HAS TO GO OFF FIRST, and raising the slider alone did
      // not do it. "Stop once the win rate is measured precisely enough" sizes
      // the run to the precision wanted, so a 400-games-per-opponent gauntlet
      // still settled in about two seconds and the tab walk measured 0 of 6
      // tabs. The slider sets the ceiling; this checkbox is what decides whether
      // the run ever reaches it.
      const precise = document.querySelector(
        '.lab-panel input[type="checkbox"][aria-label^="Stop once the win rate"]',
      );
      if (precise?.checked) precise.click();
      const slider = document.querySelector('.lab-panel input[type="range"]');
      if (slider) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        setter?.call(slider, slider.max);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const button = [...document.querySelectorAll('.lab-panel button')].find((b) =>
        b.textContent.toLowerCase().includes('run gauntlet'),
      );
      if (!button) return { clicked: false, why: 'no "Run gauntlet" button' };
      if (button.disabled) return { clicked: false, why: 'the Run button is disabled' };
      button.click();
      return {
        clicked: true,
        why: `${slider?.value ?? 'default'} games per opponent, early stopping ${precise ? (precise.checked ? 'ON' : 'off') : 'not found'}`,
      };
    });
    check('a real run could be started', started.clicked, started.why);
    if (!started.clicked) {
      const failed = checks.filter((c) => !c.passed);
      console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
      return EXIT_FAILED;
    }
    await page.waitForSelector('.lab-dock', { timeout: DOCK_WAIT_MS });
    await assertPageAlive(page, watcher, 'starting a run');

    // THE PAGE MUST ACTUALLY SCROLL, or every scroll check below is vacuous.
    const atTop = await readDock(page);
    check(
      'the Lab is taller than the viewport, so scrolling means something',
      atTop.maxScroll > 0,
      `page ${Math.round(atTop.scrollHeight)}px vs viewport ${atTop.innerHeight}px`,
    );
    checkPinned('at the top of the page', atTop);

    // SCROLLED TO THE BOTTOM.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((r) => setTimeout(r, RENDER_SETTLE_MS));
    const atBottom = await readDock(page);
    check(
      'the page really did scroll to the bottom',
      atBottom.scrollY > 0,
      `scrollY ${Math.round(atBottom.scrollY)} of ${Math.round(atBottom.maxScroll)}`,
    );
    checkPinned('scrolled to the bottom', atBottom);

    // ...AND THE LAST ROW OF CONTENT IS STILL REACHABLE.
    check(
      'the dock does not cover the last row of the panel',
      atBottom.rect !== null && atBottom.panelBottom <= atBottom.rect.top + EDGE_TOLERANCE_PX,
      `panel ends at ${Math.round(atBottom.panelBottom)}, dock starts at ${Math.round(atBottom.rect?.top ?? 0)}`,
    );
    check(
      'the Lab reserves room while the dock is up',
      atBottom.labPaddingBottom > 0,
      `${atBottom.labPaddingBottom}px`,
    );

    // BACK TO THE TOP.
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, RENDER_SETTLE_MS));
    checkPinned('scrolled back to the top', await readDock(page));

    // THE SCREENSHOT, scrolled down, with the job actually running.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((r) => setTimeout(r, RENDER_SETTLE_MS));
    const shot = await page.screenshot({ encoding: 'binary' });
    writeFileSync(resolve(OUT_DIR, 'lab-dock-scrolled.png'), shot);
    check('a screenshot of the scrolled, running Lab was captured', shot.length > 10_000, `${Math.round(shot.length / 1024)} KB`);

    // EVERY SUBTAB, each running a job OF ITS OWN.
    //
    // ⚠️ MEASURED, AND IT CHANGED THIS CHECK. Clicking a Lab tab calls
    // `sim.reset()` (`LabView.tsx`), so a job does NOT survive a tab switch —
    // an earlier version of this harness started one gauntlet run and walked
    // the tabs expecting to still see it, and measured 0 of 6 tabs because the
    // first click had cancelled the run. The app is not wrong and neither is the
    // request: "while in that area while its working" means the tab you are ON
    // shows its own job. So each tab is asked to start its own work.
    //
    // A tab whose primary action is not available from a standing start is
    // reported as NOT COVERED rather than skipped quietly.
    console.log('\nStarting a job on each Lab subtab in turn…');
    // The standing gauntlet job has to go first: a tab's own Run button is
    // disabled while ANY job is in flight, so leaving it running would have the
    // walk report "no enabled primary action" for every tab it visits.
    await page.evaluate(() => {
      const cancel = [...document.querySelectorAll('.lab-dock button')].find((b) =>
        b.textContent.toLowerCase().includes('cancel'),
      );
      if (cancel) cancel.click();
    });
    await new Promise((r) => setTimeout(r, RENDER_SETTLE_MS));

    const tabLabels = await page.evaluate(() =>
      [...document.querySelectorAll('.lab-tab')].map((b) => b.textContent.trim()),
    );
    check('the Lab exposes its subtabs to walk', tabLabels.length > 1, tabLabels.join(' · '));
    const covered = [];
    const uncovered = [];
    for (const label of tabLabels) {
      // ⚠️ TWO STEPS WITH A RENDER BETWEEN THEM, and the first version of this
      // was one. Clicking the tab and reading `.lab-panel` in the same
      // synchronous block reads the OUTGOING panel, because React has not
      // committed yet — so the walk clicked the previous tab's button and
      // cheerfully reported 'Trim' passing by pressing "Suggest swaps".
      const switched = await page.evaluate((wanted) => {
        const tab = [...document.querySelectorAll('.lab-tab')].find((b) => b.textContent.trim() === wanted);
        if (!tab) return false;
        tab.click();
        return true;
      }, label);
      if (!switched) {
        uncovered.push(`${label} (no such tab)`);
        continue;
      }
      await new Promise((r) => setTimeout(r, RENDER_SETTLE_MS));
      const startedHere = await page.evaluate(() => {
        const precise = document.querySelector(
          '.lab-panel input[type="checkbox"][aria-label^="Stop once the win rate"]',
        );
        if (precise?.checked) precise.click();
        const button = [...document.querySelectorAll('.lab-panel button.btn--primary')].find((b) => !b.disabled);
        if (!button) return { ok: false, why: 'no enabled primary action on this tab' };
        button.click();
        return { ok: true, why: button.textContent.trim() };
      });
      if (!startedHere.ok) {
        uncovered.push(`${label} (${startedHere.why})`);
        continue;
      }
      let here = null;
      try {
        await page.waitForSelector('.lab-dock', { timeout: DOCK_WAIT_MS });
        here = await readDock(page);
      } catch {
        here = null;
      }
      if (!here?.present || !here.rect) {
        uncovered.push(`${label} (the job ended before it could be measured)`);
        continue;
      }
      covered.push(label);
      check(
        `'${label}' pins the dock while ITS OWN job runs — "${startedHere.why}"`,
        Math.abs(here.rect.bottom - here.innerHeight) <= EDGE_TOLERANCE_PX && here.position === 'fixed',
        `bottom ${Math.round(here.rect.bottom)} vs viewport ${here.innerHeight}`,
      );
      await page.evaluate(() => {
        const cancel = [...document.querySelectorAll('.lab-dock button')].find((b) =>
          b.textContent.toLowerCase().includes('cancel'),
        );
        if (cancel) cancel.click();
      });
      await new Promise((r) => setTimeout(r, RENDER_SETTLE_MS));
    }
    // ⚠️ THE NON-VACUITY GUARD: a walk that measured nothing must not read as a
    // pass. It names the tabs it could not cover rather than printing a total.
    check(
      'every Lab subtab was actually measured with a job in flight',
      uncovered.length === 0,
      uncovered.length === 0 ? `all ${covered.length}` : `covered ${covered.join(', ')} — NOT covered: ${uncovered.join('; ')}`,
    );

    // AND IT GOES AWAY. Cancel, and the dock must vanish along with the reserve.
    console.log('\nCancelling…');
    await page.evaluate(() => {
      const cancel = [...document.querySelectorAll('.lab-dock button')].find((b) =>
        b.textContent.toLowerCase().includes('cancel'),
      );
      if (cancel) cancel.click();
    });
    await new Promise((r) => setTimeout(r, RENDER_SETTLE_MS * 3));
    const afterCancel = await readDock(page);
    check('the dock disappears when no job is running', !afterCancel.present);
    check('and the reserved room goes with it', afterCancel.labPaddingBottom === 0, `${afterCancel.labPaddingBottom}px`);

    check('the page threw nothing while all of that happened', watcher.errors.length === 0, watcher.errors.join(' | '));

    const failed = checks.filter((c) => !c.passed);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
    console.log(`Screenshot written to ${OUT_DIR} — LOOK at lab-dock-scrolled.png.`);
    return failed.length === 0 ? EXIT_OK : EXIT_FAILED;
  } finally {
    await browser.close();
    stopPreview(preview?.child);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(EXIT_CANNOT_RUN);
  });
