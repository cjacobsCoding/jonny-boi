#!/usr/bin/env node
/**
 * Drive the BUILT app in a real Chrome and prove the §3.62 promise: THE BOARD
 * FITS THE WINDOW.
 *
 * This harness exists because the claim is a LAYOUT claim, and layout is the one
 * thing the unit suite cannot see — jsdom has no viewport, no flexbox and no
 * `dvh`, so a rule that silently loses the cascade (which happened twice while
 * this was built: once on source order, once by styling `.play-card` when the
 * battlefield renders `.perm`) passes every test in the repo while the board
 * stays exactly as broken as it was. The assertions below are therefore
 * MEASUREMENTS taken from a real engine, at real viewport sizes:
 *
 *   1. NOTHING SCROLLS — neither the page nor the board's own box.
 *   2. THE THINGS YOU PLAY WITH ARE ON SCREEN — the status line, your hand and
 *      the action bar, all fully inside the viewport.
 *   3. IT SURVIVES A REAL BOARD — the same checks after playing the game out to
 *      a crowded battlefield, not just on turn one.
 *   4. A TALL WINDOW IS UNCHANGED — cards resolve to the pre-§3.62 148px, so
 *      this bought the small window without taxing the large one.
 *   5. A PHONE FITS TOO — 375x812, the size the PWA is actually carried around
 *      on.
 *
 * The board is arranged by PLAYING through the real UI, never by poking state.
 *
 * Screenshots land in verify-out/board-fits/ inside the worktree.
 * Exit 0 = every check passed; 1 = a check failed; 2 = could not run.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { describeChromeSearch, findChrome } from './lib/find-chrome.mjs';
import { harnessLaunchOptions } from './lib/harness-chrome.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(WEB_ROOT, 'verify-out', 'board-fits');

/**
 * The sizes that matter, and why each one is here rather than a round number:
 * `laptop` is the window the report was filed against and the one the old
 * layout missed by 271px; `tall` must show the full-size cards the app shipped
 * with before this change; `phone` is the PWA's actual home.
 */
const VIEWPORTS = Object.freeze({
  laptop: { width: 1280, height: 800 },
  tall: { width: 1440, height: 1100 },
  phone: { width: 375, height: 812 },
});

/** The card width the app used before §3.62 — a tall window must still get it. */
const FULL_CARD_WIDTH_PX = 148;
const AI_BEAT_MS = 700; // > HOTSEAT_CONFIG.aiThinkMs (450)
const DRIVE_STEPS = 260; // enough to reach a crowded board; the loop stops early when it does
const CROWDED_ENOUGH = 8; // permanents that count as "a real board" rather than turn one

/**
 * How long to wait for the app SHELL after a navigation — and why it is not 20 s.
 *
 * ⚠️ This harness shipped with 20 s, which is BELOW the worst case anyone has
 * measured. §3.146's gate instrumented time-to-shell and found it BIMODAL: ~7.8 s
 * when the landing view's Scryfall art is cached, ~38.9 s when it is not (the
 * landing view is the card browser, which fetches hundreds of cross-origin
 * images). So on a cold cache this harness reported the APP as broken when the
 * NETWORK was slow — and 20 s is a TIGHTER coin flip than puppeteer's own 30 s
 * default, which is how it went unnoticed while its sibling was being fixed.
 *
 * 90 s matches `LAUNCHER_WAIT_MS` in `verify-bug-reporter.mjs` and
 * `APP_SHELL_WAIT_MS` in the other two harnesses — one budget for one question.
 * None of the 32 checks changed; only the wait for the shell to exist.
 */
const APP_SHELL_WAIT_MS = 90_000;

/**
 * Waits for an IN-APP transition (a menu opening, the board mounting) once the
 * shell is already up. Kept separate from {@link APP_SHELL_WAIT_MS} on purpose:
 * these do not touch the network, so a long budget here would only turn a real
 * hang into a slow one. 20 s is the value this harness has always used.
 */
const UI_TRANSITION_WAIT_MS = 20_000;

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
    throw new Error('apps/web/dist missing — run `npm run build` first');
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

async function clickButton(page, pattern, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate(
      (src, flg) => {
        const re = new RegExp(src, flg);
        const hit = [...document.querySelectorAll('button')].find(
          (b) => re.test(b.textContent?.trim() ?? '') && !b.disabled,
        );
        if (!hit) return false;
        hit.click();
        return true;
      },
      pattern.source,
      pattern.flags,
    );
    if (clicked) return true;
    await sleep(200);
  }
  return false;
}

async function shot(page, name) {
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(OUT_DIR, name) });
}

/**
 * The one place the board is measured. Everything the checks assert comes from
 * here, so a selector change breaks one function rather than nine assertions.
 *
 * "Visible" means FULLY inside the viewport — a hand half off the bottom edge is
 * the exact failure this whole change is about, and `top >= 0` alone would call
 * it a pass.
 */
async function measure(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const board = document.querySelector('.play-board');
    if (!board) return null;
    const whole = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.top >= -1 && r.bottom <= window.innerHeight + 1;
    };
    const hand = [...document.querySelectorAll('.play-hand')].find((h) => !h.className.includes('hidden'));
    // The HAND card specifically — not the first `.play-card--full` in document
    // order — and, beside it, what the size token actually resolves to on this
    // window. The token is a clamp(); only a real box resolves it, so a probe
    // element borrows it for one frame. Comparing the two is the check that
    // catches a card drawn at the wrong size while still "smaller than 148".
    const card = document.querySelector('.play-board .play-hand:not(.play-hand--hidden) .play-card--full');
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--play-card-w)';
    board.appendChild(probe);
    const tokenCardWidth = Math.round(parseFloat(getComputedStyle(probe).width));
    probe.remove();
    // A seat squeezed past its own rail hides the life total it exists to show.
    const seats = [...document.querySelectorAll('.play-board .seat')];
    const seatClipped = seats.some((seat) => seat.scrollHeight > seat.clientHeight + 1);
    const railClipped = [...document.querySelectorAll('.play-board .seat__zones')].some((zones) => {
      const rail = zones.getBoundingClientRect();
      const seat = zones.closest('.seat').getBoundingClientRect();
      return rail.bottom > seat.bottom + 1 || rail.top < seat.top - 1;
    });
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      pageScrolls: de.scrollHeight > window.innerHeight + 1,
      boardScrolls: board.scrollHeight > board.clientHeight + 1,
      boardNeeds: board.scrollHeight,
      boardHas: board.clientHeight,
      permanents: document.querySelectorAll('.play-board .perm').length,
      statusVisible: whole(document.querySelector('.play-board__status')),
      handVisible: whole(hand),
      actionBarVisible: whole(document.querySelector('.action-bar')),
      cardWidth: card ? Math.round(parseFloat(getComputedStyle(card).width)) : null,
      tokenCardWidth,
      seatClipped,
      railClipped,
    };
  });
}

/** Assert the whole promise at one viewport, under one label. */
function assertFits(label, m) {
  check(`${label}: the PAGE does not scroll`, m.pageScrolls === false);
  check(
    `${label}: the BOARD does not scroll`,
    m.boardScrolls === false,
    `needs ${m.boardNeeds} of ${m.boardHas}`,
  );
  check(`${label}: the turn/priority line is fully visible`, m.statusVisible === true);
  check(`${label}: YOUR HAND is fully visible`, m.handVisible === true);
  check(`${label}: the action bar is fully visible`, m.actionBarVisible === true);
  // Fitting the window is not worth much if a seat fits by hiding its own life
  // total — which is exactly what the first version of rule 5 did.
  check(`${label}: no seat is clipped`, m.seatClipped === false);
  check(`${label}: every seat's life/zone rail is intact`, m.railClipped === false);
}

/** Start a Solo game on a fixed deck and keep the opening hand. */
async function startSoloGame(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button.nav-link', { timeout: APP_SHELL_WAIT_MS });
  await page.evaluate(() => {
    // A saved game would open the resume banner instead of the setup screen.
    try {
      localStorage.removeItem('jonny-boi.play.inProgress.v1');
    } catch {
      /* private mode — there was nothing to clear anyway */
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button.nav-link', { timeout: APP_SHELL_WAIT_MS });
  await clickButton(page, /^Play$/);
  await clickButton(page, /Solo \(vs the computer\)/);
  await page.waitForSelector('select', { timeout: UI_TRANSITION_WAIT_MS });
  await page.evaluate(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    const select = document.querySelectorAll('select')[0];
    setter.call(select, 'sample:Selesnya Blink');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await clickButton(page, /^Start game$/);
  await clickButton(page, /^Keep \(/, { timeoutMs: 20_000 });
  await page.waitForSelector('.play-board', { timeout: UI_TRANSITION_WAIT_MS });
  await sleep(AI_BEAT_MS);
}

/** Play the game forward until the battlefield is genuinely crowded. */
async function drivePlayer(page) {
  for (let i = 0; i < DRIVE_STEPS; i++) {
    const done = await page.evaluate((crowded) => {
      if (document.querySelector('.end-screen')) return true;
      const perms = document.querySelectorAll('.play-board .perm').length;
      if (perms >= crowded) return true;
      const hand = [...document.querySelectorAll('.play-hand')].find((h) => !h.className.includes('hidden'));
      const playable = hand ? [...hand.querySelectorAll('button.play-card--actionable')] : [];
      if (playable.length) {
        playable[0].click();
        return false;
      }
      const next = [...document.querySelectorAll('button')].find(
        (b) => /Pass \/ advance|Pass priority|No blocks|Attack with|^Confirm/.test(b.textContent ?? '') && !b.disabled,
      );
      if (next) next.click();
      return false;
    }, CROWDED_ENOUGH);
    if (done) break;
    await sleep(110);
  }
  await sleep(AI_BEAT_MS);
}

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error(describeChromeSearch());
  const preview = await startPreview();
  const browser = await puppeteer.launch(
    harnessLaunchOptions({ chromePath: chrome, windowSize: VIEWPORTS.laptop }),
  );

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORTS.laptop);
    await startSoloGame(page, preview.url);

    // 1 + 2 — the reported window, on a fresh board.
    const fresh = await measure(page);
    if (!fresh) throw new Error('no board rendered');
    assertFits('laptop 1280x800, turn 1', fresh);
    check(
      'laptop: cards shrank to fit rather than overflowing',
      fresh.cardWidth !== null && fresh.cardWidth < FULL_CARD_WIDTH_PX,
      `${fresh.cardWidth}px`,
    );
    // "Smaller than full size" passed for MONTHS while hands rendered at tile
    // size (80px where the token said 112px): a competing rule won the cascade.
    // The hand card must be exactly what the size token resolves to here.
    check(
      'laptop: the hand card is drawn at the size token’s value, not a competing rule’s',
      fresh.cardWidth !== null && fresh.cardWidth === fresh.tokenCardWidth,
      `card ${fresh.cardWidth}px vs token ${fresh.tokenCardWidth}px`,
    );
    await shot(page, '01-laptop-turn-1.png');

    // 3 — the same window once the battlefield is actually full.
    await drivePlayer(page);
    const crowded = await measure(page);
    check(
      'the game reached a real board to measure',
      crowded.permanents >= CROWDED_ENOUGH,
      `${crowded.permanents} permanents`,
    );
    assertFits(`laptop 1280x800, ${crowded.permanents} permanents`, crowded);
    await shot(page, '02-laptop-crowded.png');

    // 4 — a tall window pays no tax for the small one.
    await page.setViewport(VIEWPORTS.tall);
    await sleep(500);
    const tall = await measure(page);
    assertFits('tall 1440x1100', tall);
    check(
      'a tall window still gets the FULL-SIZE cards the app shipped with',
      tall.cardWidth === FULL_CARD_WIDTH_PX,
      `${tall.cardWidth}px`,
    );
    await shot(page, '03-tall-full-size.png');

    // 5 — the phone the PWA lives on.
    await page.setViewport(VIEWPORTS.phone);
    await sleep(500);
    const phone = await measure(page);
    assertFits('phone 375x812', phone);
    await shot(page, '04-phone.png');
  } finally {
    await browser.close().catch(() => {});
    preview.child.kill();
  }

  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('could not run:', err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
