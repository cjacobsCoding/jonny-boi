/**
 * SEE THE ONLINE BOARD: drive a REAL two-seat ONLINE game and photograph it.
 *
 * Why this exists: there was no screenshot of the online board anywhere in this
 * project. Every online claim on this branch rested on `renderToStaticMarkup`
 * tests — and this repo has shipped SEVEN items that were green and unreachable
 * (docs/MTGA-UX-OVERHAUL.md §7.3, §10). So "the online board now shares the
 * scene" (§11) gets PHOTOGRAPHED, not asserted.
 *
 * Two isolated browser contexts (separate localStorage, so two genuine seats)
 * against a real `apps/server` over a real socket. The client takes the server
 * from the `?server=` query param (`online-config.ts`), so no rebuild is needed
 * beyond `npm run build` — it serves `dist` through `vite preview`.
 *
 * Launches through the shared harness Chrome options: headless and MUTED, so a
 * verification run is neither seen nor heard.
 *
 * ## ⚠️ IT IS NOT A `verify-*` HARNESS, and the difference matters
 *
 * It prints what it SAW; it asserts no contract and exits 0 on a game it merely
 * failed to walk into combat. Read the numbers, look at the PNGs in
 * `verify-out/online/`. Promoting it to a gate means giving it a contract and a
 * falsification pass first.
 *
 * ## Three ways it lied before it worked — all harness bugs that read as product bugs
 *
 *  1. it scraped the room code from `body.textContent`, which ran the neighbouring
 *     Share button onto the end ("99JUTShare") and the server rightly refused the join;
 *  2. it waited for `.play-board` without answering the MULLIGAN screen that sits
 *     between Ready and the board, then reported a 40s timeout;
 *  3. its driver clicked the first non-land in hand — burn spells — so it parked on
 *     a target prompt it never answered and spun out its whole budget.
 *
 * §7.3's third finding, again: a red harness is a claim about the harness before
 * it is a claim about the code.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { findChrome } from './lib/find-chrome.mjs';
import { harnessLaunchOptions } from './lib/harness-chrome.mjs';

const WEB_ROOT = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(WEB_ROOT, '..', '..');
const OUT_DIR = resolve(WEB_ROOT, 'verify-out', 'online');
const APP_SHELL_WAIT_MS = 90_000;
const VIEWPORT = { width: 1440, height: 1100 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
async function isUp(u) { try { return (await fetch(u, { signal: AbortSignal.timeout(2000) })).status > 0; } catch { return false; } }

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [resolve(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), resolve(REPO_ROOT, 'apps', 'server', 'src', 'main.ts')], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('  [server] ' + String(d)));
  child.stderr.on('data', (d) => process.stdout.write('  [server!] ' + String(d)));
  await sleep(3500); // it binds a socket, not an HTTP route we can poll
  return { child, url: `ws://localhost:${port}` };
}

async function startPreview() {
  const port = await freePort();
  const url = `http://localhost:${port}/`;
  const vite = [
    resolve(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    resolve(WEB_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
  ].find((c) => existsSync(c));
  const child = spawn(process.execPath, [vite, 'preview', '--port', String(port), '--strictPort'], { cwd: WEB_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) { if (await isUp(url)) return { child, url }; await sleep(300); }
  child.kill();
  throw new Error('vite preview did not answer');
}

async function click(page, pattern, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page.evaluate((src, flg) => {
      const re = new RegExp(src, flg);
      const hit = [...document.querySelectorAll('button')].find((b) => re.test(b.textContent?.trim() ?? '') && !b.disabled);
      if (!hit) return false;
      hit.click();
      return true;
    }, pattern.source, pattern.flags);
    if (ok) return true;
    await sleep(200);
  }
  throw new Error(`no enabled button matching ${pattern}`);
}

async function setField(page, ariaLabel, value) {
  await page.evaluate((label, v) => {
    const el = document.querySelector(`[aria-label="${label}"]`);
    if (!el) throw new Error('no field ' + label);
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  }, ariaLabel, value);
}

async function shot(page, name) {
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(OUT_DIR, name) });
  console.log('  shot', name);
}

async function openSeat(browser, appUrl, serverUrl, name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(VIEWPORT);
  page.on('pageerror', (e) => console.log(`  [${name}] pageerror:`, String(e).slice(0, 160)));
  await page.goto(`${appUrl}?server=${encodeURIComponent(serverUrl)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button.nav-link', { timeout: APP_SHELL_WAIT_MS });
  await click(page, /^Play$/);
  await click(page, /Online|Play a friend|Multiplayer/);
  await page.waitForSelector('[aria-label="Your name"]', { timeout: 20_000 });
  await setField(page, 'Your name', name);
  return page;
}

async function readyUp(page) {
  await page.waitForSelector('[aria-label="Your deck"]', { timeout: 20_000 });
  await click(page, /^Choose this deck$/);
  await sleep(300);
  await click(page, /^Ready up$/);
}

const server = await startServer();
const preview = await startPreview();
const browser = await puppeteer.launch(harnessLaunchOptions({ chromePath: findChrome(), windowSize: VIEWPORT }));

try {
  const host = await openSeat(browser, preview.url, server.url, 'Host');
  await click(host, /^Create room$/);
  // ⚠️ Read the code off the TITLE ELEMENT, not off `body.textContent`. The
  // body run-on swallowed the neighbouring Share button and produced
  // "99JUTShare", which the server rightly refused — a harness bug that looked
  // exactly like a join bug.
  await host.waitForFunction(
    () => /Lobby — Room\s+\S/.test(document.querySelector('.play-setup__title')?.textContent ?? ''),
    { timeout: 20_000 },
  );
  const code = await host.evaluate(
    () =>
      (/Lobby — Room\s+(\S+)/.exec(document.querySelector('.play-setup__title')?.textContent ?? '') ??
        [])[1] ?? '',
  );
  console.log('  room code:', code);
  if (!code) throw new Error('no room code on screen');

  const guest = await openSeat(browser, preview.url, server.url, 'Guest');
  await setField(guest, 'Room code', code);
  await click(guest, /^Join room$|^Join$/);
  await guest.waitForFunction(() => /Lobby — Room/.test(document.body.textContent ?? ''), { timeout: 20_000 });
  console.log('  guest joined');

  await readyUp(host);
  await readyUp(guest);

  // ⚠️ THE MULLIGAN SCREEN SITS BETWEEN READY AND THE BOARD, and both seats must
  // answer it or neither ever reaches `.play-board`. The rig used to wait 40s for
  // a board that could not appear and reported a timeout, which reads exactly
  // like a broken board. `Keep (N cards)` at zero mulligans commits immediately
  // (MulliganScreen's `beginKeep` → `onKeep([])` when nothing must be bottomed).
  for (const [who, page] of [['host', host], ['guest', guest]]) {
    await click(page, /^Keep \(/, 40_000);
    console.log(`  ${who} kept its opening hand`);
  }

  await host.waitForSelector('.play-board', { timeout: 40_000 });
  await guest.waitForSelector('.play-board', { timeout: 40_000 });
  console.log('  GAME STARTED — both seats on a board');

  await shot(host, '01-online-board-host.png');

  // What the scene extraction is supposed to have given this board.
  const scene = await host.evaluate(() => ({
    boardScene: document.querySelectorAll('.board-scene').length,
    table: document.querySelectorAll('.board-scene__table').length,
    midline: document.querySelectorAll('.board-midline').length,
    tiltVar: getComputedStyle(document.querySelector('.play-board') ?? document.body).getPropertyValue('--board-tilt-deg').trim(),
    seats: document.querySelectorAll('.seat').length,
    stack: document.querySelectorAll('.stack-panel').length,
  }));
  console.log('  SCENE ' + JSON.stringify(scene));

  // Play both seats forward, screenshotting the first real combat.
  let shotCombat = false;
  for (let i = 0; i < 4000 && !shotCombat; i++) {
    for (const [who, page] of [['host', host], ['guest', guest]]) {
      const st = await page.evaluate(() => ({
        attacking: document.querySelectorAll('.perm--attacking').length,
        staged: document.querySelectorAll('.combat-stage__tile').length,
        arcs: document.querySelectorAll('svg.combat-arcs path, .combat-arcs path').length,
        ended: !!document.querySelector('.end-screen'),
      }));
      if (st.ended) { console.log('  game ended'); shotCombat = true; break; }
      if (st.attacking > 0) {
        await shot(page, `02-online-combat-${who}.png`);
        console.log(`  ONLINE COMBAT (${who}) | attacking=${st.attacking} staged=${st.staged} arcs=${st.arcs}`);
        // The advance is what UX-12/UX-13 are FOR, and it only exists while the
        // stage holds it — so sample both seats for a few seconds and keep the
        // best frame rather than photographing whatever the next tick shows.
        let best = { staged: -1, who: '', arcs: 0, mid: 0 };
        for (let s = 0; s < 40; s++) {
          for (const [w, p] of [['host', host], ['guest', guest]]) {
            const live = await p.evaluate(() => ({
              staged: document.querySelectorAll('.combat-stage__tile').length,
              arcs: document.querySelectorAll('.combat-arcs path').length,
              mid: document.querySelectorAll('.board-midline').length,
            }));
            if (live.staged > best.staged) {
              best = { ...live, who: w };
              if (live.staged > 0) await shot(p, `03-online-advance-${w}.png`);
            }
          }
          await sleep(120);
        }
        console.log(`  ONLINE ADVANCE best: staged=${best.staged} arcs=${best.arcs} midline=${best.mid} on ${best.who}`);
        shotCombat = true;
        break;
      }
      await page.evaluate(() => {
        // ⚠️ ANSWER ANY PARKED QUESTION FIRST. A target prompt left open stops the
        // game dead, and the rig then spins until its budget runs out and reports
        // "no combat" — a harness stall that reads exactly like a board that
        // cannot reach combat. Pick the first real option, never Cancel.
        const prompt = document.querySelector('.target-prompt, .choice-prompt, .ability-prompt');
        if (prompt) {
          const pick = [...prompt.querySelectorAll('button')].find(
            (b) => !b.disabled && !/^(Cancel|Back)$/.test(b.textContent?.trim() ?? ''),
          );
          if (pick) { pick.click(); return; }
        }

        const hand = [...document.querySelectorAll('.play-hand')].find((h) => !h.className.includes('hidden'));
        const playable = hand ? [...hand.querySelectorAll('button.play-card--actionable')] : [];
        if (playable.length) {
          // Lands, then CREATURES, then anything. The old order preferred any
          // non-land, which meant burn spells — a hand emptied into the
          // opponent's face never produces an attacker to photograph.
          const isLand = (b) => /Basic Land/.test(b.textContent ?? '');
          const isCreature = (b) => /Creature\s+—/.test(b.textContent ?? '');
          const land = playable.find(isLand);
          if (land) { land.click(); return; }
          (playable.find(isCreature) ?? playable[0]).click();
          return;
        }
        const atk = [...document.querySelectorAll('button.perm')].find(
          (p) => !p.disabled && !p.className.includes('perm--tapped') && p.getAttribute('aria-pressed') === 'false',
        );
        const declare = [...document.querySelectorAll('button')].find((b) => /^Attack with|^Confirm|^Declare/.test(b.textContent ?? '') && !b.disabled);
        if (atk) { atk.click(); return; }
        if (declare) { declare.click(); return; }
        const next = [...document.querySelectorAll('button')].find((b) => /Pass \/ advance|Pass priority|No blocks|Let it resolve|Resolve/.test(b.textContent ?? '') && !b.disabled);
        if (next) next.click();
      });
    }
    await sleep(70);
  }
  await shot(host, '99-online-final-host.png');
  await shot(guest, '99-online-final-guest.png');
} finally {
  await browser.close();
  preview.child.kill();
  server.child.kill();
}
