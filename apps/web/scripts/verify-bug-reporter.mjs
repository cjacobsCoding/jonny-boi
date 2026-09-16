#!/usr/bin/env node
/**
 * Drive the in-app bug reporter in a REAL browser and check what it produces.
 *
 * WHY THIS SCRIPT EXISTS. The reporter's screenshot is the one part of it that no
 * unit test can reach: it is a third-party DOM rasteriser drawing real pixels.
 * Worse, it cannot be checked in the tooling normally used to look at this app —
 * in a backgrounded tab `html-to-image` never resolves at all, not even for a
 * single header element. So "the screenshot works" was an unverified claim, and
 * an unverified claim about a debugging tool is exactly the kind of thing that is
 * discovered to be false at the worst moment. This turns it into a command.
 *
 * It launches the Chrome already installed on the machine (via puppeteer-core —
 * no browser download), serves the app, drives the reporter the way a person
 * does, and then ASSERTS on the artifacts: the frame is a real PNG the size of
 * the viewport, it is not a blank rectangle, the annotation lands where it was
 * drawn, and the submitted zip contains what report.md says it does. It also
 * writes the PNGs to disk so a human can look at them, because "the bytes decode"
 * is not the same as "the picture is right".
 *
 * Usage:
 *   node apps/web/scripts/verify-bug-reporter.mjs [--headful] [--url <url>]
 * With no --url it starts `vite preview` against the built app, so what is
 * verified is the SHIPPING bundle, not the dev server.
 *
 * Exit codes: 0 every check passed, 1 a check failed, 2 the harness could not
 * run at all (no Chrome, no build). 1 and 2 are different on purpose — "the
 * reporter is broken" and "I could not check" must never look the same.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { describeChromeSearch, findChrome } from './lib/find-chrome.mjs';
import { harnessLaunchOptions } from './lib/harness-chrome.mjs';
import { watchPageErrors } from './lib/harness-page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(WEB_ROOT, 'verify-out');

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_CANNOT_RUN = 2;

const VIEWPORT = { width: 1280, height: 800 };
/** The reporter's own budget is 12 s; allow for a cold start on top of it. */
const CAPTURE_WAIT_MS = 30_000;
/** Vite preview is slow to boot on a cold cache; this is a ceiling, not a wait. */
const PREVIEW_START_MS = 90_000;
/** Below this a "PNG" is a header and a blank rectangle, not a screenshot. */
const MIN_FRAME_BYTES = 20_000;

/**
 * How long the Cards view may take to mount the reporter's launcher. The view
 * renders EVERY card in the pool — thousands of tiles now, not the ~190 this
 * harness was written against — and a CI runner is slower than a dev box; a
 * 10 s wait started failing the harness before it had asserted anything.
 */
const LAUNCHER_WAIT_MS = 90_000;

/** rrweb event types the clip checks read (rrweb's EventType enum). */
const RRWEB_INCREMENTAL = 3;
/** A stream with fewer mutations than this replays as a frozen frame. */
const MIN_INCREMENTAL_EVENTS = 3;

const args = process.argv.slice(2);
const headful = args.includes('--headful');
const urlArg = args.indexOf('--url') >= 0 ? args[args.indexOf('--url') + 1] : null;
// Which view to file the report from. Cards is the DEFAULT because it is the
// worst case in the whole app — every pool card as a tile, thousands of nodes — and a
// harness that only ever measures the easy view is a harness that will not
// notice the reporter becoming unusable.
const viewArg = args.indexOf('--view') >= 0 ? args[args.indexOf('--view') + 1] : null;
// --fidelity additionally proves the below-fold pruning changes no visible pixel.
// Needs a DEV server (--url), because it imports the capture module by source path.
const fidelity = args.includes('--fidelity');

/** A newline, kept as a value so no source-mangling tool can break the string. */
const chr10 = String.fromCharCode(10);

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

/** True once the server answers. */
async function isUp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.status > 0;
  } catch {
    return false;
  }
}

/**
 * Start `vite preview` and resolve with its URL once it is actually answering.
 *
 * POLLED, NOT PARSED. This used to read the URL out of vite's banner, which is
 * not printed when stdout is not a TTY — so the harness reported "did not start
 * in time", with an empty transcript, about a server that had started perfectly
 * well and was serving on the port it was told to. Choosing the port here and
 * polling it removes both the banner dependency and the race that made
 * `--strictPort` unusable.
 */
function startPreview() {
  return (async () => {
    if (!existsSync(resolve(WEB_ROOT, 'dist', 'index.html'))) {
      throw new Error('apps/web/dist is missing — run `npm run build` first');
    }
    const port = await freePort();
    const url = `http://localhost:${port}/`;
    // vite's own bin, run directly. Going through `npx` added seconds of
    // resolution to every run and gave the harness a shell + npx + node process
    // tree to clean up instead of one child.
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
    throw new Error(`vite preview never answered on ${url}. Its output was:${chr10}${output}`);
  })();
}

/**
 * Kill the preview AND its children. `npx vite preview` is npx spawning vite, so
 * killing the handle leaves the actual server holding the port — which is how a
 * previous run's server ends up failing the next one.
 */
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

function dataUrlToBuffer(dataUrl) {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
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

  const browser = await puppeteer.launch(
    harnessLaunchOptions({ chromePath, headful, viewport: VIEWPORT }),
  );

  let extractedReplay = null;
  try {
    const page = await browser.newPage();
    const pageErrors = watchPageErrors(page).errors;
    // `domcontentloaded`, NOT `networkidle2`. The app holds connections open (a
    // sim worker, the service worker), so "the network went quiet" never happens
    // and the harness timed out after 90 s on an app that had loaded in two.
    // Readiness is the app's own launcher appearing, which is waited on below.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PREVIEW_START_MS });

    // The Cards view is the WORST CASE on purpose: thousands of card tiles, most of them
    // off screen. It is the view that made an earlier build of this capture run
    // past 30 seconds, so it is the one worth checking.
    await page.waitForSelector('.bugreport-launcher', { timeout: LAUNCHER_WAIT_MS });
    if (viewArg !== null) {
      await page.evaluate((label) => {
        const nav = [...document.querySelectorAll('.nav-link')].find(
          (b) => b.textContent.trim().toLowerCase() === label.toLowerCase(),
        );
        if (!nav) throw new Error('no nav button labelled ' + label);
        nav.click();
      }, viewArg);
      await new Promise((r) => setTimeout(r, 1500));
      // THE LAB'S WORST TAB, not its landing one (§3.119, bug report
      // 20260902_231525). The Lab is a light page — about a hundred elements —
      // until the A/B Swap tab mounts its two card pickers, which put one
      // <option> per pool card in the DOM: the reported frame carried 5,140 of
      // them. Measuring the Gauntlet tab and declaring the Lab cheap is exactly
      // how this shipped, so the harness opens the tab the report came from.
      if (viewArg.toLowerCase() === 'lab') {
        const opened = await page.evaluate(() => {
          const tab = [...document.querySelectorAll('.lab-tab')].find((b) =>
            b.textContent.toLowerCase().includes('swap'),
          );
          if (!tab) return false;
          tab.click();
          return true;
        });
        check('the Lab’s A/B Swap tab (its card pickers) opened', opened);
        await new Promise((r) => setTimeout(r, 1500));
        const options = await page.evaluate(() => document.querySelectorAll('option').length);
        console.log('Lab A/B Swap tab: ' + options + ' <option> elements in the DOM.');
        check('the pickers really are mounted, so this is the worst case', options > 1000,
          options + ' options');
      }
    }
    // Give the visible card art a moment to decode; without the network-idle
    // wait this is the thing that would otherwise be captured half-drawn.
    await new Promise((r) => setTimeout(r, 2500));
    const dom = await page.evaluate(() => ({
      images: document.querySelectorAll('img').length,
      nodes: document.querySelectorAll('*').length,
    }));
    console.log(
      'View: ' + (viewArg ?? 'Cards (the worst case)') + ' - ' + dom.nodes +
        ' DOM nodes, ' + dom.images + ' images.',
    );

    // Give the rolling clip something to have recorded. The whole point of it is
    // the seconds BEFORE the key is pressed, so the harness has to generate some.
    console.log(chr10 + 'Interacting, so the clip has something in it...');
    await page.evaluate(() => window.scrollBy(0, 400));
    await new Promise((r) => setTimeout(r, 500));
    await page.evaluate(() => window.scrollBy(0, -200));
    await new Promise((r) => setTimeout(r, 500));

    console.log('\nOpening the reporter…');
    const startedAt = Date.now();
    await page.click('.bugreport-launcher');
    await page.waitForSelector('.bugreport__ink', { timeout: CAPTURE_WAIT_MS });
    const captureMs = Date.now() - startedAt;

    const shot = await page.evaluate(() => {
      const img = document.querySelector('img.bugreport__frame');
      const canvas = document.querySelector('.bugreport__ink');
      const canvasRect = canvas.getBoundingClientRect();
      return {
        dataUrl: img?.src ?? '',
        naturalWidth: img?.naturalWidth ?? 0,
        naturalHeight: img?.naturalHeight ?? 0,
        canvasBitmap: [canvas.width, canvas.height],
        scaleX: canvas.width / canvasRect.width,
        scaleY: canvas.height / canvasRect.height,
        status: document.querySelector('.bugreport__status')?.textContent ?? '',
      };
    });

    console.log(`\nCapture took ${captureMs} ms.`);
    check('the capture produced an image at all', shot.dataUrl.startsWith('data:image/png'),
      shot.status || 'no status');
    check('it is a decodable PNG the browser actually rendered',
      shot.naturalWidth > 0 && shot.naturalHeight > 0,
      `${shot.naturalWidth}x${shot.naturalHeight}`);
    check('it is the size of the VIEWPORT, not the scrollable page',
      shot.naturalWidth === VIEWPORT.width && shot.naturalHeight === VIEWPORT.height,
      `expected ${VIEWPORT.width}x${VIEWPORT.height}`);
    check('the ink canvas matches the frame, so strokes map 1:1',
      Math.abs(shot.scaleX - shot.scaleY) < 0.01,
      `scaleX ${shot.scaleX.toFixed(3)} vs scaleY ${shot.scaleY.toFixed(3)}`);
    check('the capture finished inside the reporter\'s own budget',
      captureMs < CAPTURE_WAIT_MS, `${captureMs} ms`);

    let frameBuffer = Buffer.alloc(0);
    if (shot.dataUrl.startsWith('data:image/png')) {
      frameBuffer = dataUrlToBuffer(shot.dataUrl);
      writeFileSync(resolve(OUT_DIR, 'frame.png'), frameBuffer);
      check('the picture has real content, not a blank rectangle',
        frameBuffer.length > MIN_FRAME_BYTES, `${Math.round(frameBuffer.length / 1024)} KB`);
    }

    // Does the frozen frame actually show the APP? Sample the pixels and count
    // distinct colours: a blank or single-colour fill is the failure mode that a
    // byte-size check alone would sail past.
    const pixels = await page.evaluate(async () => {
      const img = document.querySelector('img.bugreport__frame');
      if (!img) return null;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const seen = new Set();
      for (let i = 0; i < data.length; i += 4 * 97) {
        seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      }
      return { distinctColours: seen.size };
    });
    if (pixels !== null) {
      check('the frame shows the app, not a flat fill',
        pixels.distinctColours > 20, `${pixels.distinctColours} distinct colours sampled`);
    }

    // Draw, and confirm the ink lands where the pointer went.
    console.log('\nDrawing on the frozen frame…');
    const box = await page.$eval('.bugreport__ink', (canvas) => {
      const r = canvas.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const from = { x: box.x + box.width * 0.25, y: box.y + box.height * 0.3 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i += 1) {
      await page.mouse.move(from.x + i * 18, from.y + (i % 2 === 0 ? 24 : -24));
    }
    await page.mouse.up();

    const ink = await page.evaluate(() => {
      const canvas = document.querySelector('.bugreport__ink');
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      let minX = canvas.width;
      let maxX = 0;
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          if (data[(y * canvas.width + x) * 4 + 3] > 0) {
            painted += 1;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }
      }
      const undo = [...document.querySelectorAll('.bugreport__btn')]
        .map((b) => b.textContent)
        .find((t) => t.startsWith('Undo'));
      return { painted, minX, maxX, undo };
    });
    check('the stroke was recorded', ink.undo === 'Undo (1)', ink.undo);
    check('the stroke actually painted pixels', ink.painted > 500, `${ink.painted} px`);
    // The drag started a quarter of the way across and ran ~180 px right, so the
    // ink must sit in that band of the BITMAP — this is the check that catches a
    // scaled or offset mapping, which is what a wrong stage layout produces.
    const expectedMinX = (from.x - box.x) * shot.scaleX;
    check('the ink landed where the pointer went, not scaled or offset',
      Math.abs(ink.minX - expectedMinX) < 25,
      `ink starts at x=${ink.minX}, pointer mapped to x=${Math.round(expectedMinX)}`);

    // The clip control, driven the way a thumb drives it: real clicks, with the
    // render between them. Clicking in a tight loop inside one page.evaluate
    // reads the label before React has re-rendered, which made an earlier
    // version of this check report a stall that was not there.
    const clipLabel = async () =>
      page.$eval('.bugreport__clip', (el) => el.textContent.trim());
    const clipStepper = async (which) => {
      const buttons = await page.$$('.bugreport__btn--step');
      return which === 'less' ? buttons[0] : buttons[1];
    };
    const defaultClip = await clipLabel();
    check('the clip is on by default, so a report carries one without being asked',
      /clip: last \d+ s/.test(defaultClip), defaultClip);

    for (let i = 0; i < 8; i += 1) {
      const less = await clipStepper('less');
      if (await less.evaluate((el) => el.disabled)) break;
      await less.click();
    }
    const zeroed = await clipLabel();
    check('the clip dials all the way down to nothing, as the games do',
      zeroed === 'no clip', zeroed);

    for (let i = 0; i < 8; i += 1) {
      const more = await clipStepper('more');
      if (await more.evaluate((el) => el.disabled)) break;
      await more.click();
    }
    const restored = await clipLabel();
    check('and dials back up, so a change of mind is not a lost clip',
      /clip: last \d+ s/.test(restored), restored);

    await page.type('#bugreport-note', 'VERIFY: filed by verify-bug-reporter.mjs');

    // Submit, then read the zip back out of its own central directory.
    console.log('\nSubmitting…');
    const submitted = await page.evaluate(async () => {
      const button = [...document.querySelectorAll('.bugreport__btn')].find((b) =>
        b.textContent.includes('SUBMIT'),
      );
      button.click();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const link = document.querySelector('.bugreport-lastlink');
        if (link) {
          const bytes = new Uint8Array(await (await fetch(link.href)).arrayBuffer());
          return {
            name: link.getAttribute('download'),
            base64: btoa(String.fromCharCode(...bytes.subarray(0, 0))) || '',
            length: bytes.length,
            entries: (() => {
              const dv = new DataView(bytes.buffer);
              const eocd = bytes.length - 22;
              const count = dv.getUint16(eocd + 10, true);
              let at = dv.getUint32(eocd + 16, true);
              const out = [];
              for (let i = 0; i < count; i += 1) {
                const nameLen = dv.getUint16(at + 28, true);
                out.push({
                  name: new TextDecoder().decode(bytes.slice(at + 46, at + 46 + nameLen)),
                  compressedSize: dv.getUint32(at + 20, true),
                  size: dv.getUint32(at + 24, true),
                });
                at += 46 + nameLen + dv.getUint16(at + 30, true) + dv.getUint16(at + 32, true);
              }
              return out;
            })(),
            // Pull the entries the checks below need straight out of the
            // bundle, INFLATING the ones that were deflated. Reading them back
            // through the archive's own headers rather than from the app's state
            // is the point: what is verified is the artifact a person receives,
            // and it now proves the compressed entries decompress.
            extracted: await (async () => {
              const wanted = ['annotated.png', 'replay.html', 'clip.json'];
              const dv = new DataView(bytes.buffer);
              const out = {};
              let at = 0;
              while (at < bytes.length - 4 && dv.getUint32(at, true) === 0x04034b50) {
                const method = dv.getUint16(at + 8, true);
                const nameLen = dv.getUint16(at + 26, true);
                const extraLen = dv.getUint16(at + 28, true);
                const size = dv.getUint32(at + 18, true);
                const entryName = new TextDecoder().decode(bytes.slice(at + 30, at + 30 + nameLen));
                const dataAt = at + 30 + nameLen + extraLen;
                if (wanted.includes(entryName)) {
                  let slice = bytes.slice(dataAt, dataAt + size);
                  if (method === 8) {
                    const ds = new DecompressionStream('deflate-raw');
                    const writer = ds.writable.getWriter();
                    void writer.write(slice);
                    void writer.close();
                    slice = new Uint8Array(await new Response(ds.readable).arrayBuffer());
                  }
                  let binary = '';
                  const CHUNK = 8192; // String.fromCharCode blows the stack on a big spread
                  for (let i = 0; i < slice.length; i += CHUNK) {
                    binary += String.fromCharCode(...slice.subarray(i, i + CHUNK));
                  }
                  out[entryName] = btoa(binary);
                }
                at = dataAt + size;
              }
              return out;
            })(),
          };
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    });

    check('a bundle was produced', submitted !== null && submitted.length > 0,
      submitted ? `${submitted.name}, ${Math.round(submitted.length / 1024)} KB` : 'none');
    if (submitted !== null) {
      const names = submitted.entries.map((e) => e.name);
      // Per-entry sizes, because "the bundle is 15 MB" is not actionable and
      // "clip.json is 7 MB of it" is.
      console.log(
        '  bundle: ' +
          submitted.entries
            .map(
              (e) =>
                `${e.name} ${Math.round(e.size / 1024)} KB` +
                (e.compressedSize < e.size
                  ? ` -> ${Math.round(e.compressedSize / 1024)} KB`
                  : ''),
            )
            .join(', '),
      );
      const rawTotal = submitted.entries.reduce((n, e) => n + e.size, 0);
      check('the bundle is small enough for a phone to upload',
        submitted.length < 8 * 1024 * 1024,
        `${Math.round(submitted.length / 1024)} KB from ${Math.round(rawTotal / 1024)} KB of content`);
      for (const required of [
        'screenshot.png',
        'annotated.png',
        'state_dump.txt',
        'console.txt',
        'clip.json',
        'replay.html',
        'report.md',
      ]) {
        check(`the bundle contains ${required}`, names.includes(required), names.join(', '));
      }
      const screenshotEntry = submitted.entries.find((e) => e.name === 'screenshot.png');
      check('the bundled screenshot is the real picture, not an empty file',
        (screenshotEntry?.size ?? 0) > MIN_FRAME_BYTES,
        `${Math.round((screenshotEntry?.size ?? 0) / 1024)} KB`);
      const extracted = submitted.extracted ?? {};
      if (extracted['replay.html']) {
        extractedReplay = Buffer.from(extracted['replay.html'], 'base64').toString('utf8');
      }
      if (extracted['clip.json']) {
        const clip = JSON.parse(Buffer.from(extracted['clip.json'], 'base64').toString('utf8'));
        // "A real stream" is a STRUCTURAL claim, not a count: rrweb replays from
        // a full snapshot (type 2) plus the incremental mutations (type 3) that
        // follow it. The old `> 10` was a bare number the ring happened to land
        // on exactly (10) once the capture window and the harness's short
        // interaction shrank the clip — a guard that fails on arithmetic rather
        // than on a broken recording.
        const incremental = Array.isArray(clip) ? clip.filter((e) => e && e.type === RRWEB_INCREMENTAL).length : 0;
        check('the clip carries a real event stream (a snapshot followed by mutations)',
          Array.isArray(clip) && incremental >= MIN_INCREMENTAL_EVENTS,
          `${Array.isArray(clip) ? clip.length : 0} events, ${incremental} incremental`);
        // Type 2 is rrweb's full snapshot. Without one the replay has nothing to
        // start from, which is the failure the chunked ring exists to prevent.
        const snapshots = Array.isArray(clip) ? clip.filter((e) => e && e.type === 2).length : 0;
        check('the clip begins at a full DOM snapshot, so it can replay at all',
          snapshots > 0, `${snapshots} full-snapshot event(s)`);
      }
      if (extracted['annotated.png']) {
        writeFileSync(resolve(OUT_DIR, 'annotated.png'), Buffer.from(extracted['annotated.png'], 'base64'));
      }
    }

    // THE PRUNING CHECK. The capture drops the trailing run of children that
    // renders below the fold, which is what took a heavy view from 11 s to 1.4 s.
    // The claim that this cannot change a visible pixel is a claim about LAYOUT,
    // and layout changes as the app changes — so it is re-measured here rather
    // than argued. Off by default because it doubles the runtime.
    if (fidelity) {
      console.log(chr10 + 'Comparing a pruned capture against an unpruned one…');
      await page.evaluate(() => {
        const cancel = [...document.querySelectorAll('.bugreport__btn')].find((b) =>
          b.textContent.includes('Cancel'),
        );
        if (cancel) cancel.click();
      });
      const compared = await page.evaluate(async () => {
        const mod = await import('/src/lib/bugreport/capture.ts');
        const t0 = performance.now();
        const pruned = await mod.captureViewport(true);
        const prunedMs = Math.round(performance.now() - t0);
        const t1 = performance.now();
        const whole = await mod.captureViewport(false);
        const wholeMs = Math.round(performance.now() - t1);
        const decode = async (url) => {
          const img = new Image();
          await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = rej;
            img.src = url;
          });
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        if (!pruned.dataUrl || !whole.dataUrl) return { error: pruned.note || whole.note };
        const a = await decode(pruned.dataUrl);
        const b = await decode(whole.dataUrl);
        let differing = 0;
        let maxDelta = 0;
        // WHERE they differ matters more than how many: a scatter across the
        // frame means the pruning moved something, while a band at one edge is
        // an anti-aliasing seam. Reporting only a count would hide the
        // difference between those two.
        const box = { minX: Infinity, minY: Infinity, maxX: -1, maxY: -1 };
        const width = pruned.width;
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(
            Math.abs(a[i] - b[i]),
            Math.abs(a[i + 1] - b[i + 1]),
            Math.abs(a[i + 2] - b[i + 2]),
          );
          if (d > 2) {
            differing += 1;
            const p = i / 4;
            const x = p % width;
            const y = Math.floor(p / width);
            if (x < box.minX) box.minX = x;
            if (x > box.maxX) box.maxX = x;
            if (y < box.minY) box.minY = y;
            if (y > box.maxY) box.maxY = y;
          }
          if (d > maxDelta) maxDelta = d;
        }
        return {
          prunedMs,
          wholeMs,
          pixels: a.length / 4,
          differing,
          percent: +((100 * differing) / (a.length / 4)).toFixed(3),
          maxDelta,
          box,
          height: pruned.height,
        };
      });
      if (compared.error) {
        check('the pruned and unpruned captures could both be taken', false, compared.error);
      } else {
        console.log(
          `  pruned ${compared.prunedMs} ms vs unpruned ${compared.wholeMs} ms ` +
            `(${(compared.wholeMs / Math.max(1, compared.prunedMs)).toFixed(1)}x)`,
        );
        const box = compared.box;
        const spread = compared.differing === 0
          ? 'none'
          : `x ${box.minX}-${box.maxX}, y ${box.minY}-${box.maxY} of ${compared.height}`;
        check('pruning the below-fold tail changes no visible pixel',
          compared.percent < 0.05,
          `${compared.differing}/${compared.pixels} px differ (${compared.percent}%), max delta ${compared.maxDelta}, at ${spread}`);
        // HOW MUCH a pixel differs separates the two failure modes, and WHERE
        // does not — that was a wrong guess, corrected by measurement. When
        // pruning genuinely lost content (it emptied a <select>, because
        // <option> elements have no box and were being dropped) the delta was
        // 207. Anti-aliasing between two renders of the same picture measures 7.
        // A structural loss cannot hide under this bound; a sub-pixel seam
        // cannot trip it.
        check('nothing STRUCTURAL changed — no pixel shifted more than a hair',
          compared.maxDelta <= 32,
          `max delta ${compared.maxDelta} (a lost <select> label measured 207; anti-aliasing measures ~7)`);
        // Only meaningful where there is something to prune. On a short view
        // (the Lab is 107 nodes, all of it on screen) pruning is correctly a
        // no-op and the two timings are indistinguishable noise — asserting a
        // speed-up there would be asserting that noise has a sign.
        const HEAVY_ENOUGH_MS = 2000;
        if (compared.wholeMs >= HEAVY_ENOUGH_MS) {
          check('on a heavy view, pruning is actually faster',
            compared.wholeMs > compared.prunedMs * 2,
            `${compared.wholeMs} ms -> ${compared.prunedMs} ms`);
        } else {
          console.log(
            `  n/a   nothing below the fold to prune here (unpruned ${compared.wholeMs} ms) — ` +
              'the speed check needs a heavy view',
          );
        }
      }
    }

    // THE CLIP, PROVEN BY PLAYING IT. Everything above only shows that a file
    // called replay.html is in the bundle. A replay that opens to a blank
    // rectangle would pass every one of those checks — and a blank rectangle is
    // exactly what a clip sliced off its snapshot produces. So the page is
    // opened, from disk, with no network, and asked what it rendered.
    if (extractedReplay !== null) {
      const replayPath = resolve(OUT_DIR, 'replay.html');
      writeFileSync(replayPath, extractedReplay);
      console.log(chr10 + 'Opening the replay the way a person would...');
      const replayPage = await browser.newPage();
      const replayErrors = watchPageErrors(replayPage, { label: 'replay' }).errors;
      await replayPage.goto(pathToFileURL(replayPath).href, { waitUntil: 'load' });
      // The player builds its iframe asynchronously once it has parsed events.
      await new Promise((r) => setTimeout(r, 2500));
      const played = await replayPage.evaluate(() => {
        const fallback = document.getElementById('fallback');
        const iframe = document.querySelector('iframe');
        let nodes = 0;
        let text = '';
        try {
          const doc = iframe?.contentDocument;
          nodes = doc ? doc.querySelectorAll('*').length : 0;
          text = doc?.body?.innerText?.slice(0, 200) ?? '';
        } catch {
          nodes = -1;
        }
        return {
          fallbackShown: fallback !== null && !fallback.hidden,
          fallbackText: fallback?.textContent ?? '',
          hasIframe: iframe !== null,
          nodes,
          text,
          hasController: document.querySelector('.rr-controller, .rr-progress') !== null,
        };
      });
      await replayPage.close();

      check('the replay page reports no failure of its own', !played.fallbackShown,
        played.fallbackText);
      check('the replay built a player with a scrubber', played.hasController);
      check('the replay actually RECONSTRUCTED the page, not a blank frame',
        played.nodes > 50, `${played.nodes} nodes inside the replay iframe`);
      check('the replayed page is this app, not an empty document',
        /jonny-boi|Cards|Deck/i.test(played.text), JSON.stringify(played.text.slice(0, 60)));
      check('the replay threw no errors', replayErrors.length === 0, replayErrors.join(' | '));
    }

    check('the page threw no errors while all of that happened', pageErrors.length === 0,
      pageErrors.join(' | '));

    const failed = checks.filter((c) => !c.passed);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
    console.log(`Artifacts written to ${OUT_DIR} — LOOK at frame.png and annotated.png.`);
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
